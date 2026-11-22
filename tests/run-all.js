'use strict';
/**
 * CoEdit-DS full test suite (§9 Testing and Evaluation).
 *
 *   8 functional tests            F01..F08
 *   2 concurrency / conflict      C01..C02
 *   5 fault & recovery            R01..R05
 *   3 security / invalid data     S01..S03
 *   1 performance / scalability   P01
 *
 * Pre-requisite: a running cluster with at least 2 collaboration replicas
 *     ./scripts/start-cluster.sh 2
 * Then:
 *     npm test
 */
process.env.COEDIT_ENV_FILE = process.env.COEDIT_ENV_FILE || require('path').join(__dirname, '../.env');

const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocket } = require('ws');

const { suite, test, eq, ok, throwsAsync, sleep, run } = require('./harness');
const { CoEditClient } = require('../src/client/engine');
const { RGA } = require('../src/common/crdt/rga');
const { config } = require('../src/common/util/config');
const { requestJSON } = require('../src/common/util/http');
const { createLogger } = require('../src/common/util/log');

const quiet = createLogger('test', { level: 'error' });
const uniq = () => crypto.randomBytes(4).toString('hex');
const PW = 'password123';

/** Create N logged-in clients with fresh identities. */
async function makeUsers(n, opts = {}) {
  const users = [];
  for (let i = 0; i < n; i++) {
    const c = new CoEditClient({ username: `t${uniq()}`, password: PW, logger: quiet, ...opts });
    await c.register(); await c.login();
    users.push(c);
  }
  return users;
}

/** Owner creates a doc and shares it with the rest as editors. */
async function sharedDoc(owner, others, title = 'test-doc', role = 'editor') {
  const docId = await owner.createDoc(title);
  for (const o of others) await owner.share(docId, o.username, role);
  return docId;
}

async function openAll(clients, docId) {
  for (const c of clients) await c.open(docId);
}

function closeAll(clients) { for (const c of clients) { try { c.close(); } catch {} } }

/** Wait until every client shows identical text (convergence). */
async function waitConverged(clients, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const texts = clients.map((c) => c.text());
    if (texts.every((t) => t === texts[0])) return texts[0];
    await sleep(40);
  }
  throw new Error('did not converge: ' + JSON.stringify(clients.map((c) => c.text())));
}

async function liveReplicas() {
  return (await requestJSON(`${config.directoryUrl}/registry/replicas`)).replicas;
}

/* =========================================================================
 *  FUNCTIONAL
 * ====================================================================== */
suite('Functional tests', () => {

  test('F01', 'Register, login and issue a document session ticket', async ({ note }) => {
    const [a] = await makeUsers(1);
    ok(a.token && a.token.split('.').length === 3, 'expected a 3-part HS256 token');
    const docId = await a.createDoc('F01 doc');
    const t = await requestJSON(`${config.directoryUrl}/docs/${docId}/session`, { headers: a.auth() });
    eq(t.role, 'owner', 'creator must be owner');
    ok(t.sessionToken && t.primary && t.primary.wsUrl.startsWith('ws'), 'ticket must name a replica');
    note(`ticket → ${t.primary.id} (${t.primary.wsUrl}), clientId=${t.clientId}`);
  });

  test('F02', 'Three clients open the same document and see each other', async ({ note }) => {
    const [a, b, c] = await makeUsers(3);
    const docId = await sharedDoc(a, [b, c], 'F02 three clients');
    await openAll([a, b, c], docId);
    await sleep(400);
    const names = new Set(a.presence.map((p) => p.username));
    eq(names.size, 3, `expected 3 active users, got ${[...names].join(',')}`);
    note(`presence: ${[...names].join(', ')}`);
    closeAll([a, b, c]);
  });

  test('F03', 'One client edits, the others receive the update', async ({ note }) => {
    const [a, b, c] = await makeUsers(3);
    const docId = await sharedDoc(a, [b, c], 'F03 broadcast');
    await openAll([a, b, c], docId);
    a.insert(0, 'Distributed Systems');
    await b.waitFor((t) => t === 'Distributed Systems', 5000, 'B receives');
    await c.waitFor((t) => t === 'Distributed Systems', 5000, 'C receives');
    note(`propagated to 2 peers; replicas: ${a.replicaId}/${b.replicaId}/${c.replicaId}`);
    closeAll([a, b, c]);
  });

  test('F04', 'Insert and delete operations synchronise correctly', async ({ note }) => {
    const [a, b] = await makeUsers(2);
    const docId = await sharedDoc(a, [b], 'F04 ins/del');
    await openAll([a, b], docId);
    a.insert(0, 'Hello brave world');
    await b.waitFor((t) => t === 'Hello brave world', 5000, 'initial');
    b.delete(5, 6);                       // remove " brave"
    await a.waitFor((t) => t === 'Hello world', 5000, 'delete propagated');
    const text = await waitConverged([a, b]);
    eq(text, 'Hello world');
    note(`final text: "${text}"`);
    closeAll([a, b]);
  });

  test('F05', 'A late-joining client is synchronised with the full document', async ({ note }) => {
    const [a, b, c] = await makeUsers(3);
    const docId = await sharedDoc(a, [b, c], 'F05 late join');
    await openAll([a, b], docId);
    a.insert(0, 'written before C joined');
    await b.waitFor((t) => t.length === 23, 5000, 'B up to date');
    await sleep(300);
    await c.open(docId);                  // C joins late -> receives a snapshot
    await c.waitFor((t) => t === 'written before C joined', 5000, 'C snapshot sync');
    note(`late joiner received ${c.doc.length} chars via snapshot`);
    closeAll([a, b, c]);
  });

  test('F06', 'Operations carry id, clientId, docId, type and version metadata', async ({ note }) => {
    const [a] = await makeUsers(1);
    const docId = await sharedDoc(a, [], 'F06 op shape');
    await openAll([a], docId);
    const [op] = a.insert(0, 'x');
    ok(typeof op.id === 'string' && op.id === `${op.site}:${op.ctr}`, 'op.id must be site:ctr');
    eq(op.site, a.clientId, 'op.site must equal the client id');
    ok(op.t === 'ins' && typeof op.ch === 'string', 'op type/payload');
    ok(Number.isInteger(op.lam) && op.lam > 0, 'Lamport clock must be present');
    ok(Number.isInteger(op.ctr) && op.ctr > 0, 'per-site counter must be present');
    await sleep(200);
    ok(a.doc.vv[a.clientId] >= 1, 'version vector must track the site');
    note(`op = ${JSON.stringify(op)}`);
    closeAll([a]);
  });

  test('F07', 'Document state survives a full restart of the collaboration replica', async ({ note }) => {
    const [a] = await makeUsers(1);
    const docId = await sharedDoc(a, [], 'F07 durability');
    await openAll([a], docId);
    a.insert(0, 'persisted content');
    await sleep(900);                     // allow the write-behind flush
    const stats = await requestJSON(`${config.storageUrl}/docs/${docId}/stats`, { headers: { 'x-internal-key': config.internalKey } });
    ok(stats.ops >= 17, `storage should hold the ops, got ${stats.ops}`);
    // Read the document back through a *different* replica than the one used.
    const reps = await liveReplicas();
    const other = reps.find((r) => r.id !== a.replicaId) || reps[0];
    const port = new URL(other.wsUrl.replace('ws', 'http')).port;
    const view = await requestJSON(`http://127.0.0.1:${port}/internal/docs/${docId}/text`, { headers: { 'x-internal-key': config.internalKey } });
    eq(view.text, 'persisted content', 'a cold replica must rebuild identical text from storage');
    note(`storage seq=${stats.seq}, rebuilt on ${other.id} from the op log`);
    closeAll([a]);
  });

  test('F08', 'Owner can grant access; the document list reflects roles', async ({ note }) => {
    const [a, b] = await makeUsers(2);
    const docId = await sharedDoc(a, [], 'F08 sharing');
    let docsB = await b.listDocs();
    ok(!docsB.find((d) => d.id === docId), 'B must not see the document before sharing');
    await a.share(docId, b.username, 'viewer');
    docsB = await b.listDocs();
    const entry = docsB.find((d) => d.id === docId);
    ok(entry, 'B must see the document after sharing');
    eq(entry.role, 'viewer');
    note(`role granted: ${entry.role}`);
  });
});

/* =========================================================================
 *  CONCURRENCY / CONFLICT
 * ====================================================================== */
suite('Concurrency and conflict tests', () => {

  test('C01', 'Three clients insert at the SAME position simultaneously → convergence', async ({ note }) => {
    const [a, b, c] = await makeUsers(3, {});
    const docId = await sharedDoc(a, [b, c], 'C01 same position');
    await openAll([a, b, c], docId);
    a.insert(0, 'START|END');
    await waitConverged([a, b, c]);
    // All three insert at offset 6, with no knowledge of each other.
    a.insert(6, '<A>'); b.insert(6, '<B>'); c.insert(6, '<C>');
    const text = await waitConverged([a, b, c], 10000);
    ok(text.startsWith('START|'), 'prefix preserved');
    ok(text.endsWith('END'), 'suffix preserved');
    for (const tag of ['<A>', '<B>', '<C>']) ok(text.includes(tag), `${tag} must survive: ${text}`);
    eq(text.length, 9 + 9, 'no characters lost or duplicated');
    note(`converged text: "${text}" (deterministic RGA order, identical on all 3 replicas)`);
    closeAll([a, b, c]);
  });

  test('C02', 'One client inserts while another deletes the same region → convergence', async ({ note }) => {
    const reps = await liveReplicas();
    const r1 = reps[0].id, r2 = (reps[1] || reps[0]).id;
    const a = (await makeUsers(1, { preferReplica: r1 }))[0];
    const b = (await makeUsers(1, { preferReplica: r2 }))[0];
    const docId = await sharedDoc(a, [b], 'C02 insert vs delete');
    await openAll([a, b], docId);
    a.insert(0, 'abcdefghij');
    await waitConverged([a, b]);
    // Concurrent: A deletes "cdef", B inserts "###" inside that same region.
    a.delete(2, 4);
    b.insert(4, '###');
    const text = await waitConverged([a, b], 10000);
    ok(text.includes('###'), 'the concurrent insert must not be lost');
    ok(!text.includes('cdef'), 'the deleted characters must stay deleted');
    eq(text, 'ab###ghij', 'expected the surviving characters in order');
    note(`A on ${a.replicaId}, B on ${b.replicaId} → "${text}"`);
    closeAll([a, b]);
  });
});

/* =========================================================================
 *  FAULT & RECOVERY
 * ====================================================================== */
suite('Fault tolerance and recovery tests', () => {

  test('R01', 'A client loses connectivity, keeps editing offline, then re-syncs', async ({ note }) => {
    const [a, b] = await makeUsers(2);
    const docId = await sharedDoc(a, [b], 'R01 offline');
    await openAll([a, b], docId);
    a.insert(0, 'base');
    await waitConverged([a, b]);

    a.autoReconnect = false;
    a.killSocket();                          // hard disconnect (no FIN)
    await sleep(200);
    a.insert(4, '+offline');                 // buffered in A's outbox
    b.insert(4, '+online');                  // B keeps working meanwhile
    await sleep(400);
    ok(!b.text().includes('offline'), 'B must not see A\'s offline edits yet');

    a.autoReconnect = true;
    await a.open(docId);                     // reconnect + delta re-sync
    const text = await waitConverged([a, b], 10000);
    ok(text.includes('+offline') && text.includes('+online'), 'both edit sets must survive: ' + text);
    note(`reconnected to ${a.replicaId}; converged: "${text}"`);
    closeAll([a, b]);
  });

  test('R02', 'A collaboration replica is killed → clients fail over and converge', async ({ note }) => {
    const reps = await liveReplicas();
    if (reps.length < 2) throw new Error('this test needs >= 2 replicas (start-cluster.sh 2)');
    const victimId = reps[0].id, survivorId = reps[1].id;

    const a = (await makeUsers(1, { preferReplica: victimId }))[0];
    const b = (await makeUsers(1, { preferReplica: survivorId }))[0];
    const docId = await sharedDoc(a, [b], 'R02 failover');
    await openAll([a, b], docId);
    a.insert(0, 'before-crash ');
    await waitConverged([a, b]);
    await sleep(700);                        // let the ops reach storage

    // Kill the victim replica the hard way (SIGKILL: no graceful drain).
    const pid = require('fs').readFileSync(`${__dirname}/../logs/${victimId}.pid`, 'utf8').trim();
    process.kill(parseInt(pid, 10), 'SIGKILL');
    note(`SIGKILL sent to ${victimId} (pid ${pid})`);

    a.preferReplica = survivorId;            // directory would do this anyway
    const t0 = Date.now();
    await a.waitFor(() => a.connected && a.replicaId === survivorId, 20000, 'failover');
    const failoverMs = Date.now() - t0;

    a.insert(a.text().length, 'after-failover');
    const text = await waitConverged([a, b], 12000);
    ok(text.includes('before-crash') && text.includes('after-failover'), 'text: ' + text);
    note(`failover completed in ${failoverMs}ms → ${a.replicaId}; converged "${text}"`);
    closeAll([a, b]);

    // restart the victim so later tests still see a 2-replica cluster
    await new Promise((res) => {
      const port = 7200 + parseInt(victimId.split('-')[1], 10);
      const out = require('fs').openSync(`${__dirname}/../logs/${victimId}.log`, 'a');
      const child = require('child_process').spawn(process.execPath, ['src/collab/server.js'], {
        cwd: `${__dirname}/..`, detached: true, stdio: ['ignore', out, out],
        env: { ...process.env, REPLICA_ID: victimId, COLLAB_PORT: String(port), COLLAB_WS_URL: `ws://127.0.0.1:${port}` },
      });
      require('fs').writeFileSync(`${__dirname}/../logs/${victimId}.pid`, String(child.pid));
      child.unref();
      setTimeout(res, 1500);
    });
  }, { timeout: 60000 });

  test('R03', 'Duplicated and out-of-order operations are absorbed idempotently', async ({ note }) => {
    // Exercised directly against the CRDT AND over the wire.
    const src = new RGA('src');
    src.localInsertText(0, 'ordered');
    const ops = [...src.oplog];
    const shuffled = [...ops, ...ops].sort(() => Math.random() - 0.5);   // reorder + duplicate
    const sink = new RGA('sink');
    for (const op of shuffled) sink.apply(op);
    eq(sink.text(), 'ordered', 'CRDT must absorb reordering and duplication');
    eq(sink.pendingCount(), 0, 'no operation may stay parked');

    // Now over the network: replay the same batch twice to the server.
    const [a, b] = await makeUsers(2);
    const docId = await sharedDoc(a, [b], 'R03 dup ops');
    await openAll([a, b], docId);
    a.insert(0, 'dup');
    await waitConverged([a, b]);
    a.resendInflight();                 // deliberate duplicate transmission
    a.ws.send(JSON.stringify({ t: 'ops', docId, ops: a.doc.oplog.slice(0, 3), batchId: 'replay-1' }));
    await sleep(700);
    const text = await waitConverged([a, b]);
    eq(text, 'dup', 'duplicates must not duplicate characters');
    note(`replayed ${a.doc.oplog.length} ops; text still "${text}"`);
    closeAll([a, b]);
  });

  test('R04', 'Lost broadcast frames are repaired by anti-entropy re-sync', async ({ note }) => {
    // Simulate an unreliable data plane by silently dropping ops the server
    // has *already applied* before they reach one of the clients.
    const [a, b] = await makeUsers(2);
    const docId = await sharedDoc(a, [b], 'R04 lossy link');
    await openAll([a, b], docId);
    a.insert(0, 'seed');
    await waitConverged([a, b]);

    // Intercept B's socket: drop 50% of incoming `ops` frames.
    const realHandler = b.ws.listeners('message')[0];
    b.ws.removeAllListeners('message');
    let dropped = 0;
    b.ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString('utf8')); } catch { return realHandler(buf); }
      if (m.t === 'ops' && Math.random() < 0.5) { dropped++; return; }     // frame lost
      realHandler(buf);
    });

    for (let i = 0; i < 20; i++) { a.insert(a.text().length, String(i % 10)); await sleep(15); }
    await sleep(300);
    ok(dropped > 0, 'the test must actually drop some frames');
    note(`${dropped} ops frame(s) dropped on the wire`);

    // Without repair B would stay behind; anti-entropy must close the gap.
    const text = await waitConverged([a, b], 15000);
    eq(text.length, 24, 'no operation may be permanently lost');
    note(`converged to ${text.length} chars via periodic version-vector re-sync`);
    closeAll([a, b]);
  }, { timeout: 45000 });

  test('R05', 'Storage outage → ops buffered in a dead-letter queue and drained on recovery', async ({ note }) => {
    const [a, b] = await makeUsers(2);
    const docId = await sharedDoc(a, [b], 'R05 storage outage');
    await openAll([a, b], docId);
    a.insert(0, 'before-outage ');
    await sleep(900);

    const replicaPort = 7200 + parseInt(a.replicaId.split('-')[1], 10);
    const health = () => requestJSON(`http://127.0.0.1:${replicaPort}/health`);
    const docOf = (h) => h.docs.find((d) => d.docId === docId) || { dlq: 0 };

    // Stop the storage service (SIGTERM, graceful).
    const stPid = parseInt(require('fs').readFileSync(`${__dirname}/../logs/storage.pid`, 'utf8').trim(), 10);
    process.kill(stPid, 'SIGTERM');
    await sleep(1000);

    a.insert(a.text().length, 'DURING-OUTAGE ');
    await sleep(2500);
    const dlqDepth = docOf(await health()).dlq;
    ok(dlqDepth > 0, `ops must be buffered while storage is down (dlq=${dlqDepth})`);
    ok(await (async () => { try { await waitConverged([a, b], 3000); return true; } catch { return false; } })(),
      'clients must keep converging even though storage is unavailable');
    note(`storage down: dlq=${dlqDepth}, live editing unaffected (availability preserved)`);

    // Bring storage back.
    const out = require('fs').openSync(`${__dirname}/../logs/storage.log`, 'a');
    const child = require('child_process').spawn(process.execPath, ['src/storage/server.js'], {
      cwd: `${__dirname}/..`, detached: true, stdio: ['ignore', out, out], env: { ...process.env, NODE_ID: 'storage-1' },
    });
    require('fs').writeFileSync(`${__dirname}/../logs/storage.pid`, String(child.pid));
    child.unref();

    const deadline = Date.now() + 20000;
    let drained = -1;
    while (Date.now() < deadline) {
      drained = docOf(await health().catch(() => ({ docs: [] }))).dlq;
      if (drained === 0) break;
      await sleep(400);
    }
    eq(drained, 0, 'the dead-letter queue must drain after recovery');
    const stats = await requestJSON(`${config.storageUrl}/docs/${docId}/stats`, { headers: { 'x-internal-key': config.internalKey } });
    ok(stats.ops >= a.text().length, `storage must hold every op (${stats.ops} >= ${a.text().length})`);
    note(`recovered: dlq drained to 0, storage holds ${stats.ops} ops — no data loss`);
    closeAll([a, b]);
  }, { timeout: 60000 });

  /**
   * REGRESSION (defect #1, critical). A client that goes offline BEFORE a
   * snapshot is taken and reconnects AFTER the replica was restarted from that
   * snapshot used to lose every operation that predated the snapshot: the
   * restored replica had an empty oplog, so the delta computed by missingFor()
   * was silently truncated and the two sides never converged again.
   *
   * This exercises the >SNAPSHOT_EVERY_OPS regime that no other test reaches.
   */
  test('R06', 'Reconnect across a snapshot + replica restart still converges (no silent op loss)', async ({ note }) => {
    const [a, b] = await makeUsers(2);
    const docId = await sharedDoc(a, [b], 'R06 snapshot delta');

    // Pin both clients to the SAME replica: the restart must hit their replica.
    await a.open(docId);
    const target = a.replicaId;
    b.preferReplica = target;
    await b.open(docId);
    eq(b.replicaId, target, 'both clients must sit on the same replica for this scenario');

    a.insert(0, 'BASE:');
    await waitConverged([a, b]);
    const vvBefore = { ...b.doc.vv };

    // B disappears while its version vector is still tiny.
    b.autoReconnect = false;
    b.killSocket();
    await sleep(300);

    // A writes past the snapshot threshold so a snapshot is definitely taken.
    const bulk = 'x'.repeat(config.snapshotEveryOps + 20);
    a.insert(a.text().length, bulk);
    const expected = a.text();

    // Wait for the snapshot to actually be persisted.
    const deadline = Date.now() + 25000;
    let snapSeq = 0;
    while (Date.now() < deadline) {
      const st = await requestJSON(`${config.storageUrl}/docs/${docId}/stats`, { headers: { 'x-internal-key': config.internalKey } });
      snapSeq = st.snapshotSeq;
      if (snapSeq > 0) break;
      await sleep(300);
    }
    ok(snapSeq > 0, `a snapshot must exist before the restart (snapshotSeq=${snapSeq})`);
    note(`snapshot taken at seq=${snapSeq} (threshold ${config.snapshotEveryOps})`);

    // Crash the replica and bring it back: it rebuilds purely from the snapshot.
    const sh = (args) => new Promise((res) => execFile('bash', ['scripts/chaos.sh', ...args], { cwd: `${__dirname}/..` }, () => res()));
    await sh(['kill', target]);
    await sleep(500);
    await sh(['start', target]);
    await sleep(2500);

    // B comes back with its stale version vector and must NOT lose content.
    b.autoReconnect = true;
    await b.open(docId);
    const got = await (async () => {
      const dl = Date.now() + 15000;
      while (Date.now() < dl) { if (b.text() === expected) return b.text(); await sleep(150); }
      return b.text();
    })();

    eq(got.length, expected.length, `B must recover the full document (knownVV was ${JSON.stringify(vvBefore)})`);
    ok(got === expected, 'B must converge to exactly A\'s text after a snapshot-based restore');
    note(`B resumed from vv=${JSON.stringify(vvBefore)} across a snapshot restore and recovered all ${expected.length} chars`);
    closeAll([a, b]);
  }, { timeout: 90000 });

  /**
   * REGRESSION (defect #1, unit level). A snapshot must carry enough history
   * to answer a delta request from a replica older than the snapshot, or else
   * honestly report that it cannot via canServeDelta().
   */
  test('R07', 'A snapshot preserves history for delta sync (or refuses to serve a partial delta)', async ({ note }) => {
    const a = new RGA('a');
    a.localInsertText(0, 'hello world');
    const earlyVV = { a: 3 };
    const restored = RGA.fromSnapshot('a', a.snapshot());

    eq(restored.text(), a.text(), 'restored text must match');
    ok(restored.oplog.length === a.oplog.length,
      `restored replica must keep its history (${restored.oplog.length} vs ${a.oplog.length})`);
    ok(restored.canServeDelta(earlyVV), 'a v2 snapshot must be able to serve an old delta');
    eq(restored.missingFor(earlyVV).length, a.missingFor(earlyVV).length,
      'the delta after restore must equal the delta before restore');

    // A legacy v1 snapshot (no history) must be detected, never trusted.
    const legacy = a.snapshot(); delete legacy.oplog; legacy.v = 1;
    const old = RGA.fromSnapshot('a', legacy);
    ok(!old.canServeDelta(earlyVV), 'a history-less snapshot must refuse to serve a partial delta');
    note(`v2 snapshot carries ${restored.oplog.length} ops; v1 fallback correctly reports delta unavailable`);
  });
});

/* =========================================================================
 *  SECURITY / INVALID DATA
 * ====================================================================== */
suite('Security and invalid-data tests', () => {

  test('S01', 'Unauthenticated and forged tokens are rejected; passwords are hashed', async ({ note }) => {
    await throwsAsync(() => requestJSON(`${config.directoryUrl}/docs`), /HTTP 401|unauthorized/, 'missing token must fail');
    await throwsAsync(() => requestJSON(`${config.directoryUrl}/docs`, { headers: { authorization: 'Bearer not.a.token' } }), /401|unauthorized/, 'garbage token must fail');

    const [a] = await makeUsers(1);
    // Tamper with the payload but keep the original signature.
    const [h, p, s] = a.token.split('.');
    const body = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    body.sub = 'u-attacker';
    const forged = `${h}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${s}`;
    await throwsAsync(() => requestJSON(`${config.directoryUrl}/docs`, { headers: { authorization: 'Bearer ' + forged } }), /401|unauthorized/, 'forged token must fail');

    // Password must never be stored or returned in plaintext.
    const dump = require('fs').readFileSync(`${config.dataDir}/directory-state.json`, 'utf8');
    ok(!dump.includes(PW), 'plaintext password found in the directory state file!');
    ok(dump.includes('pbkdf2$'), 'passwords must be PBKDF2 hashed');
    await throwsAsync(() => requestJSON(`${config.directoryUrl}/auth/login`, { method: 'POST', body: { username: a.username, password: 'wrong-password' } }), /401|invalid credentials/, 'wrong password must fail');
    note('missing/garbage/forged tokens rejected; PBKDF2 hashes on disk; wrong password rejected');
  });

  test('S02', 'Access control: a viewer cannot write, a stranger cannot read', async ({ note }) => {
    const [owner, viewer, stranger] = await makeUsers(3);
    const docId = await sharedDoc(owner, [], 'S02 acl');
    await owner.share(docId, viewer.username, 'viewer');

    // stranger: no ACL entry at all
    await throwsAsync(() => requestJSON(`${config.directoryUrl}/docs/${docId}/session`, { headers: stranger.auth() }), /403|no access/, 'stranger must be denied');

    // viewer: may open, must not be able to write
    await owner.open(docId);
    owner.insert(0, 'read only');
    await sleep(300);
    await viewer.open(docId);
    await viewer.waitFor((t) => t === 'read only', 5000, 'viewer reads');
    eq(viewer.canEdit, false, 'viewer must not have write permission');
    let denied = null;
    viewer.on('error-msg', (m) => { denied = m; });
    viewer.insert(0, 'HACK');                 // client-side op, server must refuse
    await sleep(600);
    ok(denied && denied.code === 403, 'server must reject the viewer write with 403');
    await sleep(300);
    eq(owner.text(), 'read only', 'the owner must not see the rejected edit');

    // a viewer must not be able to re-share
    await throwsAsync(() => requestJSON(`${config.directoryUrl}/docs/${docId}/share`, { method: 'POST', headers: viewer.auth(), body: { username: stranger.username, role: 'editor' } }), /403|owner/, 'viewer must not share');
    note('stranger read denied, viewer write denied (403), viewer re-share denied');
    closeAll([owner, viewer]);
  });

  test('S03', 'Malformed / spoofed / oversized input is rejected safely', async ({ note }) => {
    // weak credentials
    await throwsAsync(() => requestJSON(`${config.directoryUrl}/auth/register`, { method: 'POST', body: { username: 'ab', password: PW } }), /400|username/, 'short username');
    await throwsAsync(() => requestJSON(`${config.directoryUrl}/auth/register`, { method: 'POST', body: { username: 'ok_user_' + uniq(), password: 'short' } }), /400|password/, 'short password');
    // path traversal on the storage service
    await throwsAsync(() => requestJSON(`${config.storageUrl}/docs/${encodeURIComponent('../../etc')}/stats`, { headers: { 'x-internal-key': config.internalKey } }), /400|invalid docId/, 'path traversal');
    // internal endpoints require the shared key
    await throwsAsync(() => requestJSON(`${config.storageUrl}/docs/anything/stats`), /403|forbidden/, 'internal key required');

    const [a, b] = await makeUsers(2);
    const docId = await sharedDoc(a, [b], 'S03 bad input');
    await openAll([a, b], docId);
    a.insert(0, 'clean');
    await waitConverged([a, b]);

    const errors = [];
    a.on('error-msg', (m) => errors.push(m));
    // 1) structurally invalid operation
    a.ws.send(JSON.stringify({ t: 'ops', docId, batchId: 'bad-1', ops: [{ id: 'x', t: 'ins' }] }));
    await sleep(250);
    // 2) op impersonating another site (id spoofing)
    a.ws.send(JSON.stringify({ t: 'ops', docId, batchId: 'bad-2', ops: [{ id: `${b.clientId}:999`, t: 'ins', site: b.clientId, ctr: 999, lam: 5, after: 'ROOT', ch: 'Z' }] }));
    await sleep(250);
    // 3) multi-character insert (protocol violation)
    a.ws.send(JSON.stringify({ t: 'ops', docId, batchId: 'bad-3', ops: [{ id: `${a.clientId}:9999`, t: 'ins', site: a.clientId, ctr: 9999, lam: 5, after: 'ROOT', ch: 'TOOLONG' }] }));
    await sleep(400);

    ok(errors.length >= 3, `expected >=3 rejections, got ${errors.length}`);
    ok(errors.some((e) => e.code === 400), 'malformed op must be 400');
    ok(errors.some((e) => e.code === 403 && /site/.test(e.message)), 'spoofed site must be 403');
    const text = await waitConverged([a, b]);
    eq(text, 'clean', 'no invalid data may reach the document');
    // the connection must still be usable afterwards
    a.insert(5, '!');
    await b.waitFor((t) => t === 'clean!', 5000, 'still usable');
    note(`rejections: ${errors.map((e) => e.code).join(', ')}; document unaffected and session still alive`);
    closeAll([a, b]);
  });

  /**
   * REGRESSION (defect #2, high). Revoking edit rights used to have no effect
   * on an already-open socket, because canEdit was resolved once at WELCOME
   * time and cached for the lifetime of the connection. A downgraded editor
   * could keep writing until their token expired.
   */
  test('S04', 'Revoking edit rights takes effect on an ALREADY-OPEN session', async ({ note }) => {
    const [owner, mate] = await makeUsers(2);
    const docId = await sharedDoc(owner, [mate], 'S04 live revocation', 'editor');
    await openAll([owner, mate], docId);

    // Baseline: the editor really can write.
    mate.insert(0, 'legit-');
    await waitConverged([owner, mate]);
    eq(mate.canEdit, true, 'the collaborator starts as an editor');
    const before = owner.text();

    // Owner downgrades them to viewer while the socket stays open.
    await owner.share(docId, mate.username, 'viewer');
    const denied = [];
    mate.on('error-msg', (m) => denied.push(m));

    // Give the replica's ACL cache time to expire, then attempt a write.
    await sleep(3500);
    mate.insert(0, 'SHOULD-BE-BLOCKED-');
    await sleep(1500);

    ok(denied.some((e) => e.code === 403),
      `the server must reject writes from a revoked editor (got ${JSON.stringify(denied.map((d) => d.code))})`);
    ok(!owner.text().includes('SHOULD-BE-BLOCKED'),
      `revoked content must never reach the document: "${owner.text().slice(0, 60)}"`);
    eq(owner.text(), before, 'the document must be unchanged by the revoked user');
    note(`revocation enforced on the live socket: ${denied.filter((d) => d.code === 403).length}x 403, document intact`);
    closeAll([owner, mate]);
  }, { timeout: 45000 });

  /**
   * REGRESSION (defect #3, medium). Operations whose causal dependency never
   * arrives used to be parked forever in an unbounded map — an authenticated
   * client could exhaust the replica's heap by sending ops with bogus origins.
   */
  test('S05', 'Operations with unresolvable dependencies cannot grow memory without bound', async ({ note }) => {
    const doc = new RGA('victim', { pendingMaxOps: 500, pendingTtlMs: 250 });
    for (let i = 0; i < 20000; i++) {
      doc.apply({ id: `attacker:${i}`, t: 'ins', site: 'attacker', ctr: i, lam: i, after: `ghost:${i}`, ch: 'x' });
    }
    ok(doc.pendingCount() <= 500, `the parking area must stay bounded, got ${doc.pendingCount()}`);
    ok(doc.droppedPending > 0, 'overflow must be accounted for, not silently ignored');
    eq(doc.text(), '', 'no bogus operation may become visible text');

    // TTL: entries whose dependency never shows up are eventually reclaimed.
    await sleep(400);
    doc.apply({ id: 'attacker:last', t: 'ins', site: 'attacker', ctr: 99999, lam: 1, after: 'ghost:last', ch: 'y' });
    ok(doc.pendingCount() < 500, `expired entries must be reclaimed, got ${doc.pendingCount()}`);

    // A legitimate out-of-order pair must still be repaired normally.
    const good = new RGA('good');
    const [o1] = good.localInsertText(0, 'A');
    const peer = new RGA('peer');
    const o2 = { id: 'peer:1', t: 'ins', site: 'peer', ctr: 1, lam: 9, after: o1.id, ch: 'B' };
    peer.apply(o2);            // arrives before its origin → parked
    peer.apply(o1);            // origin arrives → drained
    eq(peer.text(), 'AB', 'genuine reordering must still be repaired');
    note(`20000 hostile ops capped at ${doc.pendingCount()} parked (${doc.droppedPending} shed); causal reordering still works`);
  }, { timeout: 30000 });
});

/* =========================================================================
 *  PERFORMANCE / SCALABILITY
 * ====================================================================== */
suite('Performance and scalability experiment', () => {

  test('P01', 'Throughput, propagation latency and convergence with N concurrent editors', async ({ note }) => {
    const N = parseInt(process.env.PERF_CLIENTS || '6', 10);
    const OPS = parseInt(process.env.PERF_OPS || '40', 10);
    const reps = await liveReplicas();

    const users = [];
    for (let i = 0; i < N; i++) {
      const c = new CoEditClient({ username: `p${uniq()}`, password: PW, logger: quiet, preferReplica: reps[i % reps.length].id });
      await c.register(); await c.login();
      users.push(c);
    }
    const owner = users[0];
    const docId = await sharedDoc(owner, users.slice(1), 'P01 perf');
    await openAll(users, docId);
    note(`${N} clients spread over ${reps.length} replica(s): ${users.map((u) => u.replicaId).join(', ')}`);

    // --- latency probe: one op, measure until every peer displays it -------
    const lat = [];
    for (let i = 0; i < 10; i++) {
      const marker = `~${i}~`;
      const t0 = Date.now();
      owner.insert(0, marker);
      await Promise.all(users.slice(1).map((u) => u.waitFor((t) => t.includes(marker), 8000, 'latency probe')));
      lat.push(Date.now() - t0);
      await sleep(60);
    }
    lat.sort((x, y) => x - y);
    const p50 = lat[Math.floor(lat.length * 0.5)];
    const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))];

    // --- throughput: every client types concurrently ----------------------
    const start = Date.now();
    for (let i = 0; i < OPS; i++) {
      for (const u of users) u.insert(u.text().length, String(i % 10));
      await sleep(4);
    }
    const submitMs = Date.now() - start;
    const totalOps = N * OPS;

    const convStart = Date.now();
    const finalText = await waitConverged(users, 30000);
    const convergeMs = Date.now() - convStart;

    // every replica must hold exactly the same text as well
    const perReplica = [];
    for (const r of reps) {
      const port = new URL(r.wsUrl.replace('ws', 'http')).port;
      const v = await requestJSON(`http://127.0.0.1:${port}/internal/docs/${docId}/text`, { headers: { 'x-internal-key': config.internalKey } });
      perReplica.push({ id: r.id, len: v.text.length, same: v.text === finalText });
    }
    ok(perReplica.every((r) => r.same), 'all replicas must hold identical text: ' + JSON.stringify(perReplica));

    const expectedLen = totalOps + 10 * 3;    // typed chars + 10 latency markers
    eq(finalText.length, expectedLen, 'no operation may be lost');

    const throughput = Math.round(totalOps / (submitMs / 1000));
    note(`propagation latency p50=${p50}ms p95=${p95}ms (min ${lat[0]}ms, max ${lat[lat.length - 1]}ms)`);
    note(`${totalOps} ops submitted in ${submitMs}ms ≈ ${throughput} ops/s; converged ${convergeMs}ms after the last op`);
    note(`final document ${finalText.length} chars; identical on ${perReplica.length} replica(s) and ${N} clients`);

    require('fs').writeFileSync(`${__dirname}/perf-result.json`, JSON.stringify({
      clients: N, opsPerClient: OPS, totalOps, replicas: reps.length,
      latencyMs: { p50, p95, min: lat[0], max: lat[lat.length - 1], samples: lat },
      submitMs, throughputOpsPerSec: throughput, convergeMs, finalLength: finalText.length, perReplica,
    }, null, 2));
    closeAll(users);
  }, { timeout: 120000 });
});

run();
