'use strict';
/**
 * STORAGE SERVICE  (durable operation log + periodic snapshots)
 * -------------------------------------------------------------
 * The collaboration replicas are *stateless across restarts*: all durability
 * lives here. This is the component that makes "restart the server and restore
 * the document" (§8.4) work, and it is also the rendezvous point that lets a
 * second replica take over a document after a failover.
 *
 * Storage layout (one directory per document):
 *   data/docs/<docId>/oplog.ndjson    append-only, one CRDT op per line
 *   data/docs/<docId>/snapshot.json   latest snapshot { seq, snapshot }
 *
 * Every op is stored with a monotonically increasing sequence number `seq`.
 * Clients/replicas read with ?sinceSeq=N to fetch only the delta.
 * Deduplication is by op id, so a retried append is harmless (idempotent).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { config } = require('../common/util/config');
const { createLogger } = require('../common/util/log');
const { readBody, send, createRouter } = require('../common/util/http');

const NODE_ID = process.env.NODE_ID || 'storage-1';
const log = createLogger(NODE_ID);
const ROOT_DIR = path.join(config.dataDir, 'docs');

function assert(cond, status, msg) { if (!cond) throw Object.assign(new Error(msg), { status }); }

const DOCID_RX = /^[A-Za-z0-9_-]{1,64}$/;
function docDir(docId) {
  assert(DOCID_RX.test(docId), 400, 'invalid docId');       // path-traversal guard
  return path.join(ROOT_DIR, docId);
}

/** In-memory index: docId -> { seq, ids:Set, dir, fd } */
const index = new Map();

function openDoc(docId) {
  if (index.has(docId)) return index.get(docId);
  const dir = docDir(docId);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'oplog.ndjson');
  const entry = { docId, dir, logPath, seq: 0, ids: new Set(), ops: [] };
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (entry.ids.has(rec.op.id)) continue;
        entry.ids.add(rec.op.id);
        entry.seq = Math.max(entry.seq, rec.seq);
        entry.ops.push(rec);
      } catch { /* skip corrupt trailing line (crash during write) */ }
    }
    entry.ops.sort((a, b) => a.seq - b.seq);
    log.info('oplog_loaded', { docId, ops: entry.ops.length, seq: entry.seq });
  }
  index.set(docId, entry);
  return entry;
}

function appendOps(docId, ops, meta = {}) {
  const e = openDoc(docId);
  const accepted = [];
  let buf = '';
  for (const op of ops) {
    if (!op || typeof op.id !== 'string') continue;
    if (e.ids.has(op.id)) continue;                       // deduplication
    const rec = { seq: ++e.seq, op, at: Date.now(), by: meta.replicaId || null };
    e.ids.add(op.id);
    e.ops.push(rec);
    accepted.push(rec);
    buf += JSON.stringify(rec) + '\n';
  }
  if (buf) fs.appendFileSync(e.logPath, buf);             // durable append
  return { accepted, seq: e.seq, duplicates: ops.length - accepted.length };
}

function snapshotPath(docId) { return path.join(docDir(docId), 'snapshot.json'); }

function readSnapshot(docId) {
  const p = snapshotPath(docId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { log.error('snapshot_corrupt', { docId, err: e.message }); return null; }
}

function writeSnapshot(docId, seq, snapshot) {
  const p = snapshotPath(docId);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ seq, snapshot, at: Date.now() }));
  fs.renameSync(tmp, p);                                   // atomic replace
  log.info('snapshot_written', { docId, seq, elements: snapshot.elements.length });
}

// ------------------------------------------------------------------ authz
function requireInternal(req) {
  const key = req.headers['x-internal-key'];
  assert(typeof key === 'string' && key.length === config.internalKey.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(config.internalKey)), 403, 'forbidden');
}

// ------------------------------------------------------------------ routes
const router = createRouter();

router.add('GET', '/health', (req, res) =>
  send(res, 200, { ok: true, node: NODE_ID, docs: index.size }));

/** Full state needed to rebuild a document: snapshot + ops after it. */
router.add('GET', '/docs/:id/state', (req, res, { params, query }) => {
  requireInternal(req);
  const e = openDoc(params.id);
  const snap = readSnapshot(params.id);
  const since = Math.max(parseInt(query.get('sinceSeq') || '0', 10) || 0, snap ? snap.seq : 0);
  const ops = e.ops.filter((r) => r.seq > since).map((r) => r.op);
  send(res, 200, {
    docId: params.id,
    snapshot: snap ? snap.snapshot : null,
    snapshotSeq: snap ? snap.seq : 0,
    ops,
    seq: e.seq,
  });
});

/** Delta read used by replicas that are catching up. */
router.add('GET', '/docs/:id/ops', (req, res, { params, query }) => {
  requireInternal(req);
  const e = openDoc(params.id);
  const since = parseInt(query.get('sinceSeq') || '0', 10) || 0;
  const limit = Math.min(parseInt(query.get('limit') || '5000', 10) || 5000, 20000);
  const ops = e.ops.filter((r) => r.seq > since).slice(0, limit);
  send(res, 200, { docId: params.id, ops: ops.map((r) => r.op), seq: e.seq, lastSeq: ops.length ? ops[ops.length - 1].seq : since });
});

router.add('POST', '/docs/:id/ops', async (req, res, { params }) => {
  requireInternal(req);
  const b = await readBody(req);
  assert(Array.isArray(b.ops), 400, 'ops[] required');
  assert(b.ops.length <= 5000, 413, 'too many ops in one batch');
  const r = appendOps(params.id, b.ops, { replicaId: b.replicaId });
  log.debug('ops_appended', { docId: params.id, accepted: r.accepted.length, dup: r.duplicates, seq: r.seq, by: b.replicaId });
  send(res, 200, { accepted: r.accepted.length, duplicates: r.duplicates, seq: r.seq });
});

router.add('POST', '/docs/:id/snapshot', async (req, res, { params }) => {
  requireInternal(req);
  const b = await readBody(req);
  assert(b.snapshot && Array.isArray(b.snapshot.elements), 400, 'snapshot required');
  const e = openDoc(params.id);
  const seq = Math.min(b.seq || e.seq, e.seq);
  writeSnapshot(params.id, seq, b.snapshot);
  send(res, 200, { ok: true, seq });
});

router.add('GET', '/docs/:id/stats', (req, res, { params }) => {
  requireInternal(req);
  const e = openDoc(params.id);
  const snap = readSnapshot(params.id);
  send(res, 200, { docId: params.id, ops: e.ops.length, seq: e.seq, snapshotSeq: snap ? snap.seq : 0 });
});

// -------------------------------------------------------------------- boot
fs.mkdirSync(ROOT_DIR, { recursive: true });
const server = http.createServer((req, res) => router.handle(req, res));
server.listen(config.storagePort, '0.0.0.0', () =>
  log.info('listening', { port: config.storagePort, role: 'storage', dataDir: ROOT_DIR }));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log.info('shutdown', { sig }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 300); });
}
