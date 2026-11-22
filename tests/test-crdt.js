'use strict';
/**
 * Property-based tests for the RGA CRDT itself (no network involved).
 * Runs randomised concurrent histories and checks the three SEC properties:
 *   commutativity, idempotence, and convergence.
 *
 *   node tests/test-crdt.js
 */
const { RGA, ROOT } = require('../src/common/crdt/rga');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
}
const shuffle = (a, rnd) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const sync = (a, b) => { for (const op of a.missingFor(b.vv)) b.apply(op); for (const op of b.missingFor(a.vv)) a.apply(op); };

console.log('\n\x1b[1m▍RGA CRDT property tests\x1b[0m');

// 1 — deterministic tie-breaking
{
  const a = new RGA('a'); a.localInsertText(0, 'AB');
  // No manual oplog patching: a v2 snapshot carries the history with it.
  const b = RGA.fromSnapshot('b', a.snapshot());
  const c = RGA.fromSnapshot('c', a.snapshot());
  const ob = b.localInsert(a.oplog[0].id, 'X');
  const oc = c.localInsert(a.oplog[0].id, 'Y');
  b.apply(oc); c.apply(ob);
  check('concurrent inserts after the same origin converge', b.text() === c.text(), `${b.text()} vs ${c.text()}`);
}

// 2 — randomised 3-way concurrent histories
{
  let allOk = true, sample = '';
  for (let seed = 0; seed < 60; seed++) {
    const rnd = mulberry(seed);
    const sites = ['s1', 's2', 's3'].map((s) => new RGA(s));
    const base = sites[0];
    base.localInsertText(0, 'lorem ipsum');
    for (const s of sites.slice(1)) for (const op of base.oplog) s.apply(op);
    const generated = [];
    for (const s of sites) {
      const n = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.65 || s.length === 0) generated.push(...s.localInsertText(Math.floor(rnd() * (s.length + 1)), String.fromCharCode(65 + Math.floor(rnd() * 26))));
        else generated.push(...s.localDeleteRange(Math.floor(rnd() * s.length), 1));
      }
    }
    // deliver everything to everyone, in a different random order per site
    for (const s of sites) for (const op of shuffle(generated, rnd)) s.apply(op);
    const texts = sites.map((s) => s.text());
    if (!texts.every((t) => t === texts[0]) || sites.some((s) => s.pendingCount() > 0)) { allOk = false; sample = JSON.stringify(texts); break; }
  }
  check('60 randomised 3-way concurrent histories converge', allOk, sample);
}

// 3 — idempotence
{
  const a = new RGA('a'); a.localInsertText(0, 'idempotent');
  const b = new RGA('b');
  for (const op of a.oplog) b.apply(op);
  for (const op of a.oplog) b.apply(op);   // replay everything again
  for (const op of a.oplog) b.apply(op);
  check('applying the same operations 3× is idempotent', b.text() === 'idempotent', b.text());
}

// 4 — causal readiness (dependencies delivered last)
{
  const a = new RGA('a'); a.localInsertText(0, 'causal');
  const b = new RGA('b');
  for (const op of [...a.oplog].reverse()) b.apply(op);   // strictly reverse order
  check('reverse-order delivery still converges', b.text() === 'causal', b.text());
  check('no operation left parked', b.pendingCount() === 0, String(b.pendingCount()));
}

// 5 — snapshot round-trip
{
  const a = new RGA('a');
  a.localInsertText(0, 'snapshot me');
  a.localDeleteRange(0, 9);
  const r = RGA.fromSnapshot('r', a.snapshot());
  check('snapshot round-trip preserves visible text', r.text() === a.text(), `${r.text()} vs ${a.text()}`);
  check('snapshot preserves the version vector', JSON.stringify(r.vv) === JSON.stringify(a.vv));
}

// 6 — delta sync
{
  const a = new RGA('a'), b = new RGA('b');
  a.localInsertText(0, 'alpha');
  b.localInsertText(0, 'beta');
  sync(a, b);
  check('bidirectional delta sync converges', a.text() === b.text(), `${a.text()} vs ${b.text()}`);
  check('missingFor returns nothing once synced', a.missingFor(b.vv).length === 0 && b.missingFor(a.vv).length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
