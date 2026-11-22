'use strict';
/**
 * COLLABORATION REPLICA  (real-time WebSocket node)
 * -------------------------------------------------
 * One of N interchangeable replicas. Each replica:
 *   • registers itself with the Directory Service and renews a lease
 *     (heartbeat). If it dies, its lease expires and the Directory stops
 *     handing it out => clients fail over to the next replica in the chain.
 *   • accepts client WebSocket sessions, authenticates the session token,
 *     enforces viewer/editor ACL, and relays CRDT operations.
 *   • gossips every operation to its peer replicas over an internal WebSocket
 *     mesh, so two clients on *different* replicas still converge.
 *   • persists operations to the Storage Service (write-behind + snapshots).
 *
 * Concurrency: a single Node process multiplexes many sockets on the event
 * loop; every document session is independent, and the CRDT guarantees that
 * interleaved application of concurrent ops converges.
 */
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const { config } = require('../common/util/config');
const { createLogger } = require('../common/util/log');
const { send, createRouter, requestJSON, withRetry } = require('../common/util/http');
const { MSG, validateOp } = require('./protocol');
const { DocumentSession } = require('./document');

const REPLICA_ID = process.env.REPLICA_ID || 'collab-1';
const PORT = parseInt(process.env.COLLAB_PORT || '7201', 10);
const ADVERTISE = process.env.COLLAB_WS_URL || `ws://127.0.0.1:${PORT}`;
const PUBLIC_WS = process.env.COLLAB_PUBLIC_WS_URL || ADVERTISE;
const log = createLogger(REPLICA_ID);

/** Chaos knobs used by the fault-injection scripts (§4.4 demonstrations). */
const chaos = {
  dropOutgoing: parseFloat(process.env.CHAOS_DROP_OUT || '0'),     // probability
  duplicate: parseFloat(process.env.CHAOS_DUPLICATE || '0'),
  delayMs: parseInt(process.env.CHAOS_DELAY_MS || '0', 10),
  reorder: process.env.CHAOS_REORDER === '1',
};

const docs = new Map();           // docId -> DocumentSession
const peers = new Map();          // replicaId -> { ws, url, up, lastPong }
let clientCount = 0;

// ---------------------------------------------------------------- helpers
function getDoc(docId) {
  if (!docs.has(docId)) {
    const d = new DocumentSession(docId, REPLICA_ID, log);
    d.sender = sendJSON;                    // fault injection applies to broadcasts
    docs.set(docId, d);
  }
  return docs.get(docId);
}

/**
 * Frames that carry document data. Fault injection is deliberately restricted
 * to this data plane: dropping control frames (welcome/ack/error) would break
 * the handshake itself, which models a *link* failure rather than the message
 * loss we want to exercise. Losing `ops` frames is the interesting case,
 * because recovery then depends on the CRDT + the client's re-sync path.
 */
const DATA_FRAMES = new Set([MSG.OPS, MSG.PRESENCE]);

/**
 * How long a positive ACL verdict may be cached on an open socket. Bounded so
 * that a revocation is enforced within this window even for a session that
 * never reconnects, while keeping the Directory off the per-keystroke path.
 */
const ACL_TTL_MS = parseInt(process.env.ACL_REVALIDATE_MS || '3000', 10);

/**
 * Re-derive the caller's rights from the Directory when the cached verdict is
 * older than ACL_TTL_MS. Returns {ok:false} when access was revoked entirely.
 * A Directory outage is fail-open for *existing* rights (availability) but is
 * logged; it can never upgrade a viewer into an editor.
 */
async function refreshAcl(conn) {
  if (Date.now() - conn.aclCheckedAt < ACL_TTL_MS) return { ok: true };
  try {
    const v = await requestJSON(`${config.directoryUrl}/internal/verify-session`, {
      method: 'POST', headers: { 'x-internal-key': config.internalKey },
      body: { sessionToken: conn.sessionToken }, timeout: 2500,
    });
    conn.aclCheckedAt = Date.now();
    const wasEdit = conn.canEdit;
    conn.canEdit = !!v.canEdit;
    conn.role = v.role || conn.role;
    if (wasEdit && !conn.canEdit) {
      log.warn('acl_downgraded_live_session', { docId: conn.docId, clientId: conn.clientId, role: conn.role });
      sendJSON(conn.ws, { t: MSG.ERROR, code: 403, message: 'your role changed to ' + conn.role });
    }
    return { ok: true };
  } catch (err) {
    // 403/404 from the Directory = access revoked or document deleted.
    if (err.status === 403 || err.status === 404 || err.status === 401) {
      return { ok: false, reason: err.message || 'access revoked' };
    }
    log.warn('acl_revalidate_failed_fail_open', { docId: conn.docId, clientId: conn.clientId, err: err.message });
    return { ok: true };
  }
}

function sendJSON(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const emit = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  if (chaos.dropOutgoing && DATA_FRAMES.has(obj.t) && Math.random() < chaos.dropOutgoing) {
    log.warn('chaos_drop_frame', { type: obj.t });
    return false;
  }
  if (chaos.delayMs) setTimeout(emit, Math.random() * chaos.delayMs);
  else emit();
  if (chaos.duplicate && Math.random() < chaos.duplicate) {
    log.warn('chaos_duplicate_frame', { type: obj.t });
    setTimeout(emit, 5);
  }
  return true;
}

// ------------------------------------------------- directory registration
let leaseTimer = null;
async function registerWithDirectory() {
  try {
    const res = await requestJSON(`${config.directoryUrl}/registry/replicas`, {
      method: 'POST',
      headers: { 'x-internal-key': config.internalKey },
      body: { replicaId: REPLICA_ID, wsUrl: ADVERTISE, publicWsUrl: PUBLIC_WS, load: clientCount },
      timeout: 2500,
    });
    for (const p of res.peers || []) connectToPeer(p.id, p.wsUrl);
    return true;
  } catch (err) {
    log.warn('directory_register_failed', { err: err.message });
    return false;
  }
}
function startLeaseHeartbeat() {
  registerWithDirectory();
  leaseTimer = setInterval(registerWithDirectory, config.heartbeatMs);
  leaseTimer.unref?.();
}

// ------------------------------------------------------ replica-to-replica
function connectToPeer(peerId, url) {
  if (peerId === REPLICA_ID) return;
  const existing = peers.get(peerId);
  if (existing && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) return;

  const ws = new WebSocket(`${url}/internal`, { handshakeTimeout: 3000 });
  const rec = { ws, url, up: false, lastPong: Date.now(), outbound: true };
  peers.set(peerId, rec);

  ws.on('open', () => {
    rec.up = true;
    ws.send(JSON.stringify({ t: MSG.R_HELLO, replicaId: REPLICA_ID, key: config.internalKey }));
    log.info('peer_connected', { peer: peerId, url });
  });
  ws.on('message', (buf) => handlePeerFrame(peerId, buf));
  ws.on('close', () => {
    rec.up = false;
    log.warn('peer_disconnected', { peer: peerId });
    for (const d of docs.values()) {
      if (d.remotePresence.delete(peerId)) {
        d.broadcast({ t: MSG.PRESENCE, docId: d.docId, users: d.presenceList() });
      }
    }
    setTimeout(() => {
      // Only reconnect if the directory still lists the peer as alive.
      requestJSON(`${config.directoryUrl}/registry/replicas`, { timeout: 2000 })
        .then((r) => {
          const still = (r.replicas || []).find((x) => x.id === peerId);
          if (still) connectToPeer(peerId, still.wsUrl);
          else peers.delete(peerId);
        })
        .catch(() => {});
    }, 1500);
  });
  ws.on('error', (e) => log.debug('peer_socket_error', { peer: peerId, err: e.message }));
}

function handlePeerFrame(peerId, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
  if (msg.t === MSG.R_OPS) {
    const session = getDoc(msg.docId);
    if (!session.loaded) {
      // Lazily load then apply, preserving order via a promise chain.
      session.load().then(() => ingestPeerOps(session, msg, peerId)).catch((e) =>
        log.error('peer_ops_load_failed', { docId: msg.docId, err: e.message }));
    } else {
      ingestPeerOps(session, msg, peerId);
    }
  } else if (msg.t === MSG.R_PRESENCE) {
    const session = docs.get(msg.docId);
    if (session) {
      session.setRemotePresence(msg.replicaId || peerId, Array.isArray(msg.users) ? msg.users : []);
      session.broadcast({ t: MSG.PRESENCE, docId: msg.docId, users: session.presenceList() });
    }
  } else if (msg.t === MSG.R_PING) {
    const p = peers.get(peerId);
    if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ t: MSG.R_PONG }));
  } else if (msg.t === MSG.R_PONG) {
    const p = peers.get(peerId);
    if (p) p.lastPong = Date.now();
  }
}

function ingestPeerOps(session, msg, peerId) {
  const ops = (msg.ops || []).filter((op) => !validateOp(op));
  if (!ops.length) return;
  const r = session.applyBatch(ops);
  log.info('ops_from_peer', { docId: msg.docId, peer: peerId, n: ops.length, applied: r.applied.length, dup: r.duplicates, corr: msg.corr });
  if (r.applied.length) {
    session.broadcast({ t: MSG.OPS, docId: session.docId, ops: r.applied, from: peerId });
  }
}

/** Tell every peer replica who is currently connected here (for that doc). */
function gossipPresence(session) {
  const frame = JSON.stringify({
    t: MSG.R_PRESENCE, docId: session.docId, replicaId: REPLICA_ID, users: session.localPresence(),
  });
  for (const p of peers.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(frame);
}

/** Forward locally accepted ops to every peer replica (single hop). */
function replicateToPeers(docId, ops, originClientId, corr) {
  if (!ops.length) return;
  const frame = JSON.stringify({ t: MSG.R_OPS, docId, ops, origin: REPLICA_ID, corr, hop: 1 });
  let sent = 0;
  for (const [pid, p] of peers) {
    if (p.ws.readyState === WebSocket.OPEN) { p.ws.send(frame); sent++; }
  }
  if (sent) log.debug('ops_replicated', { docId, n: ops.length, peers: sent, corr });
}

// --------------------------------------------------------------- HTTP side
const router = createRouter();
router.add('GET', '/health', (req, res) => send(res, 200, {
  ok: true, node: REPLICA_ID, clients: clientCount,
  docs: [...docs.values()].map((d) => d.info()),
  peers: [...peers.entries()].map(([id, p]) => ({ id, up: p.ws.readyState === WebSocket.OPEN })),
}));
router.add('GET', '/metrics', (req, res) => {
  const lines = [];
  lines.push(`coedit_clients{replica="${REPLICA_ID}"} ${clientCount}`);
  for (const d of docs.values()) {
    lines.push(`coedit_doc_chars{replica="${REPLICA_ID}",doc="${d.docId}"} ${d.doc.length}`);
    lines.push(`coedit_doc_ops{replica="${REPLICA_ID}",doc="${d.docId}"} ${d.doc.oplog.length}`);
    lines.push(`coedit_doc_pending{replica="${REPLICA_ID}",doc="${d.docId}"} ${d.doc.pendingCount()}`);
    lines.push(`coedit_doc_dlq{replica="${REPLICA_ID}",doc="${d.docId}"} ${d.deadLetter.length}`);
  }
  send(res, 200, lines.join('\n') + '\n');
});
/** Test/demo hook: read the authoritative text held by this replica. */
router.add('GET', '/internal/docs/:id/text', async (req, res, { params }) => {
  if (req.headers['x-internal-key'] !== config.internalKey) return send(res, 403, { error: 'forbidden' });
  const d = getDoc(params.id);
  if (!d.loaded) await d.load();
  send(res, 200, { docId: params.id, text: d.doc.text(), vv: d.doc.vv, info: d.info() });
});

const server = http.createServer((req, res) => router.handle(req, res));

// ---------------------------------------------------------- WebSocket side
const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxBodyBytes });
const wssInternal = new WebSocketServer({ noServer: true, maxPayload: 4 * config.maxBodyBytes });

server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/internal') {
    wssInternal.handleUpgrade(req, socket, head, (ws) => wssInternal.emit('connection', ws, req));
  } else if (path === '/ws' || path === '/') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

/* ---- inbound peer connections ---- */
wssInternal.on('connection', (ws) => {
  let peerId = null;
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!peerId) {
      if (msg.t !== MSG.R_HELLO || msg.key !== config.internalKey) { ws.close(4003, 'forbidden'); return; }
      peerId = msg.replicaId;
      if (!peers.has(peerId)) peers.set(peerId, { ws, url: null, up: true, lastPong: Date.now(), outbound: false });
      log.info('peer_inbound', { peer: peerId });
      return;
    }
    handlePeerFrame(peerId, buf);
  });
  ws.on('close', () => {
    if (!peerId) return;
    log.warn('peer_inbound_closed', { peer: peerId });
    for (const d of docs.values()) {
      if (d.remotePresence.delete(peerId)) {
        d.broadcast({ t: MSG.PRESENCE, docId: d.docId, users: d.presenceList() });
      }
    }
  });
  ws.on('error', () => {});
});

/* ---- client connections ---- */
wss.on('connection', (ws, req) => {
  const conn = {
    clientId: null, docId: null, username: null, role: null,
    session: null, alive: true, lastSeen: Date.now(), opsWindow: [], corr: null,
    ws, sessionToken: null, canEdit: false, aclCheckedAt: 0,
  };
  clientCount++;
  const ip = req.socket.remoteAddress;
  log.debug('client_socket_open', { ip, clients: clientCount });

  const closeWith = (code, message) => {
    sendJSON(ws, { t: MSG.ERROR, code, message });
    setTimeout(() => ws.close(4000 + (code % 1000), message), 20);
  };

  ws.on('message', async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); }
    catch { return closeWith(400, 'invalid JSON'); }
    conn.lastSeen = Date.now();

    try {
      /* ---------------------------------------------------------- hello */
      if (msg.t === MSG.HELLO) {
        if (conn.clientId) return;                       // ignore repeated hello
        const v = await withRetry(() => requestJSON(`${config.directoryUrl}/internal/verify-session`, {
          method: 'POST', headers: { 'x-internal-key': config.internalKey },
          body: { sessionToken: msg.sessionToken }, timeout: 3000,
        }), { tries: 3, base: 150 }).catch((e) => { throw Object.assign(new Error('session verification failed: ' + e.message), { code: 401 }); });

        const c = v.claims;
        conn.clientId = c.clientId;
        conn.docId = c.docId;
        conn.username = c.username;
        conn.role = c.role;
        conn.canEdit = v.canEdit;
        conn.sessionToken = msg.sessionToken;   // for periodic ACL re-validation
        conn.aclCheckedAt = Date.now();

        const session = getDoc(c.docId);
        conn.session = session;
        if (!session.loaded) await session.load();
        session.title = v.title || session.title;
        const color = session.addClient(c.clientId, ws, c.username, c.role);

        // Deliver either a snapshot (new client) or a delta (reconnecting client).
        // A delta is only correct if our log still reaches back far enough to
        // cover the client's version vector; after a snapshot-based restore it
        // may not, in which case we must send a full state transfer instead of
        // a silently truncated delta (see RGA.canServeDelta).
        const knownVV = (msg.knownVV && typeof msg.knownVV === 'object') ? msg.knownVV : null;
        let payload;
        if (knownVV && session.doc.canServeDelta(knownVV)) {
          payload = { snapshot: null, ops: session.doc.missingFor(knownVV) };
        } else {
          if (knownVV) {
            log.warn('delta_unavailable_full_state_sent', {
              docId: c.docId, clientId: c.clientId,
              knownVV, logFloor: session.doc.logFloor,
            });
          }
          payload = { snapshot: session.doc.snapshot(), ops: [] };
        }
        sendJSON(ws, {
          t: MSG.WELCOME, docId: c.docId, title: session.title, role: c.role, canEdit: v.canEdit,
          clientId: c.clientId, replicaId: REPLICA_ID, color,
          vv: session.doc.vv, presence: session.presenceList(), corr: msg.corr, ...payload,
        });
        session.broadcast({ t: MSG.PRESENCE, docId: c.docId, users: session.presenceList() }, null);
        gossipPresence(session);
        log.info('client_joined', { docId: c.docId, clientId: c.clientId, user: c.username, role: c.role, resumed: !!knownVV, sentOps: payload.ops.length });
        return;
      }

      if (!conn.clientId) return closeWith(401, 'hello required first');
      const session = conn.session;

      /* ------------------------------------------------------------ ops */
      if (msg.t === MSG.OPS) {
        // Re-validate the ACL against the Directory before honouring a write.
        // `conn.canEdit` is a cache with a short TTL, never a permanent grant:
        // an owner who revokes edit rights must lock out an already-open
        // socket, not merely future connections (§4.5).
        const acl = await refreshAcl(conn);
        if (!acl.ok) {
          log.warn('acl_revoked_disconnect', { docId: conn.docId, clientId: conn.clientId, reason: acl.reason });
          sendJSON(ws, { t: MSG.ERROR, code: 403, message: acl.reason, batchId: msg.batchId });
          return closeWith(403, acl.reason);
        }
        if (!conn.canEdit) {
          log.warn('acl_denied_write', { docId: conn.docId, clientId: conn.clientId, role: conn.role });
          return sendJSON(ws, { t: MSG.ERROR, code: 403, message: 'viewer role cannot edit', batchId: msg.batchId });
        }
        const ops = Array.isArray(msg.ops) ? msg.ops : [];
        if (ops.length > config.maxOpsPerMessage) return sendJSON(ws, { t: MSG.ERROR, code: 413, message: 'too many ops in one message', batchId: msg.batchId });

        // rate limiting (§4.5 limit message sizes / abusive clients)
        const now = Date.now();
        conn.opsWindow = conn.opsWindow.filter((t) => now - t < 1000);
        if (conn.opsWindow.length + ops.length > config.rateLimitOpsPerSec) {
          log.warn('rate_limited', { clientId: conn.clientId, docId: conn.docId });
          return sendJSON(ws, { t: MSG.ERROR, code: 429, message: 'rate limit exceeded', batchId: msg.batchId });
        }
        for (let i = 0; i < ops.length; i++) conn.opsWindow.push(now);

        const clean = [];
        for (const op of ops) {
          const err = validateOp(op);
          if (err) {
            session.stats.rejected++;
            log.warn('op_rejected', { docId: conn.docId, clientId: conn.clientId, reason: err });
            return sendJSON(ws, { t: MSG.ERROR, code: 400, message: 'invalid operation: ' + err, batchId: msg.batchId });
          }
          // A client may only author operations under its own site id.
          if (op.site !== conn.clientId) {
            session.stats.rejected++;
            log.warn('op_site_spoof', { docId: conn.docId, clientId: conn.clientId, site: op.site });
            return sendJSON(ws, { t: MSG.ERROR, code: 403, message: 'operation site does not match client id', batchId: msg.batchId });
          }
          clean.push(op);
        }
        if (session.doc.length + clean.length > config.maxDocChars) {
          return sendJSON(ws, { t: MSG.ERROR, code: 413, message: 'document size limit reached', batchId: msg.batchId });
        }

        const r = session.applyBatch(clean);
        sendJSON(ws, { t: MSG.ACK, batchId: msg.batchId, applied: r.applied.length, duplicates: r.duplicates, seq: session.storageSeq, vv: session.doc.vv });
        if (r.applied.length) {
          session.broadcast({ t: MSG.OPS, docId: conn.docId, ops: r.applied, from: conn.clientId }, conn.clientId);
          replicateToPeers(conn.docId, r.applied, conn.clientId, msg.corr);
        }
        log.info('ops_from_client', { docId: conn.docId, clientId: conn.clientId, n: clean.length, applied: r.applied.length, dup: r.duplicates, corr: msg.corr });
        return;
      }

      /* --------------------------------------------------------- cursor */
      if (msg.t === MSG.CURSOR) {
        const c = session.clients.get(conn.clientId);
        if (c) { c.pos = Math.max(0, Math.min(Number(msg.pos) || 0, session.doc.length)); }
        session.broadcast({ t: MSG.PRESENCE, docId: conn.docId, users: session.presenceList() }, conn.clientId);
        gossipPresence(session);
        return;
      }

      /* ----------------------------------------------------------- sync */
      if (msg.t === MSG.SYNC) {
        const vv = (msg.vv && typeof msg.vv === 'object') ? msg.vv : {};
        if (!session.doc.canServeDelta(vv)) {
          // Anti-entropy cannot repair a gap that predates our log floor;
          // escalate to a full state transfer rather than reporting success.
          log.warn('sync_delta_unavailable_full_state_sent', {
            docId: conn.docId, clientId: conn.clientId, vv, logFloor: session.doc.logFloor,
          });
          sendJSON(ws, {
            t: MSG.SYNC, docId: conn.docId, ops: [], snapshot: session.doc.snapshot(),
            vv: session.doc.vv, corr: msg.corr,
          });
          return;
        }
        const missing = session.doc.missingFor(vv);
        sendJSON(ws, { t: MSG.SYNC, docId: conn.docId, ops: missing, vv: session.doc.vv, corr: msg.corr });
        log.info('sync_served', { docId: conn.docId, clientId: conn.clientId, ops: missing.length });
        return;
      }

      if (msg.t === MSG.PING) return sendJSON(ws, { t: MSG.PONG, ts: msg.ts });
    } catch (err) {
      log.error('client_frame_error', { clientId: conn.clientId, docId: conn.docId, err: err.message });
      closeWith(err.code || 500, err.message);
    }
  });

  ws.on('pong', () => { conn.alive = true; conn.lastSeen = Date.now(); });
  ws.on('close', () => {
    clientCount--;
    if (conn.session && conn.clientId) {
      conn.session.removeClient(conn.clientId);
      conn.session.broadcast({ t: MSG.PRESENCE, docId: conn.docId, users: conn.session.presenceList() });
      gossipPresence(conn.session);
      log.info('client_left', { docId: conn.docId, clientId: conn.clientId, remaining: conn.session.clients.size });
    }
  });
  ws.on('error', (e) => log.debug('client_socket_error', { err: e.message }));
});

/* ---- liveness sweep: drop clients that stopped answering pings ---- */
const sweep = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client._coeditAlive === false) { log.warn('client_ping_timeout_terminate'); client.terminate(); continue; }
    client._coeditAlive = false;
    client.ping();
    client.once('pong', () => { client._coeditAlive = true; });
  }
  for (const [pid, p] of peers) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ t: MSG.R_PING }));
  }
}, config.wsPingMs);
sweep.unref?.();

/* ---- periodic durability work ---- */
const durability = setInterval(() => {
  for (const d of docs.values()) { d.flush().catch(() => {}); d.drainDeadLetter().catch(() => {}); }
}, 1000);
/* re-announce presence periodically (also seeds peers that just connected) */
const presenceTimer = setInterval(() => {
  for (const d of docs.values()) if (d.clients.size) gossipPresence(d);
}, 2000);
presenceTimer.unref?.();
durability.unref?.();

// -------------------------------------------------------------------- boot
server.listen(PORT, '0.0.0.0', () => {
  log.info('listening', { port: PORT, role: 'collab-replica', advertise: ADVERTISE, chaos });
  startLeaseHeartbeat();
});

async function shutdown(sig) {
  log.info('shutdown_begin', { sig });
  clearInterval(sweep); clearInterval(durability); clearInterval(presenceTimer);
  if (leaseTimer) clearInterval(leaseTimer);
  for (const client of wss.clients) { try { client.send(JSON.stringify({ t: MSG.BYE, reason: 'replica shutting down' })); } catch {} }
  try {
    await requestJSON(`${config.directoryUrl}/registry/replicas/${REPLICA_ID}`, { method: 'DELETE', headers: { 'x-internal-key': config.internalKey }, timeout: 1000 });
  } catch {}
  for (const d of docs.values()) { try { await d.flush(); await d.drainDeadLetter(); await d.persistSnapshot(); } catch {} }
  log.info('shutdown_done', {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
/** SIGKILL-style crash for fault tests: node ... & kill -9 */
