/**
 * Browser build of the RGA CRDT.
 * Identical algorithm to src/common/crdt/rga.js (kept in sync by
 * tests/test-parity.js which diff-checks the two implementations' behaviour).
 */
(function (global) {
  'use strict';
  const ROOT = 'ROOT';

  function cmp(a, b) {
    if (a.lam !== b.lam) return a.lam - b.lam;
    return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
  }

  class RGA {
    constructor(siteId, opts) {
      opts = opts || {};
      this.siteId = siteId;
      this.lamport = 0;
      this.counter = 0;
      this.head = { id: ROOT, site: '', lam: -1, ch: '', del: true, prev: null, next: null };
      this.nodes = new Map([[ROOT, this.head]]);
      this.vv = Object.create(null);
      this.applied = new Set();
      this.oplog = [];
      this.pending = new Map();
      this.length = 0;
      this.logFloor = Object.create(null);
      this.pendingMaxOps = opts.pendingMaxOps || 2000;
      this.pendingTtlMs = opts.pendingTtlMs || 30000;
      this.droppedPending = 0;
      this._pendingOps = 0;
    }
    _tick(r) { this.lamport = Math.max(this.lamport, r || 0) + 1; return this.lamport; }
    text() { let s = ''; for (let n = this.head.next; n; n = n.next) if (!n.del) s += n.ch; return s; }
    idAtPosition(i) {
      if (i <= 0) return ROOT;
      let seen = 0;
      for (let n = this.head.next; n; n = n.next) { if (n.del) continue; seen++; if (seen === i) return n.id; }
      return this._lastId();
    }
    positionOfId(id) {
      if (id === ROOT) return 0;
      let seen = 0;
      for (let n = this.head.next; n; n = n.next) { if (n.del) continue; seen++; if (n.id === id) return seen; }
      return seen;
    }
    _lastId() { let last = this.head; for (let n = this.head.next; n; n = n.next) if (!n.del) last = n; return last.id; }
    localInsert(after, ch) {
      const op = { t: 'ins', site: this.siteId, ctr: ++this.counter, lam: this._tick(0), after, ch };
      op.id = op.site + ':' + op.ctr; this.apply(op); return op;
    }
    localDelete(target) {
      const op = { t: 'del', site: this.siteId, ctr: ++this.counter, lam: this._tick(0), target };
      op.id = op.site + ':' + op.ctr; this.apply(op); return op;
    }
    localInsertText(index, str) {
      const ops = []; let after = this.idAtPosition(index);
      for (const ch of str) { const op = this.localInsert(after, ch); ops.push(op); after = op.id; }
      return ops;
    }
    localDeleteRange(index, count) {
      const ids = []; let seen = 0;
      for (let n = this.head.next; n && ids.length < count; n = n.next) {
        if (n.del) continue;
        if (seen >= index) ids.push(n.id);
        seen++;
      }
      return ids.map((id) => this.localDelete(id));
    }
    apply(op) {
      if (this.applied.has(op.id)) return 'duplicate';
      if (op.t === 'ins') {
        if (!this.nodes.has(op.after)) return this._park(op.after, op);
        this._integrate(op);
      } else if (op.t === 'del') {
        if (!this.nodes.has(op.target)) return this._park(op.target, op);
        const n = this.nodes.get(op.target);
        if (!n.del) { n.del = true; this.length--; }
        this.lamport = Math.max(this.lamport, op.lam);
      } else return 'duplicate';
      this.applied.add(op.id);
      this.oplog.push(op);
      if (op.ctr > (this.vv[op.site] || 0)) this.vv[op.site] = op.ctr;
      this._drain(op.t === 'ins' ? op.id : op.target);
      return 'applied';
    }
    _park(missing, op) {
      this._expirePending();
      if (this._pendingOps >= this.pendingMaxOps && !this._evictOldestPending()) {
        this.droppedPending++;
        return 'dropped';
      }
      if (!this.pending.has(missing)) this.pending.set(missing, []);
      this.pending.get(missing).push({ op, at: Date.now() });
      this._pendingOps++;
      return 'pending';
    }
    _expirePending() {
      if (!this._pendingOps) return;
      const cutoff = Date.now() - this.pendingTtlMs;
      for (const [id, arr] of this.pending) {
        let i = 0;
        while (i < arr.length && arr[i].at < cutoff) i++;
        if (!i) continue;
        this._pendingOps -= arr.splice(0, i).length;
        this.droppedPending += i;
        if (!arr.length) this.pending.delete(id);
      }
    }
    _evictOldestPending() {
      let oldestId = null, oldestAt = Infinity;
      for (const [id, arr] of this.pending) {
        if (arr.length && arr[0].at < oldestAt) { oldestAt = arr[0].at; oldestId = id; }
      }
      if (oldestId === null) return false;
      const arr = this.pending.get(oldestId);
      arr.splice(0, 1);
      this._pendingOps--;
      this.droppedPending++;
      if (!arr.length) this.pending.delete(oldestId);
      return true;
    }
    _drain(id) {
      const w = this.pending.get(id);
      if (!w) return;
      this.pending.delete(id);
      this._pendingOps -= w.length;
      for (const e of w) this.apply(e.op);
    }
    _integrate(op) {
      const el = { id: op.id, site: op.site, lam: op.lam, ch: op.ch, del: false, prev: null, next: null };
      this.lamport = Math.max(this.lamport, op.lam);
      const origin = this.nodes.get(op.after);
      let c = origin.next;
      while (c && cmp(c, el) > 0) c = c.next;
      const prev = c ? c.prev : this._tail();
      el.prev = prev; el.next = prev.next;
      if (prev.next) prev.next.prev = el;
      prev.next = el;
      this.nodes.set(el.id, el);
      this.length++;
    }
    _tail() { let n = this.head; while (n.next) n = n.next; return n; }
    missingFor(remoteVV) { return this.oplog.filter((op) => op.ctr > (remoteVV[op.site] || 0)); }
    pendingCount() { let n = 0; for (const a of this.pending.values()) n += a.length; return n; }
    canServeDelta(remoteVV) {
      const rv = remoteVV || {};
      for (const site of Object.keys(this.logFloor)) {
        if ((rv[site] || 0) < this.logFloor[site]) return false;
      }
      return true;
    }
    snapshot() {
      const elements = [];
      for (let n = this.head.next; n; n = n.next) elements.push([n.id, n.site, n.lam, n.ch, n.del ? 1 : 0]);
      return {
        v: 2, lamport: this.lamport, vv: Object.assign({}, this.vv), elements,
        oplog: this.oplog, logFloor: Object.assign({}, this.logFloor),
      };
    }
    static fromSnapshot(siteId, snap) {
      const doc = new RGA(siteId);
      if (!snap) return doc;
      doc.lamport = snap.lamport || 0;
      doc.vv = Object.assign(Object.create(null), snap.vv || {});
      let prev = doc.head;
      for (const e of snap.elements || []) {
        const el = { id: e[0], site: e[1], lam: e[2], ch: e[3], del: !!e[4], prev, next: null };
        prev.next = el; prev = el;
        doc.nodes.set(el.id, el);
        if (!el.del) doc.length++;
        doc.applied.add(el.id);
      }
      if (Array.isArray(snap.oplog)) {
        doc.oplog = snap.oplog.slice();
        for (const op of doc.oplog) doc.applied.add(op.id);
        doc.logFloor = Object.assign(Object.create(null), snap.logFloor || {});
      } else {
        doc.logFloor = Object.assign(Object.create(null), snap.vv || {});
      }
      doc.counter = doc.vv[siteId] || 0;
      return doc;
    }
  }
  global.RGA = RGA;
  global.RGA_ROOT = ROOT;
})(window);
