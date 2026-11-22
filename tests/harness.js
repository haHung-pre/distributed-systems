'use strict';
/**
 * Minimal test harness (no external test framework, so the grader only needs
 * `npm install ws`). Produces a human-readable table plus a machine-readable
 * JSON report at tests/report.json used by docs/report.pdf.
 */
const fs = require('fs');
const path = require('path');

const suites = [];
let current = null;

function suite(name, fn) { current = { name, tests: [] }; suites.push(current); fn(); current = null; }
function test(id, name, fn, opts = {}) { current.tests.push({ id, name, fn, timeout: opts.timeout || 30000, category: current.name }); }

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'assertEqual'}\n      expected: ${e}\n      actual:   ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
async function throwsAsync(fn, rx, msg) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error(msg || 'expected an error but none was thrown');
  if (rx && !rx.test(threw.message)) throw new Error(`${msg || 'wrong error'}: got "${threw.message}"`);
  return threw;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const results = [];
  let pass = 0, fail = 0;
  const t0 = Date.now();
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  for (const s of suites) {
    console.log(`\n\x1b[1m▍${s.name}\x1b[0m`);
    for (const t of s.tests) {
      if (only.length && !only.some((o) => t.id.includes(o) || t.name.toLowerCase().includes(o.toLowerCase()))) continue;
      const start = Date.now();
      let status = 'pass', err = null, notes = [];
      const note = (m) => notes.push(m);
      try {
        await Promise.race([
          t.fn({ note }),
          sleep(t.timeout).then(() => { throw new Error(`test timed out after ${t.timeout}ms`); }),
        ]);
        pass++;
      } catch (e) {
        status = 'fail'; err = e.message; fail++;
      }
      const ms = Date.now() - start;
      results.push({ id: t.id, name: t.name, category: t.category, status, ms, error: err, notes });
      const icon = status === 'pass' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`  ${icon} ${t.id.padEnd(7)} ${t.name} \x1b[90m(${ms}ms)\x1b[0m`);
      for (const n of notes) console.log(`      \x1b[90m· ${n}\x1b[0m`);
      if (err) console.log(`      \x1b[31m${err}\x1b[0m`);
    }
  }

  const totalMs = Date.now() - t0;
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  ${pass} passed, ${fail} failed, ${results.length} total  (${(totalMs / 1000).toFixed(1)}s)`);
  console.log('─'.repeat(64));

  const report = { generatedAt: new Date().toISOString(), pass, fail, total: results.length, durationMs: totalMs, results };
  fs.mkdirSync(path.join(__dirname), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`  report written to tests/report.json\n`);
  process.exit(fail ? 1 : 0);
}

module.exports = { suite, test, eq, ok, throwsAsync, sleep, run };
