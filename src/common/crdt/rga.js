'use strict';
/**
 * RGA (Replicated Growable Array) CRDT for collaborative plain-text editing.
 *
 * Reference: Roh, Jeon, Kim, Lee — "Replicated abstract data types: Building
 * blocks for collaborative applications", JPDC 71(3), 2011.
 * Implemented from the algorithm description by the project group (no library).
 *
 * Model
 * -----
 * The document is a doubly linked list of *elements*. Every element has a
 * globally unique identifier `site:counter` and is never physically removed:
 * a delete only flips the `del` (tombstone) flag. Therefore both operations
 * are idempotent and commutative, which is exactly what we need for
 * out-of-order / duplicated network delivery.
 *
 * Insertion rule (the part that makes concurrent inserts converge):
 *   integrate(e, afterId):
 *     p = node(afterId)                       // causal origin
 *     scan forward from p.next while the candidate c satisfies
 *         order(c) > order(e)                 // order = (lamport, siteId)
 *     insert e before the first candidate with a *smaller* order.
 *
 * Because a Lamport clock is monotonically increasing, every descendant of a
 * concurrent sibling has a strictly larger timestamp than the sibling itself,
 * so the scan skips whole subtrees atomically. Siblings inserted concurrently
 * after the same origin are ordered by descending (lamport, siteId), which is
 * a total order agreed on by every replica => strong eventual consistency.
 *
 * Causal readiness: an operation whose origin/target element is not present
 * yet is parked in `pending` and replayed as soon as the missing element
 * arrives. This tolerates arbitrary reordering of the network stream.
 * The parking area is *bounded* (capacity + TTL): an unauthenticated flood of
 * ops referencing non-existent origins must not grow the heap without limit.
 *
 * Log truncation and state transfer
 * ---------------------------------
 * A snapshot summarises state but NOT history: rebuilding from one yields an
 * empty `oplog`, so a delta computed with `missingFor()` would silently omit
 * everything that happened before the snapshot. `logFloor` records the version
 * vector that the snapshot folded in; `canServeDelta()` reports whether a
 * requester is recent enough to be served incrementally. When it is not, the
 * caller must fall back to a full state transfer (the snapshot itself) instead
 * of shipping a delta that is missing its prefix.
 */

const ROOT = 'ROOT';

/** Total order over elements: higher lamport first, ties broken by site id. */
function cmp(a, b) {
  if (a.lam !== b.lam) return a.lam - b.lam;
  return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
}

/** Bounds for the causal-readiness parking area (defence against a flood). */
const PENDING_MAX_OPS = 2000;      // hard cap on parked operations
const PENDING_TTL_MS = 30000;      // a dependency that never arrives is dropped

class RGA {
  /**
   * @param {string} siteId globally unique replica / client identity
   * @param {{pendingMaxOps?:number, pendingTtlMs?:number, onDrop?:Function}} [opts]
   */
  constructor(siteId, opts = {}) {
    this.siteId = siteId;
    this.lamport = 0;       // Lamport logical clock
    this.counter = 0;       // per-site monotonic operation counter
    this.head = { id: ROOT, site: '', lam: -1, ch: '', del: true, prev: null, next: null };
    this.nodes = new Map([[ROOT, this.head]]);
    this.vv = Object.create(null);   // version vector  site -> highest ctr applied
    this.applied = new Set();        // op ids already applied (deduplication)
    this.oplog = [];                 // ops in application order (for delta sync)
    this.pending = new Map();        // missingElementId -> [{op, at}, ...]
    this.length = 0;                 // number of *visible* characters

    /**
     * Lower bound of the history this replica can still replay. Empty means
     * "the log starts at the beginning of time", i.e. any delta is complete.
     * After fromSnapshot() it holds the snapshot's version vector.
     */
    this.logFloor = Object.create(null);

    this.pendingMaxOps = opts.pendingMaxOps || PENDING_MAX_OPS;
    this.pendingTtlMs = opts.pendingTtlMs || PENDING_TTL_MS;
    this.onDrop = opts.onDrop || null;   // (reason, op) -> void, for structured logging
    this.droppedPending = 0;
    this._pendingOps = 0;
  }

  // ---------------------------------------------------------------- helpers
  _tick(remoteLamport) {
    this.lamport = Math.max(this.lamport, remoteLamport || 0) + 1;
    return this.lamport;
  }

  /** Visible text of the document. */
  text() {
    let out = '';
    for (let n = this.head.next; n; n = n.next) if (!n.del) out += n.ch;
    return out;
  }

  /** Element id that precedes visible position `index` (0 = beginning). */
  idAtPosition(index) {
    if (index <= 0) return ROOT;
    let seen = 0;
    for (let n = this.head.next; n; n = n.next) {
      if (n.del) continue;
      seen++;
      if (seen === index) return n.id;
    }
    return this._lastId();
  }

  /** Element id of the visible character at `index` (0-based), or null. */
  idOfVisible(index) {
    let seen = 0;
    for (let n = this.head.next; n; n = n.next) {
      if (n.del) continue;
      if (seen === index) return n.id;
      seen++;
    }
    return null;
  }

  /** Visible offset of an element id (used to place remote cursors). */
  positionOfId(id) {
    if (id === ROOT) return 0;
    let seen = 0;
    for (let n = this.head.next; n; n = n.next) {
      if (n.del) continue;
      seen++;
      if (n.id === id) return seen;
    }
    return seen;
  }

  _lastId() {
    let last = this.head;
    for (let n = this.head.next; n; n = n.next) if (!n.del) last = n;
    return last.id;
  }

  // ------------------------------------------------------- local operations
  /** Generate (and apply) an insert of a single character after `afterId`. */
  localInsert(afterId, ch) {
    const op = {
      t: 'ins',
      site: this.siteId,
      ctr: ++this.counter,
      lam: this._tick(0),
      after: afterId,
      ch,
    };
    op.id = `${op.site}:${op.ctr}`;
    this.apply(op);
    return op;
  }

  /** Generate (and apply) a delete of the element `targetId`. */
  localDelete(targetId) {
    const op = {
      t: 'del',
      site: this.siteId,
      ctr: ++this.counter,
      lam: this._tick(0),
      target: targetId,
    };
    op.id = `${op.site}:${op.ctr}`;
    this.apply(op);
    return op;
  }

  /** Convenience: insert a whole string at a visible offset. Returns ops. */
  localInsertText(index, str) {
    const ops = [];
    let after = this.idAtPosition(index);
    for (const ch of str) {
      const op = this.localInsert(after, ch);
      ops.push(op);
      after = op.id;
    }
    return ops;
  }

  /** Convenience: delete `count` visible chars starting at offset. */
  localDeleteRange(index, count) {
    const ops = [];
    const ids = [];
    let seen = 0;
    for (let n = this.head.next; n && ids.length < count; n = n.next) {
      if (n.del) continue;
      if (seen >= index) ids.push(n.id);
      seen++;
    }
    for (const id of ids) ops.push(this.localDelete(id));
    return ops;
  }

  // ------------------------------------------------------ remote operations
  /**
   * Apply a (local or remote) operation.
   * @returns {'applied'|'duplicate'|'pending'}
   */
  apply(op) {
    if (this.applied.has(op.id)) return 'duplicate';          // idempotence
    if (op.t === 'ins') {
      if (!this.nodes.has(op.after)) return this._park(op.after, op);
      this._integrate(op);
    } else if (op.t === 'del') {
      if (!this.nodes.has(op.target)) return this._park(op.target, op);
      const n = this.nodes.get(op.target);
      if (!n.del) { n.del = true; this.length--; }
      this.lamport = Math.max(this.lamport, op.lam);
    } else {
      throw new Error('unknown op type ' + op.t);
    }
    this.applied.add(op.id);
    this.oplog.push(op);
    const cur = this.vv[op.site] || 0;
    if (op.ctr > cur) this.vv[op.site] = op.ctr;
    this._drain(op.t === 'ins' ? op.id : op.target);
    return 'applied';
  }

  /**
   * Park an op until its causal dependency shows up — subject to a TTL and a
   * hard capacity limit, so that operations referencing origins that will
   * NEVER arrive cannot be used to exhaust memory (bounded queue, §4.5).
   */
  _park(missingId, op) {
    this._expirePending();
    if (this._pendingOps >= this.pendingMaxOps) {
      // Shed the oldest waiter rather than the newcomer: a genuine reorder is
      // repaired within milliseconds, so old entries are the likely garbage.
      if (!this._evictOldestPending()) {
        this.droppedPending++;
        if (this.onDrop) this.onDrop('pending_overflow', op);
        return 'dropped';
      }
    }
    if (!this.pending.has(missingId)) this.pending.set(missingId, []);
    this.pending.get(missingId).push({ op, at: Date.now() });
    this._pendingOps++;
    return 'pending';
  }

  /** Discard parked ops whose dependency never materialised within the TTL. */
  _expirePending() {
    if (!this._pendingOps) return;
    const cutoff = Date.now() - this.pendingTtlMs;
    for (const [id, arr] of this.pending) {
      let i = 0;
      while (i < arr.length && arr[i].at < cutoff) i++;
      if (i === 0) continue;
      const expired = arr.splice(0, i);
      this._pendingOps -= expired.length;
      this.droppedPending += expired.length;
      if (this.onDrop) for (const e of expired) this.onDrop('pending_expired', e.op);
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
    const [evicted] = arr.splice(0, 1);
    this._pendingOps--;
    this.droppedPending++;
    if (this.onDrop) this.onDrop('pending_overflow', evicted.op);
    if (!arr.length) this.pending.delete(oldestId);
    return true;
  }

  /** Replay operations that were waiting for `id` to appear. */
  _drain(id) {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    this._pendingOps -= waiting.length;
    for (const entry of waiting) this.apply(entry.op);
  }

  _integrate(op) {
    const el = { id: op.id, site: op.site, lam: op.lam, ch: op.ch, del: false, prev: null, next: null };
    this.lamport = Math.max(this.lamport, op.lam);
    const origin = this.nodes.get(op.after);
    let c = origin.next;
    while (c && cmp(c, el) > 0) c = c.next;      // skip higher-ordered subtrees
    const prev = c ? c.prev : this._tail();
    el.prev = prev;
    el.next = prev.next;
    if (prev.next) prev.next.prev = el;
    prev.next = el;
    this.nodes.set(el.id, el);
    this.length++;
  }

  _tail() {
    let n = this.head;
    while (n.next) n = n.next;
    return n;
  }

  // ------------------------------------------------------------ delta sync
  /** Ops this replica knows that the peer (described by `remoteVV`) lacks. */
  missingFor(remoteVV) {
    const out = [];
    for (const op of this.oplog) {
      if (op.ctr > (remoteVV[op.site] || 0)) out.push(op);
    }
    return out;
  }

  /** Number of operations still waiting for a causal dependency. */
  pendingCount() {
    let n = 0;
    for (const arr of this.pending.values()) n += arr.length;
    return n;
  }

  /**
   * Can a delta computed by `missingFor(remoteVV)` be *complete* for this
   * requester? It cannot when the requester is older than the point at which
   * our log was truncated by a snapshot: the ops between `remoteVV` and
   * `logFloor` no longer exist here. Callers MUST fall back to a full state
   * transfer in that case instead of silently shipping a partial delta.
   */
  canServeDelta(remoteVV) {
    const rv = remoteVV || {};
    for (const site of Object.keys(this.logFloor)) {
      if ((rv[site] || 0) < this.logFloor[site]) return false;
    }
    return true;
  }

  // ------------------------------------------------------------- snapshots
  /**
   * A snapshot carries both the materialised state AND the operation history,
   * so that a replica restored from it can still answer delta requests from
   * clients that were offline before the snapshot was taken. `logFloor` marks
   * how far back the embedded history reaches.
   */
  snapshot() {
    const elements = [];
    for (let n = this.head.next; n; n = n.next) {
      elements.push([n.id, n.site, n.lam, n.ch, n.del ? 1 : 0]);
    }
    return {
      v: 2,
      lamport: this.lamport,
      vv: { ...this.vv },
      elements,
      oplog: this.oplog,
      logFloor: { ...this.logFloor },
    };
  }

  static fromSnapshot(siteId, snap, opts = {}) {
    const doc = new RGA(siteId, opts);
    if (!snap) return doc;
    doc.lamport = snap.lamport || 0;
    doc.vv = Object.assign(Object.create(null), snap.vv || {});
    let prev = doc.head;
    for (const [id, site, lam, ch, del] of snap.elements || []) {
      const el = { id, site, lam, ch, del: !!del, prev, next: null };
      prev.next = el;
      prev = el;
      doc.nodes.set(id, el);
      if (!el.del) doc.length++;
      doc.applied.add(id);
    }

    if (Array.isArray(snap.oplog)) {
      // v2 snapshot: history travels with the state, so delta sync keeps
      // working across a restart for clients that predate the snapshot.
      doc.oplog = snap.oplog.slice();
      for (const op of doc.oplog) doc.applied.add(op.id);
      doc.logFloor = Object.assign(Object.create(null), snap.logFloor || {});
    } else {
      // v1 snapshot (legacy, history lost). Record the truncation point so
      // that canServeDelta() refuses to serve an incomplete delta instead of
      // corrupting the requester silently.
      doc.logFloor = Object.assign(Object.create(null), snap.vv || {});
    }

    // A snapshot summarises applied inserts; deletes are folded into `del`.
    doc.counter = doc.vv[siteId] || 0;   // never reuse an id after recovery
    return doc;
  }
}

module.exports = { RGA, ROOT, cmp };
