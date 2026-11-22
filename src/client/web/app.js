/**
 * CoEdit-DS browser client.
 *
 * Responsibilities
 *  • REST calls to the Directory Service through the gateway (/api/...).
 *  • Maintains a local RGA replica; every keystroke is applied locally first
 *    (zero-latency typing) and shipped asynchronously.
 *  • Diffs the <textarea> against the CRDT text to derive insert/delete ops —
 *    this keeps the UI simple while still producing character-level CRDT ops
 *    rather than a "whole document overwrite" (explicitly forbidden by §8.1).
 *  • Reconnect with exponential backoff, re-asking the Directory each time,
 *    which produces automatic failover to a surviving replica.
 *  • Offline mode: ops are buffered and replayed on reconnect.
 */
'use strict';
const $ = (id) => document.getElementById(id);
const api = (p, opts = {}) => fetch('/api' + p, {
  ...opts,
  headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}), ...(opts.headers || {}) },
}).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
});

const S = {
  token: null, username: null, docId: null, title: null, role: null, canEdit: false,
  clientId: null, replicaId: null, doc: null, ws: null, connected: false,
  outbox: [], batch: 0, backoff: 300, offline: false, presence: [],
  stats: { sent: 0, acked: 0, recv: 0, reconnects: 0, failovers: 0 },
  applyingRemote: false, reconnectTimer: null, closedByUser: false,
};

/* ------------------------------------------------------------------ log */
function log(kind, msg, extra) {
  const el = document.createElement('div');
  el.className = 'lg-' + kind;
  const ts = new Date().toISOString().substr(11, 12);
  el.textContent = `${ts}  ${msg}` + (extra ? '  ' + JSON.stringify(extra) : '');
  const box = $('log');
  box.appendChild(el);
  while (box.childNodes.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function setConn(state, text) {
  $('dotConn').className = 'dot ' + state;
  $('txtConn').textContent = text;
}

function refreshStats() {
  $('kOps').textContent = `${S.stats.sent} / ${S.stats.acked}`;
  $('kRecv').textContent = S.stats.recv;
  $('kRe').textContent = S.stats.reconnects;
  $('kFo').textContent = S.stats.failovers;
  $('kPend').textContent = S.doc ? S.doc.pendingCount() : 0;
  $('kLen').textContent = S.doc ? S.doc.length : 0;
  $('kClient').textContent = S.clientId || '—';
  $('kReplica').textContent = S.replicaId || '—';
  $('kRole').textContent = S.role || '—';
  $('tagReplica').textContent = 'replica: ' + (S.replicaId || '—');
}

/* ----------------------------------------------------------------- auth */
$('btnRegister').onclick = async () => {
  $('authErr').textContent = '';
  try {
    await api('/auth/register', { method: 'POST', body: JSON.stringify({ username: $('user').value.trim(), password: $('pass').value }) });
    log('ok', 'registered — now click Login');
  } catch (e) { $('authErr').textContent = e.message; }
};

$('btnLogin').onclick = async () => {
  $('authErr').textContent = '';
  try {
    const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: $('user').value.trim(), password: $('pass').value }) });
    S.token = r.token; S.username = r.username;
    $('whoami').textContent = 'signed in as ' + r.username;
    $('paneAuth').classList.add('hidden');
    $('paneDocs').classList.remove('hidden');
    $('btnLogout').classList.remove('hidden');
    log('ok', 'login ok', { user: r.username });
    loadDocs();
  } catch (e) { $('authErr').textContent = e.message; }
};

$('btnLogout').onclick = () => { S.closedByUser = true; if (S.ws) S.ws.close(); location.reload(); };

/* ----------------------------------------------------------------- docs */
async function loadDocs() {
  try {
    const r = await api('/docs');
    const box = $('docs');
    box.innerHTML = '';
    if (!r.docs.length) box.innerHTML = '<p class="muted">No documents yet — create one.</p>';
    for (const d of r.docs) {
      const el = document.createElement('div');
      el.className = 'doc' + (d.id === S.docId ? ' active' : '');
      el.innerHTML = `<div class="t"></div><div class="m"></div>`;
      el.querySelector('.t').textContent = d.title;
      el.querySelector('.m').textContent = `${d.id}  ·  ${d.role}`;
      el.onclick = () => openDoc(d.id);
      box.appendChild(el);
    }
  } catch (e) { log('err', 'loadDocs failed: ' + e.message); }
}

$('btnRefresh').onclick = loadDocs;

$('btnCreate').onclick = async () => {
  const title = $('newTitle').value.trim() || 'Untitled';
  try {
    const r = await api('/docs', { method: 'POST', body: JSON.stringify({ title }) });
    $('newTitle').value = '';
    log('ok', 'document created', { docId: r.docId });
    await loadDocs();
    openDoc(r.docId);
  } catch (e) { log('err', 'create failed: ' + e.message); }
};

$('btnShare').onclick = async () => {
  $('shareErr').textContent = '';
  if (!S.docId) { $('shareErr').textContent = 'open a document first'; return; }
  try {
    await api(`/docs/${S.docId}/share`, { method: 'POST', body: JSON.stringify({ username: $('shareUser').value.trim(), role: $('shareRole').value }) });
    log('ok', 'access granted', { to: $('shareUser').value.trim(), role: $('shareRole').value });
    $('shareUser').value = '';
  } catch (e) { $('shareErr').textContent = e.message; }
};

/* ----------------------------------------------------- connection / sync */
async function openDoc(docId) {
  S.closedByUser = false;
  if (S.ws) { try { S.ws.close(); } catch (e) {} }
  const resuming = S.docId === docId && S.doc;
  S.docId = docId;
  if (!resuming) { S.doc = null; S.clientId = null; S.outbox = []; }
  await connect();
  loadDocs();
}

async function connect() {
  let ticket;
  try {
    // Re-present our site id so the CRDT identity survives reconnects/failover.
    ticket = await api(`/docs/${S.docId}/session` + (S.clientId ? `?clientId=${encodeURIComponent(S.clientId)}` : ''));
  } catch (e) {
    log('err', 'session ticket failed: ' + e.message);
    scheduleReconnect();
    return;
  }
  if (S.replicaId && ticket.primary.id !== S.replicaId) {
    S.stats.failovers++;
    log('warn', `FAILOVER ${S.replicaId} → ${ticket.primary.id}`);
  }
  S.role = ticket.role;
  S.title = ticket.title;
  if (!S.doc) { S.clientId = ticket.clientId; S.doc = new RGA(S.clientId); }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/rt?replica=${encodeURIComponent(ticket.primary.id)}`;
  setConn('warn', 'connecting…');
  const ws = new WebSocket(url);
  S.ws = ws;

  ws.onopen = () => {
    const hello = { t: 'hello', sessionToken: ticket.sessionToken, corr: 'hello-' + Date.now() };
    if (S.doc.oplog.length || Object.keys(S.doc.vv).length) hello.knownVV = Object.assign({}, S.doc.vv);
    ws.send(JSON.stringify(hello));
    log('net', 'websocket open → ' + ticket.primary.id);
  };

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'welcome') {
      S.connected = true; S.backoff = 300;
      S.replicaId = m.replicaId; S.canEdit = m.canEdit; S.title = m.title; S.role = m.role;
      if (m.snapshot) {
        const mine = S.clientId;
        const localOnly = S.doc ? S.doc.oplog.filter((o) => o.site === mine) : [];
        S.doc = RGA.fromSnapshot(mine, m.snapshot);
        for (const op of localOnly) S.doc.apply(op);
      }
      for (const op of m.ops || []) S.doc.apply(op);
      S.presence = m.presence || [];
      setConn('ok', 'connected');
      $('pillTitle').textContent = m.title;
      $('pillPath').textContent = `client ${m.clientId} · ${m.role}`;
      $('editor').disabled = !m.canEdit;
      render(); renderPresence(); refreshStats(); flushOutbox();
      log('ok', 'joined document', { replica: m.replicaId, role: m.role, ops: (m.ops || []).length, snapshot: !!m.snapshot });
    } else if (m.t === 'ops') {
      let n = 0;
      for (const op of m.ops || []) if (S.doc.apply(op) === 'applied') n++;
      S.stats.recv += (m.ops || []).length;
      if (n) { render(); log('net', `applied ${n} remote op(s)`, { from: m.from }); }
      refreshStats();
    } else if (m.t === 'sync') {
      let n = 0;
      for (const op of m.ops || []) if (S.doc.apply(op) === 'applied') n++;
      render(); refreshStats();
      log('ok', `re-synchronised: ${n} missing op(s) received`);
    } else if (m.t === 'ack') {
      S.stats.acked += m.applied || 0; refreshStats();
    } else if (m.t === 'presence') {
      S.presence = m.users || []; renderPresence();
    } else if (m.t === 'error') {
      log('err', `server error ${m.code}: ${m.message}`);
    } else if (m.t === 'bye') {
      log('warn', 'replica is shutting down: ' + m.reason);
    }
  };

  ws.onclose = () => {
    const was = S.connected;
    S.connected = false;
    setConn('err', 'disconnected');
    if (was) log('warn', 'connection lost');
    if (!S.closedByUser && !S.offline) scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  if (S.reconnectTimer || S.closedByUser) return;
  const delay = Math.min(S.backoff, 5000);
  S.backoff = Math.min(S.backoff * 2, 5000);
  setConn('warn', `reconnecting in ${Math.round(delay)}ms…`);
  S.reconnectTimer = setTimeout(() => {
    S.reconnectTimer = null;
    if (S.offline || S.closedByUser) return;
    S.stats.reconnects++; refreshStats();
    log('warn', 'reconnect attempt #' + S.stats.reconnects);
    connect();
  }, delay);
}

/* ------------------------------------------------------------- outbox */
function queue(ops) {
  if (!ops.length) return;
  S.outbox.push.apply(S.outbox, ops);
  flushOutbox();
}
function flushOutbox() {
  if (!S.connected || S.offline || !S.outbox.length || !S.ws || S.ws.readyState !== 1) return;
  const ops = S.outbox.splice(0, Math.min(S.outbox.length, 400));
  const batchId = S.clientId + '-b' + (++S.batch);
  S.ws.send(JSON.stringify({ t: 'ops', docId: S.docId, ops, batchId, corr: batchId }));
  S.stats.sent += ops.length; refreshStats();
  if (S.outbox.length) setTimeout(flushOutbox, 0);
}

/* -------------------------------------------------------- editor <-> CRDT */
const editor = $('editor');

function render() {
  const text = S.doc.text();
  if (editor.value === text) { $('convergence').textContent = `len ${text.length} · lamport ${S.doc.lamport}`; return; }
  const start = editor.selectionStart, end = editor.selectionEnd;
  const before = editor.value;
  S.applyingRemote = true;
  editor.value = text;
  // Keep the caret stable when remote text is inserted before it.
  const delta = text.length - before.length;
  const pivot = commonPrefix(before, text);
  const ns = start > pivot ? Math.max(pivot, start + delta) : start;
  const ne = end > pivot ? Math.max(pivot, end + delta) : end;
  try { editor.setSelectionRange(ns, ne); } catch (e) {}
  S.applyingRemote = false;
  $('convergence').textContent = `len ${text.length} · lamport ${S.doc.lamport}`;
}

function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
function commonSuffix(a, b, max) { let i = 0; while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }

/** Derive CRDT ops from the textarea's new value (single contiguous edit). */
function onInput() {
  if (S.applyingRemote || !S.doc) return;
  if (!S.canEdit) { render(); return; }
  const oldText = S.doc.text();
  const newText = editor.value;
  if (oldText === newText) return;
  const p = commonPrefix(oldText, newText);
  const s = commonSuffix(oldText, newText, Math.min(oldText.length, newText.length) - p);
  const removed = oldText.length - p - s;
  const added = newText.substr(p, newText.length - p - s);
  const ops = [];
  if (removed > 0) ops.push.apply(ops, S.doc.localDeleteRange(p, removed));
  if (added.length) ops.push.apply(ops, S.doc.localInsertText(p, added));
  queue(ops);
  refreshStats();
  $('convergence').textContent = `len ${S.doc.length} · lamport ${S.doc.lamport}`;
  if (S.offline) log('warn', `buffered ${ops.length} op(s) offline (total ${S.outbox.length})`);
}

editor.addEventListener('input', onInput);
editor.addEventListener('keyup', sendCursor);
editor.addEventListener('click', sendCursor);
function sendCursor() {
  if (S.connected && S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({ t: 'cursor', docId: S.docId, pos: editor.selectionStart }));
  }
}

function renderPresence() {
  const box = $('who');
  box.innerHTML = '';
  for (const u of S.presence) {
    const el = document.createElement('span');
    el.style.background = u.color;
    el.textContent = `${u.username}${u.clientId === S.clientId ? ' (you)' : ''} @${u.pos}`;
    box.appendChild(el);
  }
}

/* ------------------------------------------------------ fault injection */
$('btnKill').onclick = () => {
  if (S.ws) { log('warn', 'FAULT: dropping websocket'); S.ws.close(); }
};
$('btnOffline').onclick = () => {
  S.offline = !S.offline;
  $('btnOffline').textContent = S.offline ? 'Go online' : 'Go offline / online';
  if (S.offline) {
    log('warn', 'FAULT: offline mode — edits are buffered locally');
    if (S.ws) S.ws.close();
    setConn('err', 'offline (buffering)');
  } else {
    log('ok', 'back online — replaying buffered ops');
    S.backoff = 300;
    connect();
  }
};

setInterval(refreshStats, 1000);
log('info', 'CoEdit-DS client ready — RGA CRDT, WebSocket transport');
