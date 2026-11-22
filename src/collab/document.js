'use strict';
/**
 * DocumentSession — one live CRDT document inside a collaboration replica.
 *
 * Holds:
 *   • the RGA replica state,
 *   • the set of connected client sockets (subscribers),
 *   • presence (cursor) information,
 *   • the write-behind buffer that persists ops to the Storage Service.
 *
 * Persistence strategy (§4.4 checkpointing):
 *   ops are appended to a buffer and flushed every PERSIST_BATCH_MS with
 *   bounded retry. After SNAPSHOT_EVERY_OPS applied operations a snapshot is
 *   pushed so that recovery does not need to replay the whole log.
 */
const { RGA } = require('../common/crdt/rga');
const { config } = require('../common/util/config');
const { requestJSON, withRetry } = require('../common/util/http');

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];

class DocumentSession {
  constructor(docId, replicaId, log) {
    this.docId = docId;
    this.replicaId = replicaId;
    this.log = log;
    this.doc = new RGA(replicaId, {         // replica's own site id
      onDrop: (reason, op) => this.log.warn('pending_op_dropped', { docId, reason, opId: op && op.id }),
    });
    this.title = docId;
    this.clients = new Map();               // clientId -> { ws, username, role, pos, color }
    this.remotePresence = new Map();        // peerReplicaId -> [ {clientId, username, role, pos, color, replicaId} ]
    this.loaded = false;
    this.dirty = [];                        // ops awaiting persistence
    this.opsSincePersistedSnapshot = 0;
    this.storageSeq = 0;
    this.flushTimer = null;
    this.flushing = false;
    this.deadLetter = [];                   // ops we could not persist (§4.4 DLQ)
    this.stats = { applied: 0, duplicates: 0, rejected: 0, pending: 0 };
    /** Injected by the replica so fault injection also covers broadcasts. */
    this.sender = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  }

  // ------------------------------------------------------------ lifecycle
  /** Rebuild state from the Storage Service (snapshot + op delta). */
  async load() {
    if (this.loaded) return;
    const url = `${config.storageUrl}/docs/${encodeURIComponent(this.docId)}/state`;
    const res = await withRetry(
      () => requestJSON(url, { headers: { 'x-internal-key': config.internalKey }, timeout: 5000 }),
      { tries: 5, base: 150, onRetry: (n, d, e) => this.log.warn('storage_retry', { docId: this.docId, attempt: n, delayMs: d, err: e.message }) });

    if (res.snapshot) {
      this.doc = RGA.fromSnapshot(this.replicaId, res.snapshot, {
        onDrop: (reason, op) => this.log.warn('pending_op_dropped', { docId: this.docId, reason, opId: op && op.id }),
      });
      this.log.info('doc_restored_from_snapshot', {
        docId: this.docId, seq: res.snapshotSeq, chars: this.doc.length,
        historyOps: this.doc.oplog.length, logFloor: this.doc.logFloor,
      });
    }
    let replayed = 0;
    for (const op of res.ops || []) {
      if (this.doc.apply(op) === 'applied') replayed++;
    }
    this.storageSeq = res.seq || 0;
    this.loaded = true;
    this.log.info('doc_loaded', { docId: this.docId, replayedOps: replayed, seq: this.storageSeq, chars: this.doc.length, textLen: this.doc.text().length });
  }

  // ------------------------------------------------------------- clients
  addClient(clientId, ws, username, role) {
    const color = COLORS[this.clients.size % COLORS.length];
    this.clients.set(clientId, { ws, username, role, pos: 0, color, joinedAt: Date.now() });
    return color;
  }

  removeClient(clientId) { this.clients.delete(clientId); }

  /** Users connected to THIS replica only. */
  localPresence() {
    return [...this.clients.entries()].map(([clientId, c]) => ({
      clientId, username: c.username, role: c.role, pos: c.pos, color: c.color, replicaId: this.replicaId,
    }));
  }

  /**
   * Global active-user list = local clients + everything gossiped by peers.
   * §8.3 requires "display active users" for the document, not per-server.
   */
  presenceList() {
    const out = this.localPresence();
    const seen = new Set(out.map((u) => u.clientId));
    for (const list of this.remotePresence.values()) {
      for (const u of list) if (!seen.has(u.clientId)) { seen.add(u.clientId); out.push(u); }
    }
    return out;
  }

  setRemotePresence(peerId, users) {
    if (users && users.length) this.remotePresence.set(peerId, users);
    else this.remotePresence.delete(peerId);
  }

  dropPeerPresence(peerId) { this.remotePresence.delete(peerId); }

  broadcast(obj, exceptClientId) {
    for (const [cid, c] of this.clients) {
      if (cid === exceptClientId) continue;
      this.sender(c.ws, obj);
    }
  }

  // ---------------------------------------------------------------- ops
  /**
   * Apply a batch of ops originating from a client or a peer replica.
   * @returns {{applied:Op[], duplicates:number, pending:number}}
   */
  applyBatch(ops) {
    const applied = [];
    let duplicates = 0, pending = 0;
    for (const op of ops) {
      const r = this.doc.apply(op);
      if (r === 'applied') { applied.push(op); this.stats.applied++; }
      else if (r === 'duplicate') { duplicates++; this.stats.duplicates++; }
      else if (r === 'dropped') { this.stats.rejected++; }   // parking area full / expired
      else { pending++; applied.push(op); }   // parked: still must be relayed+persisted
    }
    this.stats.pending = this.doc.pendingCount();
    if (applied.length) this.enqueuePersist(applied);
    return { applied, duplicates, pending };
  }

  // -------------------------------------------------------- persistence
  enqueuePersist(ops) {
    this.dirty.push(...ops);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush().catch(() => {}); }, config.persistBatchMs);
      this.flushTimer.unref?.();
    }
  }

  async flush() {
    if (this.flushing || !this.dirty.length) return;
    this.flushing = true;
    const batch = this.dirty.splice(0, this.dirty.length);
    try {
      const res = await withRetry(() => requestJSON(
        `${config.storageUrl}/docs/${encodeURIComponent(this.docId)}/ops`,
        { method: 'POST', body: { ops: batch, replicaId: this.replicaId }, headers: { 'x-internal-key': config.internalKey }, timeout: 4000 }),
      { tries: 4, base: 200, onRetry: (n, d, e) => this.log.warn('persist_retry', { docId: this.docId, attempt: n, delayMs: d, err: e.message }) });

      this.storageSeq = res.seq;
      this.opsSincePersistedSnapshot += res.accepted;
      this.log.debug('ops_persisted', { docId: this.docId, n: batch.length, accepted: res.accepted, seq: res.seq });

      if (this.opsSincePersistedSnapshot >= config.snapshotEveryOps) {
        this.opsSincePersistedSnapshot = 0;
        await this.persistSnapshot();
      }
    } catch (err) {
      // Storage is down: keep the ops in a dead-letter buffer and retry later.
      this.deadLetter.push(...batch);
      this.log.error('persist_failed_dead_letter', { docId: this.docId, n: batch.length, dlq: this.deadLetter.length, err: err.message });
    } finally {
      this.flushing = false;
      if (this.dirty.length) this.enqueuePersist([]);
    }
  }

  /** Retry whatever landed in the dead-letter buffer (called by a timer). */
  async drainDeadLetter() {
    if (!this.deadLetter.length) return;
    const batch = this.deadLetter.splice(0, this.deadLetter.length);
    try {
      const res = await requestJSON(
        `${config.storageUrl}/docs/${encodeURIComponent(this.docId)}/ops`,
        { method: 'POST', body: { ops: batch, replicaId: this.replicaId }, headers: { 'x-internal-key': config.internalKey }, timeout: 4000 });
      this.storageSeq = res.seq;
      this.log.info('dead_letter_drained', { docId: this.docId, n: batch.length, accepted: res.accepted, seq: res.seq });
    } catch (err) {
      this.deadLetter.unshift(...batch);
      this.log.warn('dead_letter_retry_failed', { docId: this.docId, dlq: this.deadLetter.length, err: err.message });
    }
  }

  async persistSnapshot() {
    try {
      await requestJSON(`${config.storageUrl}/docs/${encodeURIComponent(this.docId)}/snapshot`,
        { method: 'POST', body: { seq: this.storageSeq, snapshot: this.doc.snapshot() }, headers: { 'x-internal-key': config.internalKey }, timeout: 5000 });
      this.log.info('snapshot_pushed', { docId: this.docId, seq: this.storageSeq, chars: this.doc.length });
    } catch (err) {
      this.log.warn('snapshot_push_failed', { docId: this.docId, err: err.message });
    }
  }

  info() {
    return {
      docId: this.docId, clients: this.clients.size, chars: this.doc.length,
      ops: this.doc.oplog.length, pending: this.doc.pendingCount(),
      dlq: this.deadLetter.length, seq: this.storageSeq, lamport: this.doc.lamport,
    };
  }
}

module.exports = { DocumentSession };
