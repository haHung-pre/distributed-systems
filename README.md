# CoEdit-DS — Distributed Collaborative Document Editing (Topic DS04)

> Course project — **Distributed Systems**
> Topic **DS04**: a collaborative document editing system simulating Google Docs,
> built on a **CRDT (RGA)** with replicated real-time servers, durable storage,
> automatic failover and a full fault-injection test suite.

A document is edited concurrently by many users. Every client and every server
holds an independent **RGA CRDT replica**; operations are exchanged over
WebSocket and applied in any order, any number of times, and still converge to
byte-identical text on every node. There is **no last-writer-wins anywhere** —
which the specification explicitly forbids.

---

## 1. Table of contents

- [2. Quick start](#2-quick-start)
- [3. Architecture](#3-architecture)
- [4. Distributed-systems mechanisms](#4-distributed-systems-mechanisms)
- [5. Wire protocol](#5-wire-protocol)
- [6. Demonstration scenarios](#6-demonstration-scenarios)
- [7. Testing](#7-testing)
- [8. Results](#8-results)
- [9. Configuration](#9-configuration)
- [10. Deployment](#10-deployment)
- [11. Repository layout](#11-repository-layout)
- [12. Task assignment](#12-task-assignment)
- [13. Limitations and future work](#13-limitations-and-future-work)
- [14. References and academic integrity](#14-references-and-academic-integrity)

---

## 2. Quick start

### Requirements

| Software | Version |
|---|---|
| Node.js | ≥ 18 (tested on 20) |
| npm | ≥ 9 |
| Python 3 + matplotlib | only to regenerate report figures |
| Docker + Compose | optional, for the container deployment |

### Run it

```bash
git clone <repository-url> && cd coedit-ds
npm install                 # installs the single runtime dependency: ws

cp .env.example .env        # then EDIT .env and set real secrets
node -e "console.log('COEDIT_JWT_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('COEDIT_INTERNAL_KEY='+require('crypto').randomBytes(24).toString('hex'))"

./scripts/start-cluster.sh 2      # 5 processes: directory, storage, 2 replicas, gateway
```

Open <http://localhost:8080> in **three browser tabs**, register three users
(`alice`, `bob`, `carol` — password ≥ 8 chars), create a document as `alice`,
share it with the other two (`Share` panel), open it everywhere and type.

```bash
node scripts/demo.js         # scripted walkthrough of all 9 mandatory scenarios
npm test                     # 19 automated tests
node scripts/benchmark.js    # scalability sweep -> docs/benchmark.json
./scripts/stop-cluster.sh
```

> **Note** — `./scripts/start-cluster.sh N` starts `N` collaboration replicas.
> Use `N ≥ 2` so the failover tests (R02) and the failover demo have somewhere
> to fail over to.

### Command-line client

```bash
node src/client/cli/index.js --user alice --pass password123 --create "My doc"
node src/client/cli/index.js --user bob --pass password123 --doc doc-xxxx --replica collab-2
# scripted:
node src/client/cli/index.js --user alice --pass password123 --doc doc-xxxx \
     --script "insert 0 Hello; wait 300; insert 5 ' world'; print; status"
```

---

## 3. Architecture

![architecture](docs/figures/architecture.png)

Five **independent OS processes**, each with a unique identity, its own port and
its own state. Nothing is shared through memory, globals or files — every
interaction is a TCP message.

| # | Component | Port | Responsibility |
|---|---|---|---|
| 1 | **Directory Service** | 7000 | Authentication (PBKDF2 + HS256), naming (`docId`, `clientId`), **service discovery with leases**, document placement, viewer/editor/owner ACL |
| 2 | **Storage Service** | 7100 | Durable append-only **operation log** + periodic **snapshots**, one directory per document |
| 3 | **Collaboration replica A** | 7201 | WebSocket sessions, CRDT application, presence, replica-to-replica replication |
| 4 | **Collaboration replica B** | 7202 | identical, interchangeable — this is what makes failover possible |
| 5 | **API Gateway** | 8080 | Serves the web client, reverse-proxies REST to the Directory and the WebSocket upgrade to the right replica |

Clients (browser tabs and CLI processes) are further independent processes, each
carrying its **own CRDT replica** — the system easily exceeds the "at least
three independent processes" requirement.

### Why a replica *chain* instead of a single server

The Directory maps a document to an **ordered list** of live replicas using
**rendezvous (highest-random-weight) hashing** over the set of replicas whose
lease is still valid. The head of the list is the primary. When a replica dies
its lease expires, it drops out of the set, and the *same* deterministic hash
now names a different head — so failover needs no election, no consensus and no
coordination. Clients re-ask the Directory on every reconnect attempt, so they
are steered to a live replica automatically.

---

## 4. Distributed-systems mechanisms

### 4.1 Consistency model — Strong Eventual Consistency (SEC)

The system provides **strong eventual consistency**: replicas that have received
the same set of operations are in the same state, regardless of the order in
which the operations arrived. It deliberately does **not** provide linearisable
writes; in an interactive editor availability and latency matter far more than a
total order, and the CRDT makes divergence impossible anyway.

The document is an **RGA (Replicated Growable Array)** — a sequence CRDT:

- Each character is an immutable element with a globally unique id `site:counter`.
- A delete never removes an element; it sets a **tombstone**, so deletes are
  idempotent and commute with concurrent inserts.
- An insert carries the id of the element it follows (`after`) — its **causal
  origin** — plus a **Lamport clock**.
- Concurrent inserts sharing an origin are ordered by `(lamport, siteId)`
  descending. This is a *total order every replica agrees on*, so all replicas
  converge without communication.

![rga](docs/figures/rga.png)

Insert, delete, duplicate delivery and reordering are therefore all safe:
`apply()` is **idempotent** (dedup by op id) and **commutative**.

### 4.2 Causality

An operation whose origin element has not arrived yet cannot be integrated.
Instead of dropping it, the replica **parks** it in a `pending` map keyed by the
missing element id and replays it the moment that element appears
(`_drain()`). This makes the system tolerant of arbitrary reordering — no
operation is ever lost because it overtook its dependency.

Per-site counters form a **version vector** (`vv`), used for delta
synchronisation: `missingFor(remoteVV)` returns exactly the operations the peer
has not seen.

### 4.3 Naming and discovery

| Entity | Identifier | Allocated by |
|---|---|---|
| user | `u-<hex>` | Directory |
| document | `doc-<hex>` | Directory |
| client / CRDT site | `<username>-<hex>` | Directory (stable across reconnects) |
| replica | `collab-N` | configuration (`REPLICA_ID`) |
| operation | `<siteId>:<counter>` | the client itself |

Replicas **register and renew a lease** every `HEARTBEAT_MS` (2 s); a lease is
valid for `LEASE_TTL_MS` (6 s). A replica that stops renewing is reaped and no
longer handed out — this is the failure detector.

> A subtle but important detail: a reconnecting client **re-presents its existing
> `clientId`**, and the Directory only allows a client id inside that user's own
> namespace. If the site id changed on reconnect, the client's previously
> generated operations would be rejected by the anti-spoofing check and its
> buffered offline edits would be lost. This was a real bug found by test R01.

### 4.4 Concurrency control

- Clients are **local-first**: an edit is applied to the local replica
  immediately (no round trip in the typing path) and shipped asynchronously.
- The server applies operations in arrival order; the CRDT makes the interleaving
  irrelevant.
- Deduplication by operation id at **three** layers: client CRDT, replica CRDT,
  and the storage service.
- Rate limiting per connection (`RATE_LIMIT_OPS_PER_SEC`) bounds abusive clients.

### 4.5 Fault tolerance and recovery

| Mechanism | Where | What it protects against |
|---|---|---|
| Lease + heartbeat | Directory ↔ replicas | crashed / frozen replica |
| WebSocket ping-pong sweep | replica → clients | half-open connections |
| Exponential backoff + jitter reconnect | clients | transient network loss |
| **Failover** (re-ask Directory each attempt) | clients | replica crash |
| Client outbox buffering | clients | offline editing |
| In-flight requeue on socket close | clients | edits lost mid-transmission |
| **Anti-entropy re-sync** (version vector, 2 s) | clients ↔ replica | *lost broadcast frames* |
| Bounded retry with backoff | replica → storage | slow / restarting storage |
| **Dead-letter queue** + drain loop | replica | storage outage — zero data loss |
| Write-behind op log + snapshots | storage | process/host restart |
| Atomic snapshot write (`tmp` + rename) | storage | crash during a write |
| Graceful drain (`bye`, flush, snapshot) on SIGTERM | replica | planned restarts |

**Why anti-entropy is necessary.** A CRDT guarantees convergence only for
operations that actually *arrive*. If a broadcast frame is dropped — an
unreliable link, a replica crashing mid-broadcast — the CRDT alone will never
notice. Every client therefore periodically sends its version vector and the
replica replies with whatever is missing. This turns "eventually delivered" into
"eventually consistent" and bounds the staleness window (test **R04** drops 50 %
of frames and still converges).

### 4.6 Security

- Passwords: **PBKDF2-HMAC-SHA256, 120 000 iterations, 16-byte random salt**;
  verified in constant time. Never stored or transmitted in plaintext (asserted
  by test S01, which greps the on-disk state).
- Tokens: HS256, signed with `COEDIT_JWT_SECRET`, with expiry. Short-lived
  (15 min) **document-scoped session tokens** are what a replica accepts.
- Authorisation: `owner > editor > viewer`. A viewer's operations are rejected
  server-side with 403 — enforcement is never left to the UI.
- **Operation-site binding**: a client may only author operations whose `site`
  equals its own `clientId`, so it cannot forge edits attributed to someone else.
- Internal endpoints (storage, session verification, replica mesh) require a
  shared `x-internal-key`, compared with `timingSafeEqual`.
- Input validation on every frame; path-traversal guard on `docId`; body-size,
  ops-per-message, document-size and rate limits.
- Secrets come exclusively from environment variables; `.env` is git-ignored and
  `.env.example` carries placeholders only.

---

## 5. Wire protocol

JSON over WebSocket. Every frame has a type `t`; most carry a correlation id
`corr` echoed in the reply so a request can be followed through the logs.

**Client → replica**

| Frame | Payload | Purpose |
|---|---|---|
| `hello` | `sessionToken`, `knownVV?` | authenticate + join (a `knownVV` means "resume") |
| `ops` | `ops[]`, `batchId` | submit locally generated operations |
| `cursor` | `pos` | presence |
| `sync` | `vv` | anti-entropy: "what am I missing?" |
| `ping` | `ts` | liveness |

**Replica → client**

| Frame | Payload |
|---|---|
| `welcome` | `snapshot` \| delta `ops`, `vv`, `presence`, `role`, `canEdit`, `replicaId` |
| `ops` | broadcast operations |
| `ack` | `batchId`, `applied`, `duplicates`, `vv` |
| `presence` | active users (**global**, gossiped across replicas) |
| `sync` | the operations the client was missing |
| `error` | `code`, `message` |
| `bye` | graceful shutdown notice |

**Replica ↔ replica**: `r-hello` (shared-key handshake), `r-ops` (replicated
operations, single hop), `r-presence` (gossiped active users), `r-ping`/`r-pong`.

**Operation format**

```jsonc
{ "id":"alice-3f2a:12", "t":"ins", "site":"alice-3f2a", "ctr":12,
  "lam":47, "after":"bob-91c4:8", "ch":"H" }
{ "id":"alice-3f2a:13", "t":"del", "site":"alice-3f2a", "ctr":13,
  "lam":48, "target":"bob-91c4:8" }
```

Each operation carries an **id**, **client id**, **operation type** and
**version information** (Lamport clock + per-site counter), and is always scoped
to a document by the session — exactly the metadata §8.3 requires.

---

## 6. Demonstration scenarios

`node scripts/demo.js` runs all nine mandatory scenarios of §8.4 and asserts the
outcome of each:

| # | Scenario | Verified outcome |
|---|---|---|
| 1 | Three clients open the same document | 3 users in presence, spread over 2 replicas |
| 2 | One edits, the others receive | propagation across replicas |
| 3 | Two clients insert at the **same position** | both survive, all converge |
| 4 | One inserts while another deletes | delete holds, concurrent insert preserved |
| 5 | Convergence check | clients **and** all server replicas byte-identical |
| 6 | Disconnect one client | the rest keep editing |
| 7 | Reconnect + re-sync | offline edits replayed, everyone converges |
| 8 | **Kill a replica** | automatic failover, editing continues |
| 9 | **Restart the server** | document restored byte-identically from storage |

### Fault injection

```bash
./scripts/chaos.sh status                # cluster view
./scripts/chaos.sh kill  collab-1        # SIGKILL  — crash
./scripts/chaos.sh stop  collab-1        # SIGSTOP  — frozen node (lease expires)
./scripts/chaos.sh cont  collab-1        # SIGCONT  — resume
./scripts/chaos.sh lossy collab-2 0.25   # restart with 25 % outgoing frame loss
./scripts/chaos.sh storage-down          # storage outage → dead-letter queue
./scripts/chaos.sh storage-up            # recovery → DLQ drains, no data lost
```

In the browser, the sidebar has **Drop my socket** and **Go offline / online**
so a reviewer can trigger reconnection and offline buffering interactively.

---

## 7. Testing

```bash
npm test                       # all 19
node tests/run-all.js C01 R02  # filter by id or name
```

Requirement: ≥ 8 functional, ≥ 2 concurrency, ≥ 2 fault, ≥ 2 security, ≥ 1
performance. **Delivered: 8 / 2 / 5 / 3 / 1 = 19.**

| Id | Category | What it proves |
|---|---|---|
| F01 | functional | register, login, session ticket issued for a replica |
| F02 | functional | three clients join, presence lists all three |
| F03 | functional | edit propagates to both peers |
| F04 | functional | insert **and** delete synchronise |
| F05 | functional | late joiner is snapshot-synchronised |
| F06 | functional | operation metadata (id, site, type, Lamport, counter, vv) |
| F07 | functional | a **cold replica** rebuilds identical text from storage |
| F08 | functional | sharing grants the right role |
| C01 | concurrency | three simultaneous inserts **at the same offset** converge, nothing lost |
| C02 | concurrency | insert vs delete on the same region, **across two replicas** |
| R01 | fault | hard disconnect → offline edits → reconnect → converge |
| R02 | fault | **SIGKILL a replica** → failover → converge (auto-restarts it after) |
| R03 | fault | duplicated + reordered operations are absorbed idempotently |
| R04 | fault | **50 % of broadcast frames dropped** → anti-entropy repairs it |
| R05 | fault | **storage outage** → DLQ buffers → drains on recovery, zero loss |
| S01 | security | missing / garbage / **forged** tokens rejected; PBKDF2 on disk |
| S02 | security | stranger cannot read, viewer cannot write or re-share |
| S03 | security | malformed op, **site spoofing**, oversized payload, path traversal |
| P01 | performance | latency, throughput, convergence, all replicas identical |

Every run writes `tests/report.json`.

---

## 8. Results

All 19 tests and all 9 demo scenarios pass.

### Scalability

![performance](docs/figures/performance.png)

Measured on a single host, 2 replicas, 50 operations per client
(`node scripts/benchmark.js`):

| Clients | latency p50 | latency p95 | throughput | convergence | lost ops | replicas identical |
|--:|--:|--:|--:|--:|--:|:--|
| 2 | 1.3 ms | 1.6 ms | 541 ops/s | 0 ms | 0 | yes |
| 4 | 1.2 ms | 1.8 ms | 1 130 ops/s | 0 ms | 0 | yes |
| 8 | 1.3 ms | 3.3 ms | 1 887 ops/s | 0 ms | 0 | yes |
| 16 | 1.3 ms | 2.4 ms | **3 738 ops/s** | 31 ms | 0 | yes |
| 24 | 1.3 ms | 1.9 ms | 2 985 ops/s | 32 ms | 0 | yes |
| 32 | 1.4 ms | 2.2 ms | 2 292 ops/s | 33 ms | 0 | yes |

**Reading the numbers.** Propagation latency stays flat (~1.3 ms p50) as
concurrency grows 16× — the cost of an operation does not depend on how many
editors there are, because an insert is O(1) amortised plus a bounded scan.
Throughput rises to a peak near 16 concurrent editors and then declines: past
that point a single-threaded Node event loop per replica is the bottleneck
(JSON serialisation and fan-out dominate). The honest conclusion is that a
replica saturates around ~3 700 ops/s and the way to scale further is more
replicas, not more clients per replica. **No operation was lost at any point,
and every replica held byte-identical text at every point.**

### Failover

![failover](docs/figures/failover.png)

Measured failover after `SIGKILL`: **151–276 ms** end to end (detect, re-ask the
Directory, reconnect to the survivor, delta re-sync), with no lost operations.
This is far below the 6 s lease TTL because the client reacts to its socket
closing rather than waiting for the lease to expire; the lease is the backstop
that handles a *frozen* node, which cannot close its sockets.

### Storage outage (test R05)

Storage killed mid-session: 14 operations buffered in the replica's dead-letter
queue, live editing **completely unaffected** (availability preserved), and on
restart the queue drained to 0 with all 28 operations durable — zero loss.

---

## 9. Configuration

All configuration is environment-driven (`src/common/util/config.js`); see
[`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `COEDIT_JWT_SECRET` | *(dev placeholder)* | **secret** — HS256 signing key |
| `COEDIT_INTERNAL_KEY` | *(dev placeholder)* | **secret** — service-to-service key |
| `COEDIT_DATA_DIR` | `./data` | op logs, snapshots, directory state |
| `DIRECTORY_URL` / `STORAGE_URL` | `127.0.0.1:7000/7100` | service endpoints |
| `LEASE_TTL_MS` / `HEARTBEAT_MS` | `6000` / `2000` | failure detection |
| `WS_PING_MS` | `5000` | client liveness sweep |
| `ANTI_ENTROPY_MS` | `2000` | client re-sync period |
| `SNAPSHOT_EVERY_OPS` | `200` | snapshot cadence |
| `PERSIST_BATCH_MS` | `250` | write-behind batching |
| `MAX_BODY_BYTES` / `MAX_OPS_PER_MESSAGE` / `MAX_DOC_CHARS` | `1 MiB` / `512` / `200000` | hard limits |
| `RATE_LIMIT_OPS_PER_SEC` | `2000` | per-connection rate limit |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `pretty` | `LOG_FORMAT=json` for machine-readable logs |
| `CHAOS_DROP_OUT` / `CHAOS_DUPLICATE` / `CHAOS_DELAY_MS` | `0` | fault injection |

The startup script sets `LOG_FORMAT=json`, so `logs/*.log` are newline-delimited
JSON records carrying node, timestamp, event type and result:

```bash
tail -f logs/collab-1.log | python3 -m json.tool --json-lines
grep ops_from_client logs/collab-*.log | tail -5
```

---

## 10. Deployment

### Docker Compose

```bash
cd deploy
cp ../.env.example .env      # set real secrets
docker compose up --build    # 5 containers on a private network
# UI: http://localhost:8080
docker compose up --scale collab=3 --build    # more replicas
```

Each service runs in its **own container with its own network identity**;
replicas discover each other only through the Directory.

### Multiple hosts / cloud

Set the advertised URLs so nodes are reachable across hosts:

```bash
# on the replica host
REPLICA_ID=collab-3 COLLAB_PORT=7203 \
COLLAB_WS_URL=ws://10.0.0.31:7203 \
DIRECTORY_URL=http://10.0.0.10:7000 \
STORAGE_URL=http://10.0.0.20:7100 \
node src/collab/server.js
```

`COLLAB_WS_URL` is what peers and the gateway dial; `COLLAB_PUBLIC_WS_URL` can
differ if clients reach the replica through a public address.

---

## 11. Repository layout

```
coedit-ds/
├── README.md
├── .env.example                  # sample config, no secrets
├── package.json                  # one runtime dependency: ws
├── src/
│   ├── common/
│   │   ├── crdt/rga.js           # ★ the RGA CRDT (fully commented)
│   │   ├── auth/tokens.js        # PBKDF2 + HS256, node:crypto only
│   │   └── util/{config,http,log}.js
│   ├── directory/server.js       # auth · naming · discovery · leases · ACL
│   ├── storage/server.js         # op log + snapshots
│   ├── collab/
│   │   ├── server.js             # WebSocket replica + replication mesh
│   │   ├── document.js           # per-document session, persistence, DLQ
│   │   └── protocol.js           # ★ wire protocol + validation
│   ├── gateway/server.js         # static UI + REST proxy + WS proxy
│   └── client/
│       ├── engine.js             # Node client: reconnect, failover, offline
│       ├── cli/index.js          # command-line client
│       └── web/{index.html,app.js,rga.browser.js}
├── tests/{run-all.js,harness.js} # 19 tests -> report.json
├── scripts/
│   ├── start-cluster.sh, stop-cluster.sh
│   ├── demo.js                   # the 9 mandatory scenarios
│   ├── chaos.sh                  # fault injection
│   ├── benchmark.js              # scalability sweep
│   └── make-figures.py           # report figures
├── deploy/{Dockerfile,docker-compose.yml}
└── docs/{report.pdf,slides.pdf,benchmark.json,figures/}
```

The CRDT exists in two synchronised implementations — `src/common/crdt/rga.js`
(Node) and `src/client/web/rga.browser.js` (browser). `tests/test-parity.js`
cross-checks them on randomised operation sequences.

---

## 12. Task assignment

> Replace the names/IDs with the real group members before submission, and make
> sure each member's commits are visible in the GitHub history.

| Member | Student ID | Responsibility | Main files |
|---|---|---|---|
| *Member 1* | *ID* | CRDT core, convergence proofs, concurrency tests | `src/common/crdt/`, `tests` C01–C02, R03–R04 |
| *Member 2* | *ID* | Collaboration replicas, replication mesh, presence, durability & DLQ | `src/collab/`, `src/storage/`, tests F05–F07, R05 |
| *Member 3* | *ID* | Directory (auth/discovery/leases/ACL), gateway, web + CLI clients, failover, security tests | `src/directory/`, `src/gateway/`, `src/client/`, tests S01–S03, R01–R02 |

Every member must be able to explain the overall architecture as well as their
own part.

---

## 13. Limitations and future work

Stated honestly, because the oral examination will probe them:

1. **Tombstones are never collected.** Deleted characters remain as tombstones
   forever, so a long-lived document's metadata grows monotonically. A real
   system needs causal-stability-based garbage collection (safe once every
   replica has seen an operation) — not implemented here.
2. **Replication is single-hop and unordered.** A replica forwards operations to
   its peers directly; with `R` replicas that is `O(R²)` links. It is correct
   because the CRDT tolerates any order, but it would not scale past a handful
   of replicas. Real deployments would use a gossip overlay or a log (Kafka/NATS).
3. **The Storage Service is a single point of failure for durability.** Live
   editing survives its loss (proved by R05), but the op log is not itself
   replicated. Replicating it — or writing to a quorum — is the obvious next step.
4. **Plain text only.** No rich text, no formatting attributes. RGA extends to
   these but the UI does not.
5. **The Directory is not replicated.** If it dies, existing sessions keep
   working (they already hold a socket) but new joins and failovers cannot be
   served. Its state is small and file-backed, so a standby is straightforward.
6. **Undo/redo and version history** are not implemented; the op log makes both
   feasible (a snapshot + replay to any sequence number).
7. **No TLS in the default setup.** The protocol runs over plain TCP locally;
   in production the gateway should terminate TLS (`wss://`), which the client
   already selects automatically when the page is served over HTTPS.
8. **Cursor positions are sent as integer offsets**, so a remote cursor can drift
   by a character under heavy concurrent editing. Anchoring presence to element
   ids (the CRDT already supports `positionOfId`) would fix it.

---

## 14. References and academic integrity

**References**

1. H.-G. Roh, M. Jeon, J.-S. Kim, J. Lee. *Replicated abstract data types:
   Building blocks for collaborative applications.* Journal of Parallel and
   Distributed Computing, 71(3):354–368, 2011. — the RGA algorithm.
2. M. Shapiro, N. Preguiça, C. Baquero, M. Zawirski. *Conflict-free Replicated
   Data Types.* INRIA Research Report RR-7687, 2011. — SEC, CvRDT/CmRDT.
3. L. Lamport. *Time, Clocks, and the Ordering of Events in a Distributed
   System.* CACM 21(7):558–565, 1978. — logical clocks.
4. C. A. Ellis, S. J. Gibbs. *Concurrency Control in Groupware Systems.*
   SIGMOD 1989. — Operational Transformation, the alternative we did not choose.
5. D. G. Thaler, C. V. Ravishankar. *Using name-based mappings to increase hit
   rates.* IEEE/ACM ToN 6(1), 1998. — rendezvous (HRW) hashing.
6. C. Gray, D. Cheriton. *Leases: An efficient fault-tolerant mechanism for
   distributed file cache consistency.* SOSP 1989. — leases.
7. A. S. Tanenbaum, M. van Steen. *Distributed Systems: Principles and
   Paradigms*, 3rd ed., 2017. — replication, naming, fault tolerance.
8. RFC 6455, *The WebSocket Protocol*, IETF, 2011.
9. RFC 8018, *PKCS #5: Password-Based Cryptography Specification v2.1* — PBKDF2.
10. RFC 7519, *JSON Web Token (JWT)*, IETF, 2015.

**Third-party code**

- [`ws`](https://github.com/websockets/ws) (MIT) — WebSocket transport. The only
  runtime dependency.
- `matplotlib` — used offline to render report figures; not part of the system.

Everything else — the RGA implementation, the replication mesh, discovery and
leasing, the persistence layer, the protocol, the clients, the harness and all
tests — was written by the group for this project.

**Declaration.** AI assistance was used during development. Every algorithm,
design decision and line of delivered code has been reviewed, tested and is
understood by the group, which takes full responsibility for the result. The
sources above are cited for the algorithms they contributed.
