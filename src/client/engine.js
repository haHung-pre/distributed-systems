'use strict';
/**
 * CoEditClient — the Node-side client engine used by the CLI and the test
 * suite. The browser client (src/client/web/app.js) implements the same state
 * machine on top of the native WebSocket API.
 *
 * Features
 *  • Login / session ticket acquisition from the Directory Service.
 *  • Local-first editing: an operation is applied to the local CRDT replica
 *    immediately and sent asynchronously (no round trip in the typing path).
 *  • Offline buffering: ops generated while the socket is down are queued and
 *    replayed on reconnect (§8.5 offline editing).
 *  • Reconnect with exponential backoff + FAILOVER: on every attempt the
 *    client re-asks the Directory for a session, so if the primary replica is
 *    dead it is transparently moved to the next live replica.
 *  • Delta re-synchronisation: on reconnect the client sends its version
 *    vector, and the replica replies only with the ops it is missing.
 */
const { WebSocket } = require('ws');
const { RGA, ROOT } = require('../common/crdt/rga');
const { config } = require('../common/util/config');
const { requestJSON, withRetry } = require('../common/util/http');
const { MSG } = require('../collab/protocol');
const { createLogger } = require('../common/util/log');

class CoEditClient {
  /**
   * @param {object}  o
   * @param {string} [o.preferReplica] pin this client to a specific replica id
   *        (load-balancing / test hook). Falls back to the primary when that
   *        replica is not in the live set, which is exactly the failover path.
   */
  constructor({ username, password, directoryUrl = config.directoryUrl, logger, autoReconnect = true, preferReplica = null } = {}) {
    this.username = username;
    this.password = password;
    this.directoryUrl = directoryUrl;
    this.preferReplica = preferReplica;
    this.log = logger || createLogger(`client/${username}`);
    this.token = null;
    this.userId = null;
    this.docId = null;
    this.clientId = null;
    this.replicaId = null;
    this.doc = null;
    this.ws = null;
    this.connected = false;
    this.autoReconnect = autoReconnect;
    this.outbox = [];             // ops not yet acknowledged / not yet sent
    this.inflight = new Map();    // batchId -> ops (for retransmission)
    this.batchSeq = 0;
    this.backoff = 200;
    this.handlers = {};           // event -> [fn]
    this.presence = [];
    this.stats = { sent: 0, acked: 0, received: 0, reconnects: 0, failovers: 0 };
    this._closedByUser = false;
  }

  on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
  emit(evt, ...args) { for (const fn of this.handlers[evt] || []) { try { fn(...args); } catch (e) { this.log.error('handler_error', { evt, err: e.message }); } } }

  // ------------------------------------------------------------- identity
  async register() {
    try {
      await requestJSON(`${this.directoryUrl}/auth/register`, { method: 'POST', body: { username: this.username, password: this.password } });
    } catch (e) { if (e.status !== 409) throw e; }     // already exists is fine
    return this;
  }

  async login() {
    const r = await withRetry(() => requestJSON(`${this.directoryUrl}/auth/login`, { method: 'POST', body: { username: this.username, password: this.password } }), { tries: 3 });
    this.token = r.token;
    this.userId = r.userId;
    return this;
  }

  auth() { return { authorization: `Bearer ${this.token}` }; }

  async createDoc(title) {
    const r = await requestJSON(`${this.directoryUrl}/docs`, { method: 'POST', body: { title }, headers: this.auth() });
    return r.docId;
  }

  async share(docId, username, role) {
    return requestJSON(`${this.directoryUrl}/docs/${docId}/share`, { method: 'POST', body: { username, role }, headers: this.auth() });
  }

  async listDocs() { return (await requestJSON(`${this.directoryUrl}/docs`, { headers: this.auth() })).docs; }

  // ----------------------------------------------------------- connection
  /** Ask the Directory where to connect (this is also the failover step). */
  async _ticket(docId) {
    // Re-present our existing site id so the CRDT identity survives reconnects.
    const q = this.clientId ? `?clientId=${encodeURIComponent(this.clientId)}` : '';
    const t = await requestJSON(`${this.directoryUrl}/docs/${docId}/session${q}`, { headers: this.auth(), timeout: 3000 });
    if (this.preferReplica) {
      const pinned = (t.replicas || []).find((r) => r.id === this.preferReplica);
      if (pinned) t.primary = pinned;
      else this.log.warn('preferred_replica_unavailable', { want: this.preferReplica, using: t.primary.id });
    }
    if (this.replicaId && t.primary.id !== this.replicaId) {
      this.stats.failovers++;
      this.log.warn('failover', { from: this.replicaId, to: t.primary.id, docId });
      this.emit('failover', { from: this.replicaId, to: t.primary.id });
    }
    return t;
  }

  async open(docId, { timeoutMs = 8000 } = {}) {
    this.docId = docId;
    this._closedByUser = false;
    const ticket = await this._ticket(docId);
    // A reconnecting client keeps its CRDT state and its site id, so that the
    // ids it has already generated remain valid and unique.
    const resuming = !!this.doc;
    if (!resuming) {
      this.clientId = ticket.clientId;
      this.doc = new RGA(this.clientId);
    }
    this.role = ticket.role;
    this.title = ticket.title;

    return new Promise((resolve, reject) => {
      const url = ticket.primary.wsUrl.replace(/\/$/, '') + '/ws';
      const ws = new WebSocket(url, { handshakeTimeout: 3000 });
      this.ws = ws;
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} ; reject(new Error('open timeout')); }, timeoutMs);

      ws.on('open', () => {
        const hello = { t: MSG.HELLO, sessionToken: ticket.sessionToken, corr: 'hello-' + Date.now() };
        if (resuming) hello.knownVV = { ...this.doc.vv };
        ws.send(JSON.stringify(hello));
      });

      ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
        if (msg.t === MSG.WELCOME) {
          clearTimeout(timer);
          this.connected = true;
          this.backoff = 200;
          this.replicaId = msg.replicaId;
          this.title = msg.title;
          this.canEdit = msg.canEdit;
          if (msg.snapshot) this._adoptSnapshot(msg.snapshot);
          for (const op of msg.ops || []) this.doc.apply(op);
          this.presence = msg.presence || [];
          this.log.info('connected', { docId: this.docId, replica: this.replicaId, clientId: this.clientId, role: this.role, resumed: resuming, ops: (msg.ops || []).length });
          this.emit('open', { replicaId: this.replicaId, resumed: resuming });
          this.emit('change', this.text());
          this._flushOutbox();
          this._startAntiEntropy();
          resolve(this);
        } else if (msg.t === MSG.OPS) {
          let n = 0;
          for (const op of msg.ops || []) if (this.doc.apply(op) === 'applied') n++;
          this.stats.received += (msg.ops || []).length;
          if (n) this.emit('change', this.text());
        } else if (msg.t === MSG.SYNC) {
          // The replica may answer with a full state transfer when its log no
          // longer reaches back to our version vector (post-snapshot restore).
          if (msg.snapshot) this._adoptSnapshot(msg.snapshot);
          for (const op of msg.ops || []) this.doc.apply(op);
          this.emit('change', this.text());
          this.emit('synced', { ops: (msg.ops || []).length, fullState: !!msg.snapshot });
        } else if (msg.t === MSG.ACK) {
          this.stats.acked += msg.applied || 0;
          this.inflight.delete(msg.batchId);
          this.emit('ack', msg);
        } else if (msg.t === MSG.PRESENCE) {
          this.presence = msg.users || [];
          this.emit('presence', this.presence);
        } else if (msg.t === MSG.ERROR) {
          this.log.warn('server_error', { code: msg.code, message: msg.message });
          this.emit('error-msg', msg);
          if (msg.code === 401 || msg.code === 403) { clearTimeout(timer); reject(new Error(msg.message)); }
        } else if (msg.t === MSG.BYE) {
          this.log.warn('server_bye', { reason: msg.reason });
        }
      });

      ws.on('close', () => {
        const was = this.connected;
        this.connected = false;
        // Ops that were sent but never acknowledged must be retransmitted,
        // otherwise a mid-flight socket death would silently lose edits.
        if (this.inflight.size) {
          const lost = [];
          for (const ops of this.inflight.values()) lost.push(...ops);
          this.inflight.clear();
          this.outbox.unshift(...lost);
          this.log.warn('inflight_requeued', { ops: lost.length });
        }
        if (was) { this.log.warn('disconnected', { docId: this.docId, replica: this.replicaId }); this.emit('close'); }
        if (this.autoReconnect && !this._closedByUser) this._scheduleReconnect();
      });
      ws.on('error', (e) => { this.log.debug('socket_error', { err: e.message }); });
    });
  }

  /**
   * Anti-entropy: periodically tell the replica our version vector so it can
   * push anything we never received. A broadcast frame can be lost (unreliable
   * data plane, a replica crashing mid-broadcast, a slow socket), and the CRDT
   * only guarantees convergence for operations that actually *arrive*. This
   * background reconciliation is what turns "eventually delivered" into
   * "eventually consistent" and bounds the staleness window.
   */
  /**
   * Adopt a server state transfer while preserving our own site identity and
   * any locally authored operations the server has not acknowledged yet.
   */
  _adoptSnapshot(snapshot) {
    const mine = this.clientId;
    const rebuilt = RGA.fromSnapshot(mine, snapshot);
    rebuilt.counter = this.doc ? this.doc.counter : 0;
    const localOnly = this.doc ? this.doc.oplog.filter((o) => o.site === mine) : [];
    this.doc = rebuilt;
    for (const op of localOnly) this.doc.apply(op);
  }

  _startAntiEntropy() {
    if (this._aeTimer) return;
    const period = parseInt(process.env.ANTI_ENTROPY_MS || '2000', 10);
    this._aeTimer = setInterval(() => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) this.requestSync();
    }, period);
    this._aeTimer.unref?.();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = Math.min(this.backoff, 5000) * (0.7 + Math.random() * 0.6);
    this.backoff = Math.min(this.backoff * 2, 5000);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closedByUser) return;
      this.stats.reconnects++;
      try {
        await this.open(this.docId);
        this.log.info('reconnected', { docId: this.docId, replica: this.replicaId, attempt: this.stats.reconnects });
        this.emit('reconnected', { replicaId: this.replicaId });
      } catch (e) {
        this.log.warn('reconnect_failed', { err: e.message, nextDelayMs: Math.round(this.backoff) });
        this._scheduleReconnect();
      }
    }, delay);
    this._reconnectTimer.unref?.();
  }

  // -------------------------------------------------------------- editing
  text() { return this.doc ? this.doc.text() : ''; }

  insert(index, str) {
    const ops = this.doc.localInsertText(index, str);
    this._queue(ops);
    this.emit('change', this.text());
    return ops;
  }

  delete(index, count) {
    const ops = this.doc.localDeleteRange(index, count);
    this._queue(ops);
    this.emit('change', this.text());
    return ops;
  }

  _queue(ops) {
    if (!ops.length) return;
    this.outbox.push(...ops);
    this._flushOutbox();
  }

  _flushOutbox() {
    if (!this.connected || !this.outbox.length || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const ops = this.outbox.splice(0, Math.min(this.outbox.length, config.maxOpsPerMessage));
    const batchId = `${this.clientId}-b${++this.batchSeq}`;
    this.inflight.set(batchId, ops);
    this.ws.send(JSON.stringify({ t: MSG.OPS, docId: this.docId, ops, batchId, corr: batchId }));
    this.stats.sent += ops.length;
    if (this.outbox.length) setImmediate(() => this._flushOutbox());
  }

  /** Re-send everything not acknowledged (used after reconnect). */
  resendInflight() {
    for (const [batchId, ops] of this.inflight) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t: MSG.OPS, docId: this.docId, ops, batchId, corr: batchId + '-retry' }));
      }
    }
  }

  sendCursor(pos) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: MSG.CURSOR, docId: this.docId, pos }));
    }
  }

  requestSync() {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: MSG.SYNC, docId: this.docId, vv: { ...this.doc.vv }, corr: 'sync-' + Date.now() }));
    }
  }

  /** Simulate a network partition for this client (§8.4 disconnect a client). */
  killSocket() {
    if (this.ws) { try { this.ws.terminate(); } catch {} }
    this.connected = false;
  }

  close() {
    this._closedByUser = true;
    if (this._aeTimer) { clearInterval(this._aeTimer); this._aeTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.connected = false;
  }

  /**
   * Wait until `pred(text, client)` is true or the timeout elapses.
   * Event-driven: resolves on the very frame that satisfies the predicate, so
   * it can be used to measure true end-to-end propagation latency. A slow
   * safety poll also covers predicates that do not depend on document text
   * (e.g. connection state after a failover).
   */
  waitFor(pred, timeoutMs = 5000, label = 'condition') {
    return new Promise((resolve, reject) => {
      let done = false;
      const check = () => { try { return pred(this.text(), this); } catch { return false; } };
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearInterval(iv); clearTimeout(to);
        const i = this.handlers.change ? this.handlers.change.indexOf(onChange) : -1;
        if (i >= 0) this.handlers.change.splice(i, 1);
        fn(arg);
      };
      const onChange = () => { if (check()) finish(resolve, this.text()); };
      if (check()) return resolve(this.text());
      this.on('change', onChange);
      const iv = setInterval(() => { if (check()) finish(resolve, this.text()); }, 20);
      const to = setTimeout(() => finish(reject, new Error(`timeout waiting for ${label}; text=${JSON.stringify(this.text())}`)), timeoutMs);
      iv.unref?.(); to.unref?.();
    });
  }
}

module.exports = { CoEditClient, ROOT };
