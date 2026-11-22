'use strict';
/**
 * DIRECTORY SERVICE  (naming • authentication • service discovery • ACL)
 * ---------------------------------------------------------------------
 * Responsibilities
 *  1. Identity: user registration / login, PBKDF2 password storage, HS256 tokens.
 *  2. Naming: allocates globally unique documentId and clientId (siteId) values.
 *  3. Service discovery: collaboration replicas register and renew a *lease*;
 *     a replica whose lease expires is considered failed and is removed
 *     (§4.2 "how online/offline components are detected").
 *  4. Placement: maps documentId -> ordered list of live replicas. The first
 *     entry is the PRIMARY for that document (rendezvous hashing over the set
 *     of live replicas, so placement is stable and recomputed automatically
 *     when a replica dies => failover).
 *  5. Access control: owner / editor / viewer roles per document.
 *
 * State is kept in memory + an append-only JSON file so the service can be
 * restarted without losing users or ACLs.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { config, requireSecrets } = require('../common/util/config');
const { createLogger } = require('../common/util/log');
const { readBody, send, createRouter } = require('../common/util/http');
const { hashPassword, verifyPassword, sign, verify } = require('../common/auth/tokens');

const NODE_ID = process.env.NODE_ID || 'directory-1';
const log = createLogger(NODE_ID);
requireSecrets(log);

const STATE_FILE = path.join(config.dataDir, 'directory-state.json');

// ------------------------------------------------------------------ state
const state = {
  users: new Map(),      // username -> { id, username, pwd, createdAt }
  docs: new Map(),       // docId -> { id, title, ownerId, acl: {userId: role}, createdAt }
};
const replicas = new Map();   // replicaId -> { id, wsUrl, publicWsUrl, leaseUntil, load, registeredAt }

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dump = {
    users: [...state.users.values()],
    docs: [...state.docs.values()].map((d) => ({ ...d, acl: d.acl })),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(dump, null, 2));
}

function restore() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const dump = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const u of dump.users || []) state.users.set(u.username, u);
    for (const d of dump.docs || []) state.docs.set(d.id, d);
    log.info('state_restored', { users: state.users.size, docs: state.docs.size });
  } catch (e) {
    log.error('state_restore_failed', { err: e.message });
  }
}

// -------------------------------------------------------------- validation
const USERNAME_RX = /^[a-zA-Z0-9_.-]{3,32}$/;
function assert(cond, status, msg) {
  if (!cond) throw Object.assign(new Error(msg), { status });
}
function sanitizeTitle(t) {
  return String(t || 'Untitled').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'Untitled';
}

// --------------------------------------------------------------- lease mgmt
function liveReplicas() {
  const now = Date.now();
  return [...replicas.values()].filter((r) => r.leaseUntil > now);
}

function reapReplicas() {
  const now = Date.now();
  for (const [id, r] of replicas) {
    if (r.leaseUntil <= now) {
      replicas.delete(id);
      log.warn('replica_lease_expired', { replica: id, wsUrl: r.wsUrl });
    }
  }
}
setInterval(reapReplicas, 1000).unref?.();

/**
 * Rendezvous (highest-random-weight) hashing: deterministic, minimal
 * reshuffling when the replica set changes.
 */
function placementFor(docId) {
  const live = liveReplicas();
  return live
    .map((r) => ({
      r,
      w: crypto.createHash('sha1').update(`${docId}|${r.id}`).digest().readUInt32BE(0),
    }))
    .sort((a, b) => b.w - a.w || (a.r.id < b.r.id ? -1 : 1))
    .map((x) => x.r);
}

// ------------------------------------------------------------------- authz
function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
function requireUser(req) {
  const claims = verify(bearer(req), config.jwtSecret);
  assert(claims, 401, 'unauthorized');
  return claims;
}
function requireInternal(req) {
  const key = req.headers['x-internal-key'];
  assert(typeof key === 'string' && key.length === config.internalKey.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(config.internalKey)), 403, 'forbidden');
}
function roleOf(doc, userId) {
  if (doc.ownerId === userId) return 'owner';
  return doc.acl[userId] || null;
}
const RANK = { viewer: 1, editor: 2, owner: 3 };
function canEdit(role) { return RANK[role] >= RANK.editor; }

// ------------------------------------------------------------------ routes
const router = createRouter();

router.add('GET', '/health', (req, res) =>
  send(res, 200, { ok: true, node: NODE_ID, users: state.users.size, docs: state.docs.size, replicas: liveReplicas().length }));

/* ---- identity ---- */
router.add('POST', '/auth/register', async (req, res) => {
  const b = await readBody(req);
  assert(USERNAME_RX.test(b.username || ''), 400, 'username must be 3-32 chars [a-zA-Z0-9_.-]');
  assert(typeof b.password === 'string' && b.password.length >= 8 && b.password.length <= 200, 400, 'password must be 8-200 chars');
  assert(!state.users.has(b.username), 409, 'username already exists');
  const user = {
    id: 'u-' + crypto.randomBytes(6).toString('hex'),
    username: b.username,
    pwd: hashPassword(b.password),      // never plaintext
    createdAt: new Date().toISOString(),
  };
  state.users.set(user.username, user);
  persist();
  log.info('user_registered', { userId: user.id, username: user.username });
  send(res, 201, { userId: user.id, username: user.username });
});

router.add('POST', '/auth/login', async (req, res) => {
  const b = await readBody(req);
  const user = state.users.get(String(b.username || ''));
  const ok = user && verifyPassword(String(b.password || ''), user.pwd);
  if (!ok) {
    log.warn('login_failed', { username: b.username });
    return send(res, 401, { error: 'invalid credentials' });
  }
  const token = sign({ sub: user.id, username: user.username }, config.jwtSecret, 8 * 3600);
  log.info('login_ok', { userId: user.id });
  send(res, 200, { token, userId: user.id, username: user.username });
});

router.add('GET', '/auth/me', (req, res) => {
  const c = requireUser(req);
  send(res, 200, { userId: c.sub, username: c.username, exp: c.exp });
});

/* ---- service discovery: replicas register + renew leases ---- */
router.add('POST', '/registry/replicas', async (req, res) => {
  requireInternal(req);
  const b = await readBody(req);
  assert(typeof b.replicaId === 'string' && b.replicaId.length <= 64, 400, 'replicaId required');
  assert(typeof b.wsUrl === 'string', 400, 'wsUrl required');
  const existing = replicas.get(b.replicaId);
  const rec = {
    id: b.replicaId,
    wsUrl: b.wsUrl,
    publicWsUrl: b.publicWsUrl || b.wsUrl,
    load: b.load || 0,
    leaseUntil: Date.now() + config.leaseTtlMs,
    registeredAt: existing ? existing.registeredAt : new Date().toISOString(),
  };
  replicas.set(rec.id, rec);
  if (!existing) log.info('replica_registered', { replica: rec.id, wsUrl: rec.wsUrl });
  else log.debug('replica_lease_renewed', { replica: rec.id });
  send(res, 200, { leaseTtlMs: config.leaseTtlMs, peers: liveReplicas().filter((r) => r.id !== rec.id).map((r) => ({ id: r.id, wsUrl: r.wsUrl })) });
});

router.add('DELETE', '/registry/replicas/:id', (req, res, { params }) => {
  requireInternal(req);
  if (replicas.delete(params.id)) log.info('replica_deregistered', { replica: params.id });
  send(res, 200, { ok: true });
});

router.add('GET', '/registry/replicas', (req, res) =>
  send(res, 200, { replicas: liveReplicas().map((r) => ({ id: r.id, wsUrl: r.wsUrl, publicWsUrl: r.publicWsUrl, load: r.load, msLeft: r.leaseUntil - Date.now() })) }));

/* ---- documents: naming + ACL + placement ---- */
router.add('POST', '/docs', async (req, res) => {
  const c = requireUser(req);
  const b = await readBody(req);
  const doc = {
    id: 'doc-' + crypto.randomBytes(6).toString('hex'),
    title: sanitizeTitle(b.title),
    ownerId: c.sub,
    ownerName: c.username,
    acl: {},
    createdAt: new Date().toISOString(),
  };
  state.docs.set(doc.id, doc);
  persist();
  log.info('doc_created', { docId: doc.id, ownerId: c.sub, title: doc.title });
  send(res, 201, { docId: doc.id, title: doc.title });
});

router.add('GET', '/docs', (req, res) => {
  const c = requireUser(req);
  const list = [...state.docs.values()]
    .filter((d) => roleOf(d, c.sub))
    .map((d) => ({ id: d.id, title: d.title, role: roleOf(d, c.sub), ownerName: d.ownerName, createdAt: d.createdAt }));
  send(res, 200, { docs: list });
});

router.add('POST', '/docs/:id/share', async (req, res, { params }) => {
  const c = requireUser(req);
  const doc = state.docs.get(params.id);
  assert(doc, 404, 'document not found');
  assert(doc.ownerId === c.sub, 403, 'only the owner can share');
  const b = await readBody(req);
  const target = state.users.get(String(b.username || ''));
  assert(target, 404, 'user not found');
  assert(['viewer', 'editor'].includes(b.role), 400, 'role must be viewer|editor');
  doc.acl[target.id] = b.role;
  persist();
  log.info('doc_shared', { docId: doc.id, grantee: target.id, role: b.role });
  send(res, 200, { ok: true, acl: doc.acl });
});

/**
 * Ticket endpoint: the client asks "where do I connect for this document and
 * what may I do there?". Returns the ordered replica list (primary first) and
 * a short-lived, document-scoped session token consumed by the collab replica.
 */
router.add('GET', '/docs/:id/session', (req, res, { params, query }) => {
  const c = requireUser(req);
  const doc = state.docs.get(params.id);
  assert(doc, 404, 'document not found');
  const role = roleOf(doc, c.sub);
  assert(role, 403, 'no access to this document');
  const chain = placementFor(doc.id);
  assert(chain.length, 503, 'no collaboration replica available');

  /**
   * Site-id stability across reconnects.
   * A CRDT site id must never change for a replica that still holds operations
   * it authored, otherwise those ops would be rejected by the anti-spoofing
   * check on the collaboration replica. A reconnecting client may therefore
   * ask to keep its previous clientId — but only inside its OWN namespace
   * (`<username>-<hex>`), so it can never claim another user's site id.
   */
  const requested = query.get('clientId');
  let clientId;
  if (requested && new RegExp(`^${c.username.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}-[0-9a-f]{6}$`).test(requested)) {
    clientId = requested;
  } else {
    if (requested) log.warn('client_id_reuse_denied', { userId: c.sub, requested });
    clientId = `${c.username}-${crypto.randomBytes(3).toString('hex')}`;   // unique site id
  }
  const sessionToken = sign(
    { sub: c.sub, username: c.username, docId: doc.id, role, clientId, typ: 'session' },
    config.jwtSecret, 900);
  log.info('session_issued', { docId: doc.id, userId: c.sub, clientId, role, primary: chain[0].id });
  send(res, 200, {
    docId: doc.id,
    title: doc.title,
    role,
    clientId,
    sessionToken,
    primary: { id: chain[0].id, wsUrl: chain[0].publicWsUrl },
    replicas: chain.map((r) => ({ id: r.id, wsUrl: r.publicWsUrl })),
  });
});

/**
 * Used by collab replicas to validate a session token they received.
 *
 * The role is re-derived from the CURRENT ACL rather than taken from the
 * token: a token minted while the user was an editor must not keep granting
 * write access after the owner downgraded them (§4.5 access control). The
 * replica re-calls this endpoint periodically for live sessions, so a
 * revocation takes effect without waiting for the token to expire.
 */
router.add('POST', '/internal/verify-session', async (req, res) => {
  requireInternal(req);
  const b = await readBody(req);
  const claims = verify(b.sessionToken, config.jwtSecret);
  assert(claims && claims.typ === 'session', 401, 'invalid session token');
  const doc = state.docs.get(claims.docId);
  assert(doc, 404, 'document not found');
  const liveRole = roleOf(doc, claims.sub);
  assert(liveRole, 403, 'access to this document has been revoked');
  if (liveRole !== claims.role) {
    log.info('role_changed_since_token', { docId: doc.id, userId: claims.sub, was: claims.role, now: liveRole });
  }
  send(res, 200, {
    ok: true,
    claims: { ...claims, role: liveRole },
    role: liveRole,
    canEdit: canEdit(liveRole),
    title: doc.title,
  });
});

// ------------------------------------------------------------------- boot
restore();
const server = http.createServer((req, res) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    log.debug('http', { method: req.method, path: req.url.split('?')[0], status: res.statusCode, ms: +ms.toFixed(2) });
  });
  router.handle(req, res);
});
server.listen(config.directoryPort, '0.0.0.0', () =>
  log.info('listening', { port: config.directoryPort, role: 'directory' }));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log.info('shutdown', { sig }); persist(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); });
}
