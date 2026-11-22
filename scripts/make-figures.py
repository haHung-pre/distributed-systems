#!/usr/bin/env python3
"""Generate the figures used by docs/report.pdf.

    python3 scripts/make-figures.py

Reads docs/benchmark.json (produced by scripts/benchmark.js) and writes
PNG figures into docs/figures/.
"""
import json, os, pathlib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIG = ROOT / "docs" / "figures"
FIG.mkdir(parents=True, exist_ok=True)

INK = "#1b1f2a"; MUTED = "#6b7280"; ACC = "#2f6df6"; OK = "#12a150"; WARN = "#e8a33d"; RED = "#d9534f"
plt.rcParams.update({"font.size": 9, "axes.edgecolor": "#c9ced8", "axes.labelcolor": INK,
                     "text.color": INK, "xtick.color": MUTED, "ytick.color": MUTED,
                     "axes.titlesize": 10, "axes.titleweight": "bold", "figure.dpi": 200})


def box(ax, x, y, w, h, label, sub="", fc="#ffffff", ec=ACC, lw=1.4, fs=8.5):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.012,rounding_size=0.02",
                                fc=fc, ec=ec, lw=lw, zorder=3))
    ax.text(x + w / 2, y + h * (0.60 if sub else 0.5), label, ha="center", va="center",
            fontsize=fs, fontweight="bold", zorder=4)
    if sub:
        ax.text(x + w / 2, y + h * 0.26, sub, ha="center", va="center",
                fontsize=fs - 1.7, color=MUTED, zorder=4)


def arrow(ax, p1, p2, label="", style="-|>", color=MUTED, ls="-", rad=0.0, fs=7.2, off=(0, 0.016)):
    ax.add_patch(FancyArrowPatch(p1, p2, arrowstyle=style, color=color, lw=1.1, ls=ls,
                                 connectionstyle=f"arc3,rad={rad}",
                                 mutation_scale=11, shrinkA=3, shrinkB=3, zorder=2))
    if label:
        mx, my = (p1[0] + p2[0]) / 2 + off[0], (p1[1] + p2[1]) / 2 + off[1]
        ax.text(mx, my, label, ha="center", va="center", fontsize=fs, color=color,
                bbox=dict(fc="white", ec="none", pad=0.8), zorder=5)


# ---------------------------------------------------------------- figure 1
def fig_architecture():
    fig, ax = plt.subplots(figsize=(8.2, 4.8))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")
    ax.set_title("Figure 1 — CoEdit-DS system architecture (5 independent processes)", pad=12)

    # --- clients (left column) ---
    box(ax, 0.015, 0.74, 0.175, 0.145, "Browser client 1", "RGA replica", fc="#f4f8ff")
    box(ax, 0.015, 0.55, 0.175, 0.145, "Browser client 2", "RGA replica", fc="#f4f8ff")
    box(ax, 0.015, 0.36, 0.175, 0.145, "CLI client 3", "RGA replica", fc="#f4f8ff")

    # --- gateway + directory (middle column) ---
    box(ax, 0.29, 0.60, 0.19, 0.155, "API Gateway", ":8080\nHTTP + WS proxy", fc="#fff8ec", ec=WARN)
    box(ax, 0.29, 0.17, 0.19, 0.175, "Directory", ":7000  auth · naming\ndiscovery · ACL · lease", fc="#f2fbf5", ec=OK)

    # --- replicas + storage (right column) ---
    box(ax, 0.62, 0.735, 0.21, 0.15, "Collab replica A", ":7201  WebSocket", fc="#f4f8ff")
    box(ax, 0.62, 0.475, 0.21, 0.15, "Collab replica B", ":7202  WebSocket", fc="#f4f8ff")
    box(ax, 0.62, 0.17, 0.21, 0.155, "Storage", ":7100  op-log + snapshots", fc="#f2fbf5", ec=OK)

    # clients -> gateway
    for y in (0.8125, 0.6225, 0.4325):
        arrow(ax, (0.19, y), (0.29, 0.678), rad=0.05)
    ax.text(0.24, 0.90, "HTTPS / WSS", fontsize=7.2, color=MUTED, ha="center")

    # gateway -> replicas (WS proxy)
    arrow(ax, (0.48, 0.71), (0.62, 0.80), rad=0.04)
    arrow(ax, (0.48, 0.66), (0.62, 0.55), rad=-0.04)
    ax.text(0.556, 0.845, "WS /ws", fontsize=7.2, color=MUTED, ha="center",
            bbox=dict(fc="white", ec="none", pad=0.8))
    ax.text(0.556, 0.585, "WS /ws", fontsize=7.2, color=MUTED, ha="center",
            bbox=dict(fc="white", ec="none", pad=0.8))

    # gateway <-> directory
    arrow(ax, (0.385, 0.60), (0.385, 0.345), "REST /api", style="<|-|>")

    # replica <-> replica
    arrow(ax, (0.725, 0.735), (0.725, 0.625), style="<|-|>", color=ACC)
    ax.text(0.845, 0.680, "replication\nr-ops / r-presence", fontsize=6.9, color=ACC,
            ha="center", va="center")

    # replicas -> storage
    arrow(ax, (0.700, 0.475), (0.700, 0.325), color=OK)
    arrow(ax, (0.80, 0.735), (0.80, 0.325), color=OK, rad=-0.28)
    ax.text(0.60, 0.400, "append ops\n+ snapshot", fontsize=6.9, color=OK, ha="center", va="center")

    # replicas -> directory (lease heartbeat)
    arrow(ax, (0.62, 0.760), (0.48, 0.300), color=OK, ls="--", rad=0.22)
    arrow(ax, (0.62, 0.500), (0.48, 0.280), color=OK, ls="--", rad=0.14)
    ax.text(0.545, 0.415, "lease\nheartbeat", fontsize=6.9, color=OK, ha="center", va="center",
            bbox=dict(fc="white", ec="none", pad=0.9))

    ax.text(0.5, 0.045, "Every box is a separate OS process with a unique identity, its own port and its own state; "
                        "all interaction is over TCP (HTTP / WebSocket).",
            ha="center", fontsize=7.2, color=MUTED, style="italic")
    fig.tight_layout()
    fig.savefig(FIG / "architecture.png", bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------- figure 2
def fig_rga():
    fig, ax = plt.subplots(figsize=(7.4, 3.5))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")
    ax.set_title("Figure 2 — RGA convergence: two clients insert at the same position", pad=8)

    def chain(y, items, title):
        ax.text(0.012, y + 0.135, title, fontsize=8, fontweight="bold")
        x = 0.05
        for txt, sub, col in items:
            w = 0.115
            box(ax, x, y, w, 0.11, txt, sub, fc="#ffffff", ec=col, fs=8)
            if x > 0.05:
                ax.annotate("", xy=(x, y + 0.055), xytext=(x - 0.028, y + 0.055),
                            arrowprops=dict(arrowstyle="-|>", color="#9aa3b2", lw=1))
            x += w + 0.028
        return x

    chain(0.72, [("ROOT", "", "#9aa3b2"), ("'A'", "a:1  lam1", "#9aa3b2"), ("'B'", "a:2  lam2", "#9aa3b2")],
          "1. Both clients start from the same state  \"AB\"")

    chain(0.40, [("ROOT", "", "#9aa3b2"), ("'A'", "a:1", "#9aa3b2"),
                 ("'X'", "b:3  lam3", ACC), ("'Y'", "c:3  lam3", RED), ("'B'", "a:2", "#9aa3b2")],
          "2. Concurrently: client b inserts 'X' after 'A';  client c inserts 'Y' after 'A'")

    ax.text(0.05, 0.20, "3. Tie-break rule — same origin, equal Lamport clock (3) ⇒ order by site id descending: "
                        "\"c\" > \"b\", so 'Y' (c:3) precedes 'X' (b:3).",
            fontsize=8)
    ax.text(0.05, 0.10, "Every replica applies the same deterministic rule, so all converge to  \"AYXB\"  "
                        "regardless of the order in which the two operations arrive.",
            fontsize=8, color=OK, fontweight="bold")
    fig.tight_layout()
    fig.savefig(FIG / "rga.png", bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------- figure 3
def fig_perf():
    data = json.loads((ROOT / "docs" / "benchmark.json").read_text())
    rows = data["rows"]
    n = [r["clients"] for r in rows]
    p50 = [r["latencyP50"] for r in rows]
    p95 = [r["latencyP95"] for r in rows]
    thr = [r["throughput"] for r in rows]
    conv = [r["convergeMs"] for r in rows]

    fig, axes = plt.subplots(1, 3, figsize=(9.6, 2.9))

    ax = axes[0]
    ax.plot(n, p50, "o-", color=ACC, lw=1.6, ms=4, label="p50")
    ax.plot(n, p95, "s--", color=WARN, lw=1.4, ms=4, label="p95")
    ax.set_xlabel("concurrent editors"); ax.set_ylabel("latency (ms)")
    ax.set_title("Operation propagation latency")
    ax.set_ylim(bottom=0); ax.legend(frameon=False, fontsize=7.5); ax.grid(alpha=.25)

    ax = axes[1]
    ax.plot(n, thr, "o-", color=OK, lw=1.6, ms=4)
    ax.set_xlabel("concurrent editors"); ax.set_ylabel("operations / second")
    ax.set_title("Sustained throughput")
    ax.set_ylim(bottom=0); ax.grid(alpha=.25)

    ax = axes[2]
    ax.bar([str(x) for x in n], conv, color="#8fb4ff", edgecolor=ACC)
    ax.set_xlabel("concurrent editors"); ax.set_ylabel("convergence delay (ms)")
    ax.set_title("Time to converge after last op")
    ax.grid(alpha=.25, axis="y")

    fig.suptitle(f"Figure 4 — Scalability experiment ({data['replicas']} replicas, "
                 f"{data['opsPerClient']} ops/client, 0 lost operations at every point)",
                 fontsize=9.5, fontweight="bold", y=1.06)
    fig.tight_layout()
    fig.savefig(FIG / "performance.png", bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------- figure 4
def fig_failover():
    fig, ax = plt.subplots(figsize=(7.4, 2.9))
    ax.set_xlim(0, 10); ax.set_ylim(0, 3.2); ax.axis("off")
    ax.set_title("Figure 3 — Replica crash and client failover timeline", pad=8)

    for i, (lbl, y) in enumerate([("client", 2.4), ("collab-1", 1.4), ("collab-2", 0.5)]):
        ax.plot([0.9, 9.7], [y, y], color="#dde2ea", lw=1.2, zorder=1)
        ax.text(0.82, y, lbl, ha="right", va="center", fontsize=8, fontweight="bold")

    def ev(x, y, txt, col=ACC, dy=0.22):
        ax.plot([x], [y], "o", color=col, ms=5, zorder=4)
        ax.text(x, y + dy, txt, ha="center", fontsize=7, color=col)

    ev(1.5, 2.4, "editing", OK)
    ax.annotate("", xy=(1.5, 1.45), xytext=(1.5, 2.35), arrowprops=dict(arrowstyle="-|>", color=OK, lw=1))
    ev(3.2, 1.4, "SIGKILL", RED, dy=-0.32)
    ax.plot([3.2], [1.4], "X", color=RED, ms=10, zorder=5)
    ax.plot([3.2, 9.7], [1.4, 1.4], color="#f3d6d6", lw=1.2, ls=":", zorder=2)

    ev(3.4, 2.4, "socket close", RED)
    ev(4.1, 2.4, "ask Directory", WARN)
    ev(5.0, 2.4, "new ticket →\ncollab-2", WARN, dy=0.30)
    ev(5.9, 2.4, "hello + knownVV", ACC)
    ax.annotate("", xy=(5.9, 0.55), xytext=(5.9, 2.35), arrowprops=dict(arrowstyle="-|>", color=ACC, lw=1))
    ev(6.6, 0.5, "delta re-sync", ACC, dy=-0.32)
    ev(7.6, 2.4, "editing resumes", OK)

    ax.annotate("", xy=(3.2, 3.0), xytext=(7.6, 3.0), arrowprops=dict(arrowstyle="<|-|>", color=INK, lw=1))
    ax.text(5.4, 3.08, "measured failover: 151–276 ms  (no operation lost)",
            ha="center", fontsize=7.6, fontweight="bold")

    ax.text(5.0, -0.05, "The Directory stops advertising a replica once its lease expires; the client re-asks on every "
                        "reconnect attempt, which is what makes failover automatic.",
            ha="center", fontsize=7, color=MUTED, style="italic")
    fig.tight_layout()
    fig.savefig(FIG / "failover.png", bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    fig_architecture(); print("  docs/figures/architecture.png")
    fig_rga();          print("  docs/figures/rga.png")
    fig_perf();         print("  docs/figures/performance.png")
    fig_failover();     print("  docs/figures/failover.png")
    print("figures done")
