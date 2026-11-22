'use strict';
/**
 * WIRE PROTOCOL  (JSON over WebSocket)
 * ====================================
 * All frames are UTF-8 JSON objects with a mandatory `t` (type) field and an
 * optional `corr` correlation id echoed back by the peer, so a request and its
 * response can be stitched together in the logs.
 *
 * ---------------------------- client -> replica ---------------------------
 *  hello    { t, sessionToken, knownVV?, corr }
 *              First frame. Authenticates and joins the document session.
 *  ops      { t, docId, ops:[Op], batchId, corr }
 *              A batch of locally generated CRDT operations.
 *  cursor   { t, docId, anchorId, pos }
 *              Presence: where this user's caret is.
 *  sync     { t, docId, vv }
 *              "Here is my version vector, send me what I am missing."
 *              Used on reconnect (§8.3 re-synchronise after connection loss).
 *  ping     { t, ts }
 *
 * ---------------------------- replica -> client ---------------------------
 *  welcome  { t, docId, title, role, clientId, replicaId, snapshot, ops, vv, presence }
 *  ops      { t, docId, ops:[Op], from }          broadcast of remote ops
 *  ack      { t, batchId, seq, applied, duplicates }
 *  presence { t, docId, users:[{clientId,username,pos,color}] }
 *  sync     { t, docId, ops:[Op], vv }            answer to a sync request
 *  error    { t, code, message, corr }
 *  pong     { t, ts }
 *  bye      { t, reason }                          graceful drain before shutdown
 *
 * --------------------------- replica <-> replica --------------------------
 *  r-hello  { t, replicaId, key }                  internal auth handshake
 *  r-ops    { t, docId, ops:[Op], origin, hop }    replicated operations
 *  r-presence { t, docId, replicaId, users:[...] }   gossiped active users
 *  r-ping / r-pong
 *
 * Operation shape (CRDT, see src/common/crdt/rga.js):
 *  insert:  { id:"site:ctr", t:"ins", site, ctr, lam, after, ch }
 *  delete:  { id:"site:ctr", t:"del", site, ctr, lam, target }
 *
 * Because every op carries a globally unique `id`, and application is
 * idempotent + commutative, duplicates and reordering are handled by the CRDT
 * itself rather than by the transport.
 */

const MSG = {
  HELLO: 'hello', WELCOME: 'welcome', OPS: 'ops', ACK: 'ack', CURSOR: 'cursor',
  PRESENCE: 'presence', SYNC: 'sync', ERROR: 'error', PING: 'ping', PONG: 'pong',
  BYE: 'bye', R_HELLO: 'r-hello', R_OPS: 'r-ops', R_PING: 'r-ping', R_PONG: 'r-pong',
  R_PRESENCE: 'r-presence',
};

/** Validate an operation received from the network (§4.5 input validation). */
function validateOp(op) {
  if (!op || typeof op !== 'object') return 'op must be an object';
  if (typeof op.id !== 'string' || op.id.length > 96) return 'bad op id';
  if (typeof op.site !== 'string' || op.site.length > 64) return 'bad site';
  if (!Number.isInteger(op.ctr) || op.ctr < 1) return 'bad ctr';
  if (!Number.isInteger(op.lam) || op.lam < 0) return 'bad lamport';
  if (op.id !== `${op.site}:${op.ctr}`) return 'op id does not match site:ctr';
  if (op.t === 'ins') {
    if (typeof op.ch !== 'string' || [...op.ch].length !== 1) return 'insert must carry exactly one character';
    if (typeof op.after !== 'string' || op.after.length > 96) return 'bad after';
  } else if (op.t === 'del') {
    if (typeof op.target !== 'string' || op.target.length > 96) return 'bad target';
  } else {
    return 'unknown op type';
  }
  return null;
}

module.exports = { MSG, validateOp };
