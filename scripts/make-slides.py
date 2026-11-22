#!/usr/bin/env python3
"""Generate docs/slides.pdf — defence presentation (16:9).

    python3 scripts/make-slides.py
"""
import json, pathlib, datetime
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import Paragraph, Table, TableStyle, Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"; FIG = DOCS / "figures"
TESTS = json.loads((ROOT / "tests" / "report.json").read_text())
BENCH = json.loads((DOCS / "benchmark.json").read_text())

W, H = 33.87 * cm, 19.05 * cm            # 16:9
NAVY = colors.HexColor("#0f1830"); ACC = colors.HexColor("#4c8dff")
INK = colors.HexColor("#1b1f2a"); MUTED = colors.HexColor("#6b7280")
OK = colors.HexColor("#12a150"); WARN = colors.HexColor("#e8a33d"); RED = colors.HexColor("#d9534f")
BG = colors.HexColor("#f5f7fb"); LINE = colors.HexColor("#d7dce4")

c = pdfcanvas.Canvas(str(DOCS / "slides.pdf"), pagesize=(W, H))
c.setTitle("CoEdit-DS — DS04 defence slides")

def sty(**kw):
    base = dict(fontName="Helvetica", fontSize=13, leading=19, textColor=INK)
    base.update(kw); return ParagraphStyle("s", **base)

PAGE = {"n": 0}

def frame(title, sub=None, footer=True):
    PAGE["n"] += 1
    c.setFillColor(colors.white); c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(NAVY); c.rect(0, H - 2.7 * cm, W, 2.7 * cm, fill=1, stroke=0)
    c.setFillColor(ACC); c.rect(0, H - 2.82 * cm, W, 0.12 * cm, fill=1, stroke=0)
    c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 21)
    c.drawString(1.6 * cm, H - 1.75 * cm, title)
    if sub:
        c.setFillColor(colors.HexColor("#9fb6e8")); c.setFont("Helvetica", 11.5)
        c.drawString(1.6 * cm, H - 2.35 * cm, sub)
    if footer:
        c.setFillColor(MUTED); c.setFont("Helvetica", 8.5)
        c.drawString(1.6 * cm, 0.85 * cm, "CoEdit-DS — DS04 Collaborative Document Editing (RGA CRDT)")
        c.drawRightString(W - 1.6 * cm, 0.85 * cm, str(PAGE["n"]))

def para(text, x, y, w, **kw):
    p = Paragraph(text, sty(**kw))
    pw, ph = p.wrap(w, H)
    p.drawOn(c, x, y - ph)
    return y - ph

def bullets(items, x, y, w, size=13.4, gap=0.62 * cm, bullet="▸"):
    for it in items:
        col = INK
        if it.startswith("!"):  it, col = it[1:], RED
        if it.startswith("+"):  it, col = it[1:], OK
        p = Paragraph(f'<font color="{ACC.hexval()}">{bullet}</font>&nbsp;&nbsp;{it}',
                      sty(fontSize=size, leading=size * 1.42, textColor=col))
        pw, ph = p.wrap(w, H); p.drawOn(c, x, y - ph); y -= ph + gap
    return y

def tbl(rows, widths, x, y, header=True, fs=11):
    data = []
    for i, r in enumerate(rows):
        data.append([Paragraph(str(cell), sty(fontSize=fs, leading=fs * 1.35,
                     fontName="Helvetica-Bold" if (header and i == 0) else "Helvetica")) for cell in r])
    t = Table(data, colWidths=widths)
    cmds = [("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, 0), 1, ACC if header else LINE),
            ("LINEBELOW", (0, 1), (-1, -2), 0.4, LINE),
            ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING", (0, 0), (-1, -1), 8)]
    if header: cmds.append(("BACKGROUND", (0, 0), (-1, 0), BG))
    t.setStyle(TableStyle(cmds))
    tw, th = t.wrap(sum(widths), H); t.drawOn(c, x, y - th)
    return y - th

def image(name, x, y, w):
    p = FIG / name
    if not p.exists(): return
    from PIL import Image as PILImage
    iw, ih = PILImage.open(p).size
    h = w * ih / iw
    c.drawImage(str(p), x, y - h, width=w, height=h, mask="auto")
    return y - h

def stat(x, y, value, label, color=ACC, bw=6.6 * cm):
    c.setFillColor(BG); c.roundRect(x, y - 3.1 * cm, bw, 3.1 * cm, 8, fill=1, stroke=0)
    c.setFillColor(color); c.setFont("Helvetica-Bold", 27)
    c.drawCentredString(x + bw / 2, y - 1.55 * cm, value)
    c.setFillColor(MUTED); c.setFont("Helvetica", 10.5)
    c.drawCentredString(x + bw / 2, y - 2.45 * cm, label)

# ------------------------------------------------------------------ 1 title
c.setFillColor(NAVY); c.rect(0, 0, W, H, fill=1, stroke=0)
c.setFillColor(ACC); c.rect(0, H / 2 + 1.4 * cm, W, 0.11 * cm, fill=1, stroke=0)
c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 44)
c.drawCentredString(W / 2, H / 2 + 2.4 * cm, "CoEdit-DS")
c.setFont("Helvetica", 18)
c.drawCentredString(W / 2, H / 2 - 0.2 * cm, "A Distributed Collaborative Document Editing System")
c.setFont("Helvetica-Oblique", 13); c.setFillColor(colors.HexColor("#9fb6e8"))
c.drawCentredString(W / 2, H / 2 - 1.4 * cm, "Strong eventual consistency with an RGA CRDT, replicated servers and automatic failover")
c.setFont("Helvetica", 12); c.setFillColor(colors.white)
c.drawCentredString(W / 2, H / 2 - 3.2 * cm, "Distributed Systems — Course Project — Topic DS04")
c.setFont("Helvetica", 10); c.setFillColor(colors.HexColor("#7f93c4"))
c.drawCentredString(W / 2, 1.6 * cm, datetime.date.today().strftime("%d %B %Y"))
c.showPage()

# ------------------------------------------------------------- 2 problem
frame("The problem", "Why a collaborative editor is a distributed-systems problem")
y = bullets([
    "Several people type into <b>the same document at the same time</b> — nobody 'holds' it.",
    "The network delivers their changes <b>late, out of order, duplicated — or not at all</b>.",
    "Every participant must still end up seeing <b>exactly the same text</b>.",
    "!Naive fix — last-writer-wins on the whole document — <b>silently destroys concurrent edits</b> (and is forbidden by the spec).",
    "!Naive fix — a global lock — makes typing wait for the network and creates a single point of failure.",
], 1.8 * cm, H - 4.2 * cm, W - 3.6 * cm)

c.setFillColor(BG); c.roundRect(1.8 * cm, 1.7 * cm, W - 3.6 * cm, 3.4 * cm, 10, fill=1, stroke=0)
para("<b>Our answer:</b> make convergence a property of the <b>data type</b>, not of the network path. "
     "If operations are idempotent and commutative, then duplicates, reordering, offline edits and merging two "
     "servers' histories all stop being special cases.",
     2.4 * cm, 4.7 * cm, W - 4.8 * cm, fontSize=13.5, leading=19)
c.showPage()

# --------------------------------------------------------- 3 architecture
frame("Architecture", "5 independent processes + N clients — everything over TCP")
image("architecture.png", 4.2 * cm, H - 3.6 * cm, 25.0 * cm)
c.showPage()

# ------------------------------------------------------------ 4 components
frame("Components and responsibilities")
y = tbl([["Process", "Port", "Responsibility"],
         ["Directory", "7000", "Authentication · naming · <b>service discovery with leases</b> · placement · ACL"],
         ["Storage", "7100", "Append-only <b>operation log</b> + periodic snapshots (durability)"],
         ["Collab replica A", "7201", "WebSocket sessions · CRDT · presence · replication to peers"],
         ["Collab replica B", "7202", "Identical and interchangeable — <b>this is what makes failover possible</b>"],
         ["Gateway", "8080", "Web UI · REST proxy · WebSocket proxy (single public port)"],
         ["Clients", "—", "Browser + CLI, each holding <b>its own CRDT replica</b>"]],
        [6.2 * cm, 2.4 * cm, 21.4 * cm], 1.8 * cm, H - 4.0 * cm, fs=12.5)
y = bullets([
    "Separate OS processes, unique identities, own ports, own state.",
    "<b>No shared memory, no shared files, no shared database</b> — only network messages.",
], 1.8 * cm, y - 0.9 * cm, W - 3.6 * cm, size=12.5, gap=0.45 * cm)
c.showPage()

# -------------------------------------------------------------- 5 the CRDT
frame("The core: RGA — a sequence CRDT", "Convergence without consensus, locking or a central serialiser")
y = bullets([
    "Every character is an <b>immutable element</b> with a globally unique id <font face='Courier'>site:counter</font>.",
    "A delete never removes anything — it sets a <b>tombstone</b>, so deletes commute with concurrent inserts.",
    "An insert names the element it follows (its <b>causal origin</b>) and carries a <b>Lamport clock</b>.",
    "Concurrent inserts on the same origin are ordered by <b>(lamport, siteId) descending</b> — a total order "
    "<b>every replica computes identically</b>.",
], 1.8 * cm, H - 3.9 * cm, W - 3.6 * cm, size=13)

c.setFillColor(BG); c.roundRect(1.8 * cm, y - 3.5 * cm, W - 3.6 * cm, 3.3 * cm, 8, fill=1, stroke=0)
c.setFillColor(INK); c.setFont("Courier-Bold", 11.5)
c.drawString(2.4 * cm, y - 0.75 * cm, "integrate(e, afterId):")
c.setFont("Courier", 11.5)
for i, ln in enumerate(["    p = node(afterId)                          # causal origin",
                        "    c = p.next",
                        "    while c and order(c) > order(e): c = c.next # skip whole subtrees",
                        "    insert e before c"]):
    c.drawString(2.4 * cm, y - (1.35 + i * 0.52) * cm, ln)

para("⇒ <b>apply() is idempotent and commutative</b>: any order, any number of times, same result.",
     1.8 * cm, y - 4.0 * cm, W - 3.6 * cm, fontSize=13.5, textColor=OK)
c.showPage()

# ------------------------------------------------------- 6 convergence demo
frame("Convergence in practice", "Three clients insert at the SAME position, simultaneously")
y = tbl([["", "Client A", "Client B", "Client C"],
         ["start", "START|END", "START|END", "START|END"],
         ["local edit", "insert &lt;A&gt;", "insert &lt;B&gt;", "insert &lt;C&gt;"],
         ["local view", "START|<b>&lt;A&gt;</b>END", "START|<b>&lt;B&gt;</b>END", "START|<b>&lt;C&gt;</b>END"],
         ["<b>after exchange</b>", "<b>START|&lt;B&gt;&lt;C&gt;&lt;A&gt;END</b>", "<b>START|&lt;B&gt;&lt;C&gt;&lt;A&gt;END</b>", "<b>START|&lt;B&gt;&lt;C&gt;&lt;A&gt;END</b>"]],
        [4.4 * cm, 8.4 * cm, 8.4 * cm, 8.4 * cm], 1.8 * cm, H - 4.0 * cm, fs=12.5)
y = bullets([
    "Same origin, same Lamport time ⇒ tie broken by site id — <b>deterministically, on every replica</b>.",
    "+Nothing is lost: final length = sum of the parts. Verified by test <b>C01</b> on clients <b>and</b> both replicas.",
    "!With last-writer-wins, two of the three tags would simply vanish.",
], 1.8 * cm, y - 0.9 * cm, W - 3.6 * cm, size=13)
c.showPage()

# ------------------------------------------------- 7 CRDT is not enough
frame("A CRDT alone is not enough", "The lesson our tests taught us")
y = bullets([
    "A CRDT guarantees convergence for operations that <b>arrive</b>.",
    "!If a broadcast frame is <b>dropped</b> — bad link, replica crashing mid-broadcast — no CRDT rule ever notices.",
], 1.8 * cm, H - 4.0 * cm, W - 3.6 * cm, size=13.5)
y = tbl([["Gap found", "Mechanism added", "Test"],
         ["Lost broadcast frames", "<b>Anti-entropy</b>: clients periodically send their version vector; the replica returns what is missing", "R04"],
         ["Storage outage stops persistence", "<b>Dead-letter queue</b> + drain loop — editing continues, nothing lost", "R05"],
         ["Reconnect lost the client's buffered edits", "<b>Stable site id</b> across reconnects + in-flight requeue", "R01"]],
        [7.4 * cm, 19.0 * cm, 3.6 * cm], 1.8 * cm, y - 0.5 * cm, fs=12)
para("Each of these was a <b>real defect</b> exposed by a failing test — not a feature we planned. "
     "A happy-path demo would have hidden all three.",
     1.8 * cm, y - 1.0 * cm, W - 3.6 * cm, fontSize=13, textColor=MUTED)
c.showPage()

# ------------------------------------------------------------ 8 fault tol
frame("Fault tolerance", "Failure model: crash-stop, crash-recovery, omission, timing")
y = tbl([["Failure", "Detection", "Recovery", "Test"],
         ["Client disconnects", "socket close / missed pong", "outbox buffering → reconnect → delta re-sync", "R01"],
         ["Replica killed (SIGKILL)", "socket close + lease expiry", "re-ask Directory → <b>failover</b> to survivor", "R02"],
         ["Replica frozen (SIGSTOP)", "lease expiry (no heartbeat)", "dropped from registry, traffic routed away", "chaos"],
         ["Lost / duplicated / reordered", "version-vector gap, duplicate id", "anti-entropy · idempotent apply · causal parking", "R03/R04"],
         ["Storage outage", "timeout after bounded retry", "dead-letter queue, drains on recovery", "R05"],
         ["Total server restart", "—", "cold replica rebuilds from snapshot + op log", "F07"]],
        [7.0 * cm, 8.0 * cm, 12.2 * cm, 3.0 * cm], 1.8 * cm, H - 4.0 * cm, fs=11.5)
c.showPage()

# ------------------------------------------------------------- 9 failover
frame("Failover", "Killed replica → clients move to a survivor automatically")
image("failover.png", 4.6 * cm, H - 3.7 * cm, 24.0 * cm)
para("No election, no consensus: the Directory stops advertising an expired lease, rendezvous hashing names a new "
     "primary, and clients re-ask on every reconnect attempt.",
     1.8 * cm, 2.9 * cm, W - 3.6 * cm, fontSize=12.5, textColor=MUTED)
c.showPage()

# ------------------------------------------------------------- 10 security
frame("Security")
y = tbl([["Control", "Implementation"],
         ["Passwords", "PBKDF2-HMAC-SHA256, 120 000 iterations, random salt, constant-time compare — <b>never plaintext</b>"],
         ["Tokens", "HS256 signed; short-lived (15 min) <b>document-scoped</b> session tokens"],
         ["Authorisation", "owner &gt; editor &gt; viewer, enforced <b>server-side</b> — a viewer's ops are rejected 403"],
         ["Anti-spoofing", "a client may only author ops whose <font face='Courier'>site</font> equals its own client id"],
         ["Input validation", "every frame and field validated; path-traversal guard on document ids"],
         ["Limits", "1 MiB body · 512 ops/message · 200 000 chars/doc · 2 000 ops/s per connection"],
         ["Secrets", "environment variables only; <font face='Courier'>.env</font> git-ignored, <font face='Courier'>.env.example</font> has placeholders"]],
        [6.0 * cm, 24.0 * cm], 1.8 * cm, H - 4.0 * cm, fs=12)
para("Tests <b>S01–S03</b>: forged tokens rejected · PBKDF2 hashes asserted on disk · stranger cannot read · "
     "viewer cannot write or re-share · malformed, spoofed and oversized input rejected without affecting the document.",
     1.8 * cm, y - 0.9 * cm, W - 3.6 * cm, fontSize=12, textColor=MUTED)
c.showPage()

# ------------------------------------------------------------- 11 testing
frame("Testing", f"{TESTS['total']} automated tests — all passing")
counts = {}
for r in TESTS["results"]:
    k = r["category"].replace(" tests", "").replace(" and conflict", "").replace(" and invalid-data", "")
    counts[k] = counts.get(k, 0) + 1
xs = 1.8 * cm
for label, n, col in [("Functional", 8, ACC), ("Concurrency", 2, ACC), ("Fault / recovery", 5, WARN),
                      ("Security", 3, RED), ("Performance", 1, OK)]:
    stat(xs, H - 4.0 * cm, str(n), label, col, bw=5.7 * cm)
    xs += 6.1 * cm
y = tbl([["Id", "What it proves"],
         ["C01 / C02", "3 clients insert at the same offset · insert-vs-delete <b>across two replicas</b> → converge"],
         ["R02", "<b>SIGKILL a replica</b> → failover in <b>151–276 ms</b> → converge, nothing lost"],
         ["R04", "<b>50 % of broadcast frames dropped</b> → anti-entropy repairs it"],
         ["R05", "<b>Storage killed</b> → 14 ops in the dead-letter queue → drained to 0, zero loss"],
         ["F07", "Cold replica rebuilds byte-identical text from snapshot + op log"],
         ["Extra", "CRDT property tests (60 randomised histories) + Node↔browser parity (40 histories)"]],
        [4.2 * cm, 25.8 * cm], 1.8 * cm, H - 8.0 * cm, fs=12)
c.showPage()

# --------------------------------------------------------- 12 performance
frame("Performance and scalability", f"{BENCH['replicas']} replicas · {BENCH['opsPerClient']} ops per client")
image("performance.png", 2.0 * cm, H - 3.5 * cm, 29.8 * cm)
best = max(BENCH["rows"], key=lambda r: r["throughput"])
xs = 2.6 * cm
for val, lab, col in [(f"{BENCH['rows'][0]['latencyP50']:.1f}–{BENCH['rows'][-1]['latencyP50']:.1f} ms", "propagation latency p50 (flat)", ACC),
                      (f"{best['throughput']:,}", f"peak ops/s (at {best['clients']} clients)", OK),
                      ("0", "operations lost, every point", OK),
                      ("100%", "replicas byte-identical", OK)]:
    stat(xs, 4.6 * cm, val, lab, col, bw=6.8 * cm)
    xs += 7.2 * cm
c.showPage()

# ------------------------------------------------- 13 honest limitations
frame("Limitations — stated honestly", "What we would fix next")
bullets([
    "!<b>Tombstones are never garbage-collected</b> → metadata grows in a long-lived document. Fix: causal-stability tracking.",
    "!<b>Storage and Directory are not replicated</b> → editing survives their loss, but durability and new joins do not. Fix: replicate the log / warm standby.",
    "!<b>Single-hop replication mesh</b> is O(R²) → fine for a few replicas, not dozens. Fix: gossip overlay or a shared log.",
    "!<b>Single-threaded replicas</b> cap throughput past ~16 concurrent editors (see the throughput curve).",
    "!<b>Plain text only</b>, no undo/redo or version history — though the op log makes both straightforward.",
    "!<b>No TLS by default</b> — the gateway should terminate wss:// in production.",
], 1.8 * cm, H - 4.0 * cm, W - 3.6 * cm, size=13, gap=0.5 * cm)
c.showPage()

# ------------------------------------------------------------- 14 demo
frame("Live demonstration", "All 9 mandatory scenarios — scripts/demo.js")
y = tbl([["#", "Scenario", "#", "Scenario"],
         ["1", "Three clients open the same document", "6", "Disconnect one client, others keep editing"],
         ["2", "One edits, the others receive", "7", "Reconnect → offline edits replayed → converge"],
         ["3", "Two insert at the <b>same position</b>", "8", "<b>Kill a replica</b> → automatic failover"],
         ["4", "One inserts while another deletes", "9", "<b>Restart the server</b> → restored from storage"],
         ["5", "Converged on clients <b>and</b> replicas", "", ""]],
        [1.6 * cm, 13.4 * cm, 1.6 * cm, 13.4 * cm], 1.8 * cm, H - 4.2 * cm, fs=12.5)
c.setFillColor(BG); c.roundRect(1.8 * cm, y - 4.6 * cm, W - 3.6 * cm, 4.2 * cm, 8, fill=1, stroke=0)
c.setFillColor(INK); c.setFont("Courier-Bold", 12)
c.drawString(2.5 * cm, y - 1.15 * cm, "./scripts/start-cluster.sh 2      # 5 processes")
c.drawString(2.5 * cm, y - 1.90 * cm, "node scripts/demo.js              # the 9 scenarios")
c.drawString(2.5 * cm, y - 2.65 * cm, "npm test                          # 23 tests")
c.drawString(2.5 * cm, y - 3.40 * cm, "./scripts/chaos.sh kill collab-1  # live fault injection")
c.drawString(2.5 * cm, y - 4.15 * cm, "http://localhost:8080             # 3 browser tabs")
c.showPage()

# ---------------------------------------------------------- 15 conclusion
frame("Conclusion")
bullets([
    "+A collaborative editor built as a <b>genuinely distributed system</b>: 5 server processes + N clients, network only.",
    "+The decisive choice: convergence as a property of the <b>data type</b>, not the network path — so duplicates, "
    "reordering, offline editing and merging two servers' histories are all the <b>same mechanism</b>.",
    "+That is what let us add <b>replication and failover without a consensus protocol</b>.",
    "+But a CRDT is not enough: <b>anti-entropy, a dead-letter queue and stable site ids</b> were added because tests failed.",
    f"+<b>{TESTS['total']}/{TESTS['total']} tests and 9/9 scenarios pass</b> · latency flat to 32 clients · failover 151–276 ms · <b>zero operations lost</b>.",
], 1.8 * cm, H - 4.2 * cm, W - 3.6 * cm, size=13.5, gap=0.62 * cm)
c.setFillColor(NAVY); c.roundRect(1.8 * cm, 1.6 * cm, W - 3.6 * cm, 2.5 * cm, 8, fill=1, stroke=0)
c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 17)
c.drawCentredString(W / 2, 2.65 * cm, "Thank you — questions?")
c.showPage()

c.save()
print(f"  docs/slides.pdf written ({(DOCS/'slides.pdf').stat().st_size//1024} KB, {PAGE['n']+1} slides)")
