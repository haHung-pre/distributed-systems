'use strict';
/**
 * API GATEWAY + STATIC WEB UI
 * ---------------------------
 * Single public entry point for browsers:
 *   • serves the web client (src/client/web),
 *   • reverse-proxies REST calls to the Directory Service (/api/*),
 *   • reverse-proxies the WebSocket upgrade to the collaboration replica the
 *     Directory selected for the requested document (/rt?replica=collab-2).
 *
 * The browser therefore never needs to reach a replica directly — important
 * because in the preview/cloud deployment only one port is published. The
 * gateway resolves replica ids through the Directory registry at upgrade
 * time, so a failover automatically lands on a live replica.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { URL } = require('url');

const { config } = require('../common/util/config');
const { createLogger } = require('../common/util/log');
const { send, requestJSON } = require('../common/util/http');

const NODE_ID = process.env.NODE_ID || 'gateway-1';
const log = createLogger(NODE_ID);
const WEB_DIR = path.join(__dirname, '../client/web');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: 'forbidden' });   // traversal guard
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(buf);
  });
}

/** Pipe an HTTP request to the Directory Service. */
function proxyToDirectory(req, res, pathname, search) {
  const target = new URL(config.directoryUrl);
  const headers = { ...req.headers, host: target.host };
  delete headers['content-length'];
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > config.maxBodyBytes) { req.destroy(); send(res, 413, { error: 'payload too large' }); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const up = http.request({
      hostname: target.hostname, port: target.port, method: req.method,
      path: pathname + search,
      headers: { ...headers, ...(body.length ? { 'content-length': body.length } : {}) },
    }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.setTimeout(8000, () => up.destroy(new Error('upstream timeout')));
    up.on('error', (e) => {
      log.error('directory_proxy_error', { err: e.message, path: pathname });
      if (!res.headersSent) send(res, 502, { error: 'directory service unavailable' });
    });
    if (body.length) up.write(body);
    up.end();
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/health') {
    return send(res, 200, { ok: true, node: NODE_ID, role: 'gateway' });
  }
  if (u.pathname.startsWith('/api/')) {
    return proxyToDirectory(req, res, u.pathname.replace(/^\/api/, ''), u.search);
  }
  if (u.pathname === '/cluster') {          // small dashboard feed
    return requestJSON(`${config.directoryUrl}/registry/replicas`, { timeout: 2000 })
      .then((r) => send(res, 200, r))
      .catch((e) => send(res, 502, { error: e.message }));
  }
  return serveStatic(req, res, u.pathname);
});

/**
 * WebSocket proxy. The browser connects to  ws://<gateway>/rt?replica=<id>
 * and we splice the TCP stream to the replica's /ws endpoint.
 */
server.on('upgrade', async (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/rt') { socket.destroy(); return; }
  const wanted = u.searchParams.get('replica');

  let target = null;
  try {
    const reg = await requestJSON(`${config.directoryUrl}/registry/replicas`, { timeout: 2500 });
    const list = reg.replicas || [];
    const chosen = list.find((r) => r.id === wanted) || list[0];
    if (chosen) target = new URL(chosen.wsUrl.replace(/^ws/, 'http'));
    if (chosen && chosen.id !== wanted) log.warn('ws_proxy_retarget', { wanted, chosen: chosen.id });
  } catch (e) {
    log.error('ws_proxy_registry_error', { err: e.message });
  }
  if (!target) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }

  const upstream = net.connect({ host: target.hostname, port: target.port }, () => {
    const headers = [
      `GET /ws HTTP/1.1`,
      `Host: ${target.host}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
      `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] || 13}`,
    ];
    if (req.headers['sec-websocket-protocol']) headers.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
    if (req.headers['sec-websocket-extensions']) headers.push(`Sec-WebSocket-Extensions: ${req.headers['sec-websocket-extensions']}`);
    upstream.write(headers.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    log.info('ws_proxy_open', { to: target.host, replica: wanted });
  });
  upstream.on('error', (e) => { log.warn('ws_proxy_upstream_error', { err: e.message }); socket.destroy(); });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});

server.listen(config.gatewayPort, '0.0.0.0', () =>
  log.info('listening', { port: config.gatewayPort, role: 'gateway', webDir: WEB_DIR }));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log.info('shutdown', { sig }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 300); });
}
