#!/usr/bin/env node
'use strict';
/**
 * Scripted walkthrough of EVERY mandatory demonstration scenario of §8.4.
 * Intended to be projected during the defence: it narrates each step, prints
 * the text held by each client, and asserts convergence as it goes.
 *
 *   ./scripts/start-cluster.sh 2
 *   node scripts/demo.js
 */
process.env.COEDIT_ENV_FILE = process.env.COEDIT_ENV_FILE || require('path').join(__dirname, '../.env');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { CoEditClient } = require('../src/client/engine');
const { config } = require('../src/common/util/config');
const { requestJSON } = require('../src/common/util/http');
const { createLogger } = require('../src/common/util/log');

const quiet = createLogger('demo', { level: 'error' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = () => crypto.randomBytes(3).toString('hex');
const PW = 'password123';

let step = 0;
const C = { b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[90m', x: '\x1b[0m' };

function head(title) {
  step++;
  console.log(`\n${C.b}${C.c}━━━ Scenario ${step}: ${title} ${'━'.repeat(Math.max(0, 56 - title.length))}${C.x}`);
}
function say(msg) { console.log(`  ${C.d}${msg}${C.x}`); }
function show(clients) {
  for (const c of clients) {
    const tag = `${c.username}@${c.replicaId || '-'}`;
    console.log(`    ${tag.padEnd(26)} ${C.y}${JSON.stringify(c.text())}${C.x}`);
  }
}
function verdict(okCond, msg) {
  console.log(okCond ? `  ${C.g}✓ ${msg}${C.x}` : `  ${C.r}✗ ${msg}${C.x}`);
  if (!okCond) process.exitCode = 1;
}
async function converged(clients, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = clients.map((c) => c.text());
    if (t.every((x) => x === t[0])) return true;
    await sleep(50);
  }
  return false;
}
async function mk(name, preferReplica) {
  const c = new CoEditClient({ username: `${name}${uniq()}`, password: PW, logger: quiet, preferReplica });
  await c.register(); await c.login();
  return c;
}
async function replicas() { return (await requestJSON(`${config.directoryUrl}/registry/replicas`)).replicas; }

(async () => {
  console.log(`${C.b}\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║   CoEdit-DS — DS04 Collaborative Document Editing (RGA CRDT)     ║`);
  console.log(`║   Mandatory demonstration scenarios, §8.4                        ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝${C.x}`);

  const reps = await replicas();
  if (reps.length < 2) { console.error(`${C.r}Need >= 2 replicas: ./scripts/start-cluster.sh 2${C.x}`); process.exit(1); }
  say(`live collaboration replicas: ${reps.map((r) => r.id).join(', ')}`);

  /* ------------------------------------------------------------------ 1 */
  head('Three clients open the same document');
  const alice = await mk('alice', reps[0].id);
  const bob = await mk('bob', reps[1].id);
  const carol = await mk('carol', reps[0].id);
  const docId = await alice.createDoc('Defence demo document');
  await alice.share(docId, bob.username, 'editor');
  await alice.share(docId, carol.username, 'editor');
  await alice.open(docId); await bob.open(docId); await carol.open(docId);
  const all = [alice, bob, carol];
  await sleep(400);
  say(`document ${docId}`);
  say(`alice → ${alice.replicaId} | bob → ${bob.replicaId} | carol → ${carol.replicaId}  (two different replicas!)`);
  verdict(alice.presence.length === 3, `3 active users visible in presence: ${alice.presence.map((p) => p.username).join(', ')}`);

  /* ------------------------------------------------------------------ 2 */
  head('One client edits, the others receive the update');
  alice.insert(0, 'Distributed Systems 2026');
  await sleep(600);
  show(all);
  verdict(await converged(all) && bob.text() === 'Distributed Systems 2026', 'the edit reached both peers (across replicas)');

  /* ------------------------------------------------------------------ 3 */
  head('Two clients insert at the SAME position simultaneously');
  say('alice and bob both insert at offset 20 without seeing each other');
  alice.insert(20, '[alice]');
  bob.insert(20, '[bob]');
  await sleep(900);
  show(all);
  const t3 = alice.text();
  verdict(await converged(all), 'all three clients converged to one text');
  verdict(t3.includes('[alice]') && t3.includes('[bob]'), 'neither insertion was lost (no last-writer-wins)');

  /* ------------------------------------------------------------------ 4 */
  head('One client inserts while another deletes');
  say('carol deletes "Distributed " while bob inserts "<<>>" further right');
  carol.delete(0, 12);
  bob.insert(bob.text().length, '<<>>');
  await sleep(900);
  show(all);
  verdict(await converged(all), 'insert/delete conflict converged');
  verdict(!alice.text().includes('Distributed ') && alice.text().includes('<<>>'), 'delete applied and concurrent insert preserved');

  /* ------------------------------------------------------------------ 5 */
  head('Convergence check across clients AND replicas');
  const textNow = alice.text();
  const perReplica = [];
  for (const r of reps) {
    const port = new URL(r.wsUrl.replace('ws', 'http')).port;
    const v = await requestJSON(`http://127.0.0.1:${port}/internal/docs/${docId}/text`, { headers: { 'x-internal-key': config.internalKey } });
    perReplica.push({ id: r.id, same: v.text === textNow, len: v.text.length });
  }
  for (const p of perReplica) say(`${p.id}: ${p.len} chars, identical=${p.same}`);
  verdict(perReplica.every((p) => p.same), 'every server replica holds byte-identical text');

  /* ------------------------------------------------------------------ 6 */
  head('Disconnect one client; the others keep editing');
  say('carol is hard-disconnected (socket terminated, no FIN)');
  carol.autoReconnect = false;
  carol.killSocket();
  await sleep(300);
  alice.insert(alice.text().length, ' +while-carol-away');
  bob.insert(0, 'BOB> ');
  await sleep(700);
  show([alice, bob, carol]);
  verdict(await converged([alice, bob]), 'the remaining clients continued to work and stayed converged');
  verdict(!carol.text().includes('while-carol-away'), 'the disconnected client did not receive the updates');

  /* ------------------------------------------------------------------ 7 */
  head('The disconnected client reconnects and re-synchronises');
  say('carol edits OFFLINE first — those ops are buffered locally');
  carol.insert(0, 'CAROL-OFFLINE> ');
  say(`carol has ${carol.outbox.length} operation(s) queued in her outbox`);
  carol.autoReconnect = true;
  const tRe = Date.now();
  await carol.open(docId);
  await sleep(900);
  show(all);
  verdict(await converged(all), `re-synchronised in ${Date.now() - tRe}ms via version-vector delta`);
  verdict(alice.text().includes('CAROL-OFFLINE>'), 'carol\'s offline edits were replayed to everybody');

  /* ------------------------------------------------------------------ 8 */
  head('Kill a collaboration replica → automatic failover');
  const victim = reps.find((r) => r.id === alice.replicaId) || reps[0];
  const survivor = reps.find((r) => r.id !== victim.id);
  say(`SIGKILL ${victim.id} (the replica alice is connected to)`);
  const pidFile = path.join(__dirname, `../logs/${victim.id}.pid`);
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  process.kill(pid, 'SIGKILL');
  for (const c of all) if (c.replicaId === victim.id) c.preferReplica = survivor.id;
  const tFo = Date.now();
  await Promise.all(all.map((c) => c.waitFor(() => c.connected && c.replicaId !== victim.id, 25000, 'failover').catch(() => null)));
  say(`failover took ${Date.now() - tFo}ms; everyone is now on ${survivor.id}`);
  alice.insert(alice.text().length, ' +after-failover');
  await sleep(900);
  show(all);
  verdict(await converged(all), 'the system kept working and converged after losing a replica');
  verdict(alice.text().includes('+after-failover'), 'edits accepted on the surviving replica');

  /* ------------------------------------------------------------------ 9 */
  head('Restart the server and restore the document from storage');
  const finalText = alice.text();
  say('stopping ALL collaboration replicas, then starting a cold one');
  for (const r of reps) {
    try { process.kill(parseInt(fs.readFileSync(path.join(__dirname, `../logs/${r.id}.pid`), 'utf8').trim(), 10), 'SIGKILL'); } catch {}
  }
  for (const c of all) c.close();
  await sleep(800);

  const port = 7200 + parseInt(victim.id.split('-')[1], 10);
  const out = fs.openSync(path.join(__dirname, `../logs/${victim.id}.log`), 'a');
  const child = spawn(process.execPath, ['src/collab/server.js'], {
    cwd: path.join(__dirname, '..'), detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, REPLICA_ID: victim.id, COLLAB_PORT: String(port), COLLAB_WS_URL: `ws://127.0.0.1:${port}` },
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  await sleep(2000);

  const restored = await requestJSON(`http://127.0.0.1:${port}/internal/docs/${docId}/text`, { headers: { 'x-internal-key': config.internalKey } });
  say(`cold replica rebuilt the document from snapshot + operation log`);
  console.log(`    ${C.y}${JSON.stringify(restored.text)}${C.x}`);
  verdict(restored.text === finalText, 'the restored document is byte-identical to the pre-crash state');

  // bring the other replica back so the cluster is whole again
  const r2 = reps.find((r) => r.id !== victim.id);
  if (r2) {
    const p2 = 7200 + parseInt(r2.id.split('-')[1], 10);
    const o2 = fs.openSync(path.join(__dirname, `../logs/${r2.id}.log`), 'a');
    const c2 = spawn(process.execPath, ['src/collab/server.js'], {
      cwd: path.join(__dirname, '..'), detached: true, stdio: ['ignore', o2, o2],
      env: { ...process.env, REPLICA_ID: r2.id, COLLAB_PORT: String(p2), COLLAB_WS_URL: `ws://127.0.0.1:${p2}` },
    });
    fs.writeFileSync(path.join(__dirname, `../logs/${r2.id}.pid`), String(c2.pid));
    c2.unref();
  }

  console.log(`\n${C.b}${process.exitCode ? C.r + 'SOME SCENARIOS FAILED' : C.g + 'ALL 9 MANDATORY SCENARIOS PASSED'}${C.x}\n`);
  await sleep(600);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(`${C.r}demo failed: ${e.message}${C.x}`); process.exit(1); });
