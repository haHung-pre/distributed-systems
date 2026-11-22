'use strict';
/**
 * Tiny HTTP helpers shared by the services: a micro router with JSON body
 * parsing + size limits, and a promise-based JSON client with bounded retry
 * and exponential backoff (§4.4 timeout / bounded retry).
 */
const http = require('http');
const { URL } = require('url');

const MAX_BODY = parseInt(process.env.MAX_BODY_BYTES || '1048576', 10);   // 1 MiB (§4.5)

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/** Extremely small path router: router.add('POST', '/x/:id', handler). */
function createRouter() {
  const routes = [];
  function add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[A-Za-z0-9_]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$');
    routes.push({ method, rx, keys, handler });
  }
  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = u.pathname.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        return await r.handler(req, res, { params, query: u.searchParams, url: u });
      } catch (err) {
        const status = err.status || 500;
        return send(res, status, { error: err.message || 'internal error' });
      }
    }
    send(res, 404, { error: 'not found' });
  }
  return { add, handle, routes };
}

/** JSON request with timeout. */
function requestJSON(url, { method = 'GET', body, headers = {}, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error((parsed && parsed.error) || `HTTP ${res.statusCode}`), { status: res.statusCode, body: parsed }));
        } else {
          resolve(parsed);
        }
      });
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Bounded retry with exponential backoff + jitter. */
async function withRetry(fn, { tries = 3, base = 120, factor = 2, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); }
    catch (err) {
      lastErr = err;
      if (err.status && err.status >= 400 && err.status < 500) throw err;   // don't retry client errors
      if (i === tries - 1) break;
      const delay = Math.round(base * Math.pow(factor, i) * (0.7 + Math.random() * 0.6));
      if (onRetry) onRetry(i + 1, delay, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { readBody, send, createRouter, requestJSON, withRetry, MAX_BODY };
