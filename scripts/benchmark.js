#!/usr/bin/env node
'use strict';
/**
 * Scalability experiment (§9 "1 performance or scalability experiment").
 * Sweeps the number of concurrent editors and records, for each point:
 *   • end-to-end propagation latency (p50 / p95) of a single operation,
 *   • sustained operation throughput,
 *   • convergence delay after the last operation,
 *   • correctness (no lost operations, all replicas identical).
 *
 *   node scripts/benchmark.js            # default sweep 2,4,8,12
 *   BENCH_CLIENTS=2,4,8,16 BENCH_OPS=60 node scripts/benchmark.js
 *
 * Writes docs/benchmark.json, consumed by scripts/make-figures.py.
 */
process.env.COEDIT_ENV_FILE = process.env.COEDIT_ENV_FILE || require('path').join(__dirname, '../.env');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CoEditClient } = require('../src/client/engine');
const { config } = require('../src/common/util/config');
const { requestJSON } = require('../src/common/util/http');
const { createLogger } = require('../src/common/util/log');

const quiet = createLogger('bench', { level: 'error' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = () => crypto.randomBytes(4).toString('hex');
const PW = 'password123';

const SWEEP = (process.env.BENCH_CLIENTS || '2,4,8,12').split(',').map((n) => parseInt(n, 10));
const OPS = parseInt(process.env.BENCH_OPS || '50', 10);
const PROBES = parseInt(process.env.BENCH_PROBES || '15', 10);

async function converge(clients, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = clients.map((c) => c.text());
    if (t.every((x) => x === t[0])) return t[0];
    await sleep(30);
  }
  throw new Error('no convergence');
}

async function runPoint(N, reps) {
  const users = [];
  for (let i = 0; i < N; i++) {
    const c = new CoEditClient({ username: `b${uniq()}`, password: PW, logger: quiet, preferReplica: reps[i % reps.length].id });
    await c.register(); await c.login();
    users.push(c);
  }
  const owner = users[0];
  const docId = await owner.createDoc(`bench-${N}`);
  for (const u of users.slice(1)) await owner.share(docId, u.username, 'editor');
  for (const u of users) await u.open(docId);
  await sleep(300);

  // ---- latency probes -----------------------------------------------------
  const lat = [];
  for (let i = 0; i < PROBES; i++) {
    const marker = `\u00a7${i}\u00a7`;
    const t0 = process.hrtime.bigint();
    owner.insert(0, marker);
    await Promise.all(users.slice(1).map((u) => u.waitFor((t) => t.includes(marker), 15000, 'probe')));
    lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep(50);
  }
  lat.sort((a, b) => a - b);
  const pick = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];

  // ---- throughput ---------------------------------------------------------
  const before = owner.text().length;
  const t1 = Date.now();
  for (let i = 0; i < OPS; i++) {
    for (const u of users) u.insert(u.text().length, String(i % 10));
    await sleep(3);
  }
  const submitMs = Date.now() - t1;
  const tc = Date.now();
  const finalText = await converge(users);
  const convergeMs = Date.now() - tc;

  const perReplica = [];
  for (const r of reps) {
    const port = new URL(r.wsUrl.replace('ws', 'http')).port;
    const v = await requestJSON(`http://127.0.0.1:${port}/internal/docs/${docId}/text`, { headers: { 'x-internal-key': config.internalKey } });
    perReplica.push({ id: r.id, same: v.text === finalText });
  }

  const total = N * OPS;
  const lost = (before + total) - finalText.length;
  for (const u of users) u.close();
  await sleep(200);

  return {
    clients: N, opsPerClient: OPS, totalOps: total,
    latencyP50: +pick(0.5).toFixed(1), latencyP95: +pick(0.95).toFixed(1),
    latencyMin: +lat[0].toFixed(1), latencyMax: +lat[lat.length - 1].toFixed(1),
    submitMs, throughput: Math.round(total / (submitMs / 1000)),
    convergeMs, finalLength: finalText.length, lostOps: lost,
    allReplicasIdentical: perReplica.every((r) => r.same),
  };
}

(async () => {
  const reps = (await requestJSON(`${config.directoryUrl}/registry/replicas`)).replicas;
  console.log(`\nScalability sweep over ${reps.length} replica(s): ${reps.map((r) => r.id).join(', ')}`);
  console.log(`clients=${SWEEP.join(',')}  ops/client=${OPS}  latency probes=${PROBES}\n`);
  console.log('  N   lat_p50  lat_p95   ops/s   converge   lost   replicas_equal');
  console.log('  ' + '─'.repeat(64));
  const rows = [];
  for (const N of SWEEP) {
    const r = await runPoint(N, reps);
    rows.push(r);
    console.log(`  ${String(r.clients).padStart(2)}   ${String(r.latencyP50).padStart(6)}ms ${String(r.latencyP95).padStart(6)}ms  ${String(r.throughput).padStart(6)}   ${String(r.convergeMs).padStart(6)}ms   ${String(r.lostOps).padStart(4)}   ${r.allReplicasIdentical ? 'yes' : 'NO'}`);
  }
  const out = { generatedAt: new Date().toISOString(), replicas: reps.length, opsPerClient: OPS, rows };
  fs.mkdirSync(path.join(__dirname, '../docs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../docs/benchmark.json'), JSON.stringify(out, null, 2));
  console.log(`\n  → docs/benchmark.json written\n`);
  process.exit(0);
})().catch((e) => { console.error('benchmark failed: ' + e.message); process.exit(1); });
