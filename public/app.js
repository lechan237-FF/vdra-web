// VDra Web client — vanilla JS, no build step.
// Server is the single source of truth; this file renders the state it pushes over SSE.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TYPE_LABEL = { gban: 'GLOBAL BAN', protect: 'PROTECT', ban: 'BAN', pick: 'PICK' };
const TYPE_SHORT = { gban: 'G', protect: 'P', ban: 'B', pick: '' };
const TYPE_JA = { gban: 'グローバルBan', protect: 'プロテクト', ban: 'Ban', pick: 'Pick' };
const LOCK_LABEL = { gban: 'GLOBAL BAN', protect: 'PROTECT', ban: 'BAN', pick: 'LOCK IN' };
const STATUS_JA = { lobby: 'ロビー', drafting: 'ドラフト中', paused: '一時停止中', finished: '終了' };

const S = {
  agents: [],
  agentMap: {},
  roles: [],
  roleIcons: {},
  agentSource: '',
  systems: [],
  systemMap: {},
  route: null,
  room: null,
  me: null, // {pid, token}
  es: null,
  conn: 'idle', // idle | live | reconnecting
  clockOffset: 0,
  view: null,
  filter: { role: 'all', q: '' },
  selected: null, // locally highlighted agent
  lastStepSeen: -1,
  lastActionCount: 0,
  shared: null,
};

// ------------------------------------------------------------------ identity storage
const idKey = (roomId) => `vdra:id:${roomId}`;
function loadIdentity(roomId, { sessionOnly = false } = {}) {
  try {
    const s = sessionStorage.getItem(idKey(roomId));
    if (s) return JSON.parse(s);
    if (!sessionOnly) {
      const l = localStorage.getItem(idKey(roomId));
      if (l) return JSON.parse(l);
    }
  } catch {}
  return null;
}
function saveIdentity(roomId, me) {
  try {
    sessionStorage.setItem(idKey(roomId), JSON.stringify(me));
    localStorage.setItem(idKey(roomId), JSON.stringify(me));
  } catch {}
}
function clearIdentity(roomId) {
  try {
    sessionStorage.removeItem(idKey(roomId));
    localStorage.removeItem(idKey(roomId));
  } catch {}
}
const savedName = () => {
  try {
    return localStorage.getItem('vdra:name') || '';
  } catch {
    return '';
  }
};
const saveName = (n) => {
  try {
    localStorage.setItem('vdra:name', n);
  } catch {}
};

// ------------------------------------------------------------------ api
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.body ? 'POST' : 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const e = new Error(data?.message || `通信エラー (${res.status})`);
    e.status = res.status;
    e.code = data?.error;
    throw e;
  }
  return data;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());

// Every action carries an id: a retry after a network error can never be applied twice.
async function act(action, { quiet = false } = {}) {
  if (!S.me || !S.room) return;
  const body = { pid: S.me.pid, token: S.me.token, action, actionId: uid() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api(`/api/rooms/${S.room.id}/action`, { body });
    } catch (e) {
      if (e.status) {
        if (!quiet && e.code !== 'STALE') toast(e.message, 'error');
        if (e.status === 401) handleAuthLost();
        return null;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!quiet) toast('サーバーに接続できません', 'error');
  return null;
}

// ------------------------------------------------------------------ toasts / modal
function toast(msg, kind = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function confirmModal({ title, body, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-back">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
          <h3 id="mt">${esc(title)}</h3>
          <p>${esc(body)}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-r="0">キャンセル</button>
            <button class="btn ${danger ? 'btn-red' : 'btn-light'}" data-r="1">${esc(ok)}</button>
          </div>
        </div>
      </div>`;
    const done = (v) => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && done(false);
    document.addEventListener('keydown', onKey);
    root.querySelector('.modal-back').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-back')) done(false);
      const r = e.target.closest('[data-r]');
      if (r) done(r.dataset.r === '1');
    });
    root.querySelector('[data-r="1"]').focus();
  });
}

async function copyText(text, label = 'コピーしました') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label, 'ok');
}

// ------------------------------------------------------------------ agent visuals
const hex = (c) => (c ? '#' + c.slice(0, 6) : null);
function agentColors(a) {
  const c = a?.colors;
  return c && c.length >= 2 ? [hex(c[0]), hex(c[1]), hex(c[2] || c[0]), hex(c[3] || c[1])] : null;
}
const initials = (a) => (a?.name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
function roleOf(id) {
  return S.roles.find((r) => r.id === id);
}
function roleIcon(roleId, cls = 'role-ico') {
  const url = S.roleIcons[roleId];
  return url
    ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" />`
    : `<span class="${cls} role-ico-fallback">${esc((roleOf(roleId)?.en || '?')[0])}</span>`;
}
// Image with automatic fallback tile when offline / broken.
function agentImg(a, kind = 'icon', cls = '') {
  if (!a) return `<span class="ag-fallback ${cls}">?</span>`;
  const url = a.images?.[kind] || a.images?.icon;
  const fb = `<span class="ag-fallback ${cls}" data-role="${esc(a.role)}">${esc(initials(a))}</span>`;
  if (!url) return fb;
  return `<img class="${cls}" src="${esc(url)}" alt="${esc(a.name)}" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ag-fallback ${cls}',textContent:'${esc(initials(a))}'}))" />`;
}
const agentName = (id) => S.agentMap[id]?.name || id || '—';
const agentNameJa = (id) => S.agentMap[id]?.nameJa || agentName(id);

// ------------------------------------------------------------------ draft helpers (mirror of server rules, for UI only)
function agentStates(draft) {
  const st = {};
  const get = (id) => (st[id] ||= { gban: null, ban: null, protect: [], pick: [] });
  for (const a of draft.actions) {
    if (!a.agentId) continue;
    const s = get(a.agentId);
    if (a.type === 'gban') s.gban = a.team;
    else if (a.type === 'ban') s.ban = a.team;
    else if (a.type === 'protect') s.protect.push(a.team);
    else if (a.type === 'pick') s.pick.push(a.team);
  }
  return st;
}
const other = (t) => (t === 'A' ? 'B' : 'A');
function selectionError(draft, step, id, states) {
  const s = states[id] || { gban: null, ban: null, protect: [], pick: [] };
  const opp = other(step.team);
  if (s.gban) return 'Global Ban済み';
  switch (step.type) {
    case 'gban':
      return null;
    case 'protect':
      if (s.ban) return 'Ban済み';
      if (s.protect.includes(step.team)) return 'Protect済み';
      if (!draft.mirror && s.protect.includes(opp)) return '相手がProtect済み';
      return null;
    case 'ban':
      if (s.ban) return 'Ban済み';
      if (s.pick.length) return 'Pick済み';
      if (s.protect.includes(opp)) return '相手がProtect中';
      if (s.protect.includes(step.team)) return '自チームがProtect中';
      return null;
    case 'pick':
      if (s.ban) return 'Ban済み';
      if (s.pick.includes(step.team)) return '自チームでPick済み';
      if (!draft.mirror && s.pick.includes(opp)) return '相手がPick済み';
      if (!draft.mirror && s.protect.includes(opp)) return '相手がProtect中';
      return null;
  }
  return '不正';
}
function curStep(room = S.room) {
  const d = room?.draft;
  return d && d.stepIndex < d.steps.length ? d.steps[d.stepIndex] : null;
}
function stepActor(room, step) {
  const d = room.draft;
  return step.type === 'pick' ? d.pickSlots[step.team][step.slot] ?? d.captains[step.team] : d.captains[step.team];
}
function canAct(room, pid, step) {
  if (!step || !pid) return false;
  const d = room.draft;
  if (room.settings.hostOverride && room.hostId === pid) return true;
  const actor = stepActor(room, step);
  if (actor === pid) return true;
  const ap = room.players[actor];
  if (ap && ap.online && ap.team === step.team) return false;
  const me = room.players[pid];
  if (!me || me.team !== step.team) return false;
  const cap = room.players[d.captains[step.team]];
  const capAway = !cap || !cap.online || cap.team !== step.team;
  return pid === d.captains[step.team] || capAway;
}
const isHost = () => S.room && S.me && S.room.hostId === S.me.pid;
const pname = (pid) => S.room?.players[pid]?.name || S.room?.draft?.names?.[pid] || '—';
const teamName = (t, room = S.room) => room?.draft?.teamNames?.[t] || room?.settings?.teamNames?.[t] || (t === 'A' ? 'ATTACKERS' : 'DEFENDERS');

// ------------------------------------------------------------------ routing
function parseRoute() {
  const p = location.pathname;
  let m;
  if ((m = /^\/room\/([A-Za-z0-9]+)\/?$/.exec(p))) return { name: 'room', id: m[1].toUpperCase() };
  if ((m = /^\/r\/([A-Za-z0-9]+)\/?$/.exec(p))) return { name: 'shared', id: m[1] };
  return { name: 'home' };
}
function navigate(path) {
  history.pushState({}, '', path);
  onRoute();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }
});
window.addEventListener('popstate', onRoute);

function disconnect() {
  if (S.es) S.es.close();
  S.es = null;
  S.room = null;
  S.me = null;
  S.conn = 'idle';
  clearTimeout(S.reconnectTimer);
}

async function onRoute() {
  const r = parseRoute();
  if (S.route?.name === 'room' && (r.name !== 'room' || r.id !== S.route.id)) disconnect();
  S.route = r;
  S.view = null;
  if (r.name === 'home') return renderHome();
  if (r.name === 'shared') return renderShared(r.id);
  if (r.name === 'room') {
    if (S.room?.id === r.id && S.me) return render();
    const me = loadIdentity(r.id, { sessionOnly: true });
    if (me) return connect(r.id, me);
    return renderJoin(r.id);
  }
}

// ------------------------------------------------------------------ connection
function connect(roomId, me) {
  S.me = me;
  S.conn = 'reconnecting';
  renderTopbar();
  if (!S.room) mount('loading', `<div class="center-msg"><div class="spinner"></div><p>接続中…</p></div>`);
  openStream(roomId);
}

function openStream(roomId) {
  if (S.es) S.es.close();
  const es = new EventSource(`/api/rooms/${roomId}/events?pid=${encodeURIComponent(S.me.pid)}&token=${encodeURIComponent(S.me.token)}`);
  S.es = es;
  es.addEventListener('state', (e) => {
    const room = JSON.parse(e.data);
    S.clockOffset = room.serverNow - Date.now();
    if (S.conn !== 'live') {
      S.conn = 'live';
      renderTopbar();
    }
    applyState(room);
  });
  es.addEventListener('kicked', () => {
    es.close();
    clearIdentity(roomId);
    const id = roomId;
    disconnect();
    toast('ルームから退出しました', 'info');
    renderJoin(id);
  });
  es.onerror = async () => {
    if (S.es !== es) return;
    S.conn = 'reconnecting';
    renderTopbar();
    if (es.readyState === EventSource.CLOSED) {
      // The server refused the stream (bad credentials or room gone) - find out which.
      clearTimeout(S.reconnectTimer);
      S.reconnectTimer = setTimeout(async () => {
        try {
          await api(`/api/rooms/${roomId}`);
          const r = await api(`/api/rooms/${roomId}/join`, { body: { pid: S.me.pid, token: S.me.token, name: '-' } }).catch(() => null);
          if (r && r.rejoined) return openStream(roomId);
          handleAuthLost();
        } catch (err) {
          if (err.status === 404) {
            disconnect();
            clearIdentity(roomId);
            mount('error', errorView('ルームが見つかりません', '期限切れ、または存在しないルームIDです。'));
          } else S.reconnectTimer = setTimeout(() => openStream(roomId), 1500);
        }
      }, 800);
    }
  };
}

function handleAuthLost() {
  const id = S.route?.id;
  if (!id) return;
  clearIdentity(id);
  disconnect();
  toast('参加情報が無効になりました。再参加してください', 'error');
  renderJoin(id);
}

window.addEventListener('online', () => {
  if (S.route?.name === 'room' && S.me && (!S.es || S.es.readyState === EventSource.CLOSED)) openStream(S.route.id);
});

function applyState(room) {
  const prev = S.room;
  S.room = room;
  if (S.me && !room.players[S.me.pid]) {
    // we were removed (kicked while offline)
    const id = room.id;
    clearIdentity(id);
    disconnect();
    renderJoin(id);
    return;
  }
  // reset local selection when the step changes
  const step = curStep(room);
  const stepIdx = room.draft ? room.draft.stepIndex : -1;
  if (stepIdx !== S.lastStepSeen) {
    S.selected = null;
  }
  render(prev);
  S.lastStepSeen = stepIdx;
  S.lastActionCount = room.draft?.actions.length || 0;
  // notify only the player who actually owns this turn (not the host acting via override)
  if (step && prev?.draft?.stepIndex !== room.draft.stepIndex && stepActor(room, step) === S.me.pid) {
    notifyTurn(step);
  }
}

function notifyTurn(step) {
  toast(`あなたの${TYPE_JA[step.type]}ターンです`, 'turn', 2000);
  try {
    navigator.vibrate?.(60);
  } catch {}
  if (document.hidden) document.title = `▶ あなたのターン — VDra`;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = 'VDra — VALORANT Agent Draft';
});

// ------------------------------------------------------------------ mount helpers
function mount(view, html) {
  S.view = view;
  const app = $('#app');
  app.className = `app view-${view}`;
  app.innerHTML = html;
}

function renderTopbar() {
  const el = $('#topbar-right');
  if (!S.room || S.route?.name !== 'room') {
    el.innerHTML = '';
    return;
  }
  const me = S.room.players[S.me?.pid];
  el.innerHTML = `
    <button class="room-chip" data-copy-code title="ルームIDをコピー"><span>ROOM</span><b>${esc(S.room.id)}</b></button>
    <span class="conn conn-${S.conn}">${S.conn === 'live' ? 'LIVE' : '再接続中…'}</span>
    ${me ? `<span class="me-chip" title="あなた">${esc(me.name)}${isHost() ? '<i>HOST</i>' : ''}</span>` : ''}`;
  el.querySelector('[data-copy-code]').onclick = () => copyText(inviteUrl(), '招待URLをコピーしました');
}
const inviteUrl = () => `${location.origin}/room/${S.room.id}`;

function render(prev) {
  renderTopbar();
  if (!S.room) return;
  const st = S.room.status;
  if (st === 'lobby') return renderLobby();
  if (st === 'drafting' || st === 'paused') return renderDraft(prev);
  if (st === 'finished') return renderRoomResult();
}

function errorView(title, msg) {
  return `<div class="center-msg"><h2 class="h-display">${esc(title)}</h2><p>${esc(msg)}</p><a class="btn btn-red" href="/" data-link>トップへ戻る</a></div>`;
}

// ------------------------------------------------------------------ HOME
function renderHome() {
  renderTopbar();
  mount(
    'home',
    `
    <section class="hero">
      <div class="hero-text">
        <p class="eyebrow">// VALORANT AGENT DRAFT</p>
        <h1 class="h-hero">DRAFT<br/><span>YOUR SQUAD</span></h1>
        <p class="lead">ルームを作ってURLを送るだけ。Global Ban・Protect・Ban・Pickを、全員の画面でリアルタイムに。</p>
      </div>
      <div class="hero-cards">
        <form class="card card-create" id="create-form" autocomplete="off">
          <div class="card-tag">01</div>
          <h2>ルームを作成</h2>
          <label class="field"><span>プレイヤー名</span><input name="name" maxlength="16" required placeholder="例: Sova main" value="${esc(savedName())}" /></label>
          <button class="btn btn-red btn-cut" type="submit">CREATE ROOM</button>
        </form>
        <form class="card card-join" id="join-form" autocomplete="off">
          <div class="card-tag">02</div>
          <h2>ルームに参加</h2>
          <label class="field"><span>ルームID</span><input name="code" maxlength="6" required placeholder="ABC123" class="mono upper" /></label>
          <label class="field"><span>プレイヤー名</span><input name="name" maxlength="16" required value="${esc(savedName())}" /></label>
          <button class="btn btn-light btn-cut" type="submit">JOIN ROOM</button>
        </form>
      </div>
    </section>
    <section class="formats">
      <h3 class="h-section">DRAFT SYSTEMS<span>8 FORMATS</span></h3>
      <div class="format-grid" id="format-grid">${S.systems.map(formatCard).join('')}</div>
    </section>`
  );
  $('#create-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    saveName(name);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('/api/rooms', { body: { name } });
      saveIdentity(r.roomId, { pid: r.pid, token: r.token });
      navigate(`/room/${r.roomId}`);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  };
  $('#join-form').onsubmit = (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim().toUpperCase();
    const name = e.target.name.value.trim();
    if (!code || !name) return;
    saveName(name);
    joinRoom(code, name, e.target.querySelector('button'));
  };
}

function stepChips(steps, { done = -1, current = -1, actions = null } = {}) {
  return steps
    .map((s, i) => {
      const a = actions?.[i];
      const ag = a?.agentId ? S.agentMap[a.agentId] : null;
      const cls = ['chip', `chip-${s.type}`, `team-${s.team}`, i < done ? 'done' : '', i === current ? 'current' : ''].join(' ');
      return `<span class="${cls}" title="${esc(`${i + 1}. ${teamName(s.team)} ${TYPE_LABEL[s.type]}${ag ? ' — ' + ag.name : ''}`)}">${
        ag ? agentImg(ag, 'icon', 'chip-img') : `<b>${TYPE_SHORT[s.type] || '•'}</b>`
      }</span>`;
    })
    .join('');
}

function formatCard(s) {
  return `<div class="format-card">
    <div class="format-no">${String(s.no).padStart(2, '0')}</div>
    <div class="format-body">
      <div class="format-en">${esc(s.en)}</div>
      <div class="format-ja">${esc(s.name)}</div>
      <p>${esc(s.desc)}</p>
      <div class="chips">${stepChips(s.steps)}</div>
      <div class="format-meta">${s.mirror ? '両チーム同じエージェント可' : '同じエージェントは1チームのみ'}</div>
    </div>
  </div>`;
}

async function joinRoom(code, name, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/rooms/${code}/join`, { body: { name } });
    saveIdentity(r.roomId, { pid: r.pid, token: r.token });
    if (S.route?.name === 'room' && S.route.id === r.roomId) {
      connect(r.roomId, { pid: r.pid, token: r.token });
    } else navigate(`/room/${r.roomId}`);
  } catch (err) {
    toast(err.status === 404 ? 'ルームが見つかりません' : err.message, 'error');
    if (btn) btn.disabled = false;
  }
}

// ------------------------------------------------------------------ JOIN (from invite URL)
async function renderJoin(roomId) {
  renderTopbar();
  mount('join', `<div class="center-msg"><div class="spinner"></div></div>`);
  let info;
  try {
    info = await api(`/api/rooms/${roomId}`);
  } catch (e) {
    return mount('error', errorView('ルームが見つかりません', '期限切れ、または存在しないルームIDです。'));
  }
  const prevId = loadIdentity(roomId);
  mount(
    'join',
    `<div class="join-wrap">
      <form class="card card-join join-card" id="join2" autocomplete="off">
        <p class="eyebrow">// INVITATION</p>
        <h2 class="h-display">ROOM <span class="mono">${esc(roomId)}</span></h2>
        <p class="muted">ホスト: ${esc(info.host || '—')}　参加者 ${info.players}/${info.max}　状態: ${esc(STATUS_JA[info.status] || info.status)}</p>
        ${info.status === 'drafting' || info.status === 'paused' ? '<p class="note">ドラフト進行中のため、観戦者として参加します。</p>' : ''}
        <label class="field"><span>プレイヤー名</span><input name="name" maxlength="16" required value="${esc(savedName())}" /></label>
        <button class="btn btn-red btn-cut" type="submit">JOIN</button>
        ${prevId ? `<button type="button" class="btn btn-ghost" id="rejoin">前回の参加者として再接続</button>` : ''}
      </form>
    </div>`
  );
  $('#join2').onsubmit = (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    saveName(name);
    joinRoom(roomId, name, e.target.querySelector('button'));
  };
  if (prevId)
    $('#rejoin').onclick = async () => {
      try {
        const r = await api(`/api/rooms/${roomId}/join`, { body: { ...prevId, name: savedName() || 'Player' } });
        if (!r.rejoined) toast('前回の参加情報が無効だったため、新規参加しました', 'info');
        saveIdentity(roomId, { pid: r.pid, token: r.token });
        connect(roomId, { pid: r.pid, token: r.token });
      } catch (e) {
        toast(e.message, 'error');
      }
    };
}

// ------------------------------------------------------------------ LOBBY
function renderLobby() {
  const room = S.room;
  const host = isHost();
  const sys = S.systemMap[room.settings.systemId];
  const me = room.players[S.me.pid];
  const spectators = Object.values(room.players)
    .filter((p) => !p.team)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const canStart = room.order.A.length > 0 && room.order.B.length > 0;

  const playerRow = (p, idx, team) => `
    <li class="pl ${p.id === S.me.pid ? 'is-me' : ''}" style="--i:${idx}">
      <span class="dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'オンライン' : 'オフライン'}"></span>
      <span class="pl-name">${esc(p.name)}</span>
      ${p.id === room.hostId ? '<i class="tag tag-host">HOST</i>' : ''}
      ${team && idx === 0 ? '<i class="tag tag-cap" title="Ban/Protectを担当">CAPTAIN</i>' : ''}
      ${
        host
          ? `<span class="pl-tools">
        ${team ? `<button class="ico" data-act="up" data-id="${p.id}" title="上へ" ${idx === 0 ? 'disabled' : ''}>▲</button><button class="ico" data-act="down" data-id="${p.id}" title="下へ">▼</button>` : ''}
        ${team !== 'A' ? `<button class="ico" data-act="toA" data-id="${p.id}" title="${esc(teamName('A'))}へ">A</button>` : ''}
        ${team !== 'B' ? `<button class="ico" data-act="toB" data-id="${p.id}" title="${esc(teamName('B'))}へ">B</button>` : ''}
        ${team ? `<button class="ico" data-act="toS" data-id="${p.id}" title="観戦へ">👁</button>` : ''}
        ${p.id !== room.hostId ? `<button class="ico" data-act="host" data-id="${p.id}" title="ホストを譲る">♛</button><button class="ico ico-danger" data-act="kick" data-id="${p.id}" title="キック">✕</button>` : ''}
      </span>`
          : ''
      }
    </li>`;

  const teamCol = (t) => {
    const list = room.order[t].map((id) => room.players[id]).filter(Boolean);
    const empty = Array.from({ length: 5 - list.length }, () => `<li class="pl pl-empty">EMPTY SLOT</li>`).join('');
    return `<div class="team-col team-${t}">
      <div class="team-head">
        <span class="team-side">${t === 'A' ? 'ATK' : 'DEF'}</span>
        <h3>${esc(teamName(t))}</h3>
        <span class="team-count">${list.length}/5</span>
      </div>
      <ol class="pl-list">${list.map((p, i) => playerRow(p, i, t)).join('')}${empty}</ol>
      ${me.team !== t ? `<button class="btn btn-team btn-team-${t}" data-join="${t}" ${list.length >= 5 ? 'disabled' : ''}>このチームに入る</button>` : `<button class="btn btn-ghost" data-join="">観戦に移る</button>`}
    </div>`;
  };

  const settingsHtml = `
    <div class="panel settings ${host ? '' : 'readonly'}">
      <div class="panel-head"><h3>DRAFT SETTINGS</h3>${host ? '' : '<span class="muted small">ホストのみ変更できます</span>'}</div>
      <div class="sys-list" role="radiogroup">
        ${S.systems
          .map(
            (s) => `<button class="sys ${s.id === room.settings.systemId ? 'on' : ''}" data-sys="${s.id}" role="radio" aria-checked="${s.id === room.settings.systemId}" ${host ? '' : 'disabled'}>
              <span class="sys-no">${String(s.no).padStart(2, '0')}</span>
              <span class="sys-name">${esc(s.name)}</span>
            </button>`
          )
          .join('')}
      </div>
      <div class="sys-detail">
        <div class="format-en">${esc(sys.en)}</div>
        <p>${esc(sys.desc)}</p>
        <div class="chips">${stepChips(sys.steps)}</div>
      </div>
      <div class="opts">
        <label class="opt"><span>ターン制限時間</span>
          <select data-set="timer" ${host ? '' : 'disabled'}>
            ${[0, 15, 20, 30, 45, 60, 90].map((v) => `<option value="${v}" ${room.settings.timer === v ? 'selected' : ''}>${v ? v + '秒' : 'なし'}</option>`).join('')}
          </select>
        </label>
        <label class="opt"><span>同じエージェントを両チームでPick</span>
          <span class="switch"><input type="checkbox" data-set="mirror" ${room.settings.mirror ? 'checked' : ''} ${host ? '' : 'disabled'} /><i></i></span>
        </label>
        <label class="opt"><span>ホストが全ターンを代理操作できる</span>
          <span class="switch"><input type="checkbox" data-set="hostOverride" ${room.settings.hostOverride ? 'checked' : ''} ${host ? '' : 'disabled'} /><i></i></span>
        </label>
        <label class="opt"><span>チーム名 A</span><input data-team-name="A" maxlength="16" value="${esc(room.settings.teamNames.A)}" ${host ? '' : 'disabled'} /></label>
        <label class="opt"><span>チーム名 B</span><input data-team-name="B" maxlength="16" value="${esc(room.settings.teamNames.B)}" ${host ? '' : 'disabled'} /></label>
      </div>
      <p class="muted small">時間切れになると、選択中のエージェント(なければランダム)が自動で確定します。Pickは各チームの並び順で1人ずつ担当、Ban / Protect / Global Banはキャプテン(1番目)が担当します。</p>
    </div>`;

  const keepScroll = window.scrollY;
  const ae = document.activeElement;
  const focusKey = ae && $('#app').contains(ae) && ae.matches('input[id], input[data-team-name]') ? (ae.id ? '#' + ae.id : `[data-team-name="${ae.dataset.teamName}"]`) : null;
  const focusVal = focusKey ? { v: ae.value, s: ae.selectionStart, e: ae.selectionEnd } : null;
  mount(
    'lobby',
    `
    <section class="lobby-head">
      <div>
        <p class="eyebrow">// LOBBY</p>
        <h1 class="h-display">ROOM <span class="mono accent">${esc(room.id)}</span></h1>
      </div>
      <div class="invite">
        <input class="mono" readonly value="${esc(inviteUrl())}" aria-label="招待URL" />
        <button class="btn btn-light" data-copy="url">URLをコピー</button>
        <button class="btn btn-ghost" data-copy="code">IDをコピー</button>
        ${navigator.share ? '<button class="btn btn-ghost" data-share>共有</button>' : ''}
      </div>
    </section>
    <section class="lobby-grid">
      <div class="teams">
        ${teamCol('A')}
        <div class="vs">VS</div>
        ${teamCol('B')}
        <div class="spec">
          <div class="panel-head"><h3>SPECTATORS</h3><span class="muted small">${spectators.length}人</span></div>
          <ul class="pl-list spec-list">${spectators.length ? spectators.map((p, i) => playerRow(p, i, null)).join('') : '<li class="pl pl-empty">なし</li>'}</ul>
        </div>
        ${
          host
            ? `<div class="host-tools">
          <button class="btn btn-ghost" data-shuffle>ランダムでチーム分け</button>
        </div>`
            : ''
        }
      </div>
      <aside class="side">
        ${settingsHtml}
        <div class="start-box">
          ${
            host
              ? `<button class="btn btn-red btn-cut btn-xl" data-start ${canStart ? '' : 'disabled'}>START DRAFT</button>
                 ${canStart ? '' : '<p class="muted small">両チームに1人以上必要です</p>'}`
              : `<div class="waiting"><span class="pulse"></span>ホストの開始を待っています…</div>`
          }
          <div class="me-edit">
            <label class="field field-inline"><span>あなたの名前</span><input id="rename" maxlength="16" value="${esc(me.name)}" /></label>
            <button class="btn btn-ghost btn-sm" data-leave>ルームを退出</button>
          </div>
        </div>
        ${room.history?.length ? `<div class="panel"><div class="panel-head"><h3>HISTORY</h3></div><ul class="history">${room.history.map((id, i) => `<li><a href="/r/${esc(id)}" data-link>ドラフト結果 #${room.history.length - i}</a></li>`).join('')}</ul></div>` : ''}
      </aside>
    </section>`
  );
  window.scrollTo(0, keepScroll);
  if (focusKey) {
    const el = $(focusKey);
    if (el) {
      el.value = focusVal.v;
      el.focus();
      try {
        el.setSelectionRange(focusVal.s, focusVal.e);
      } catch {}
    }
  }

  // events
  const app = $('#app');
  app.querySelector('[data-copy="url"]').onclick = () => copyText(inviteUrl(), '招待URLをコピーしました');
  app.querySelector('[data-copy="code"]').onclick = () => copyText(room.id, 'ルームIDをコピーしました');
  const share = app.querySelector('[data-share]');
  if (share) share.onclick = () => navigator.share({ title: 'VDra ドラフトルーム', text: `ルームID: ${room.id}`, url: inviteUrl() }).catch(() => {});
  $$('[data-join]', app).forEach((b) => (b.onclick = () => act({ type: 'setTeam', team: b.dataset.join || null })));
  $$('[data-act]', app).forEach(
    (b) =>
      (b.onclick = async () => {
        const id = b.dataset.id;
        const a = b.dataset.act;
        if (a === 'up' || a === 'down') return act({ type: 'moveOrder', target: id, dir: a });
        if (a === 'toA') return act({ type: 'setTeam', target: id, team: 'A' });
        if (a === 'toB') return act({ type: 'setTeam', target: id, team: 'B' });
        if (a === 'toS') return act({ type: 'setTeam', target: id, team: null });
        if (a === 'kick' && (await confirmModal({ title: 'キック', body: `${pname(id)} をルームから外しますか?`, ok: 'キック', danger: true }))) return act({ type: 'kick', target: id });
        if (a === 'host' && (await confirmModal({ title: 'ホストを譲る', body: `${pname(id)} をホストにしますか?`, ok: '譲る' }))) return act({ type: 'transferHost', target: id });
      })
  );
  $$('[data-sys]', app).forEach((b) => (b.onclick = () => act({ type: 'updateSettings', settings: { systemId: b.dataset.sys } })));
  $$('[data-set]', app).forEach(
    (el) =>
      (el.onchange = () =>
        act({ type: 'updateSettings', settings: { [el.dataset.set]: el.type === 'checkbox' ? el.checked : Number(el.value) } }))
  );
  $$('[data-team-name]', app).forEach(
    (el) =>
      (el.onchange = () => act({ type: 'updateSettings', settings: { teamNames: { [el.dataset.teamName]: el.value } } }))
  );
  const sh = app.querySelector('[data-shuffle]');
  if (sh) sh.onclick = () => act({ type: 'shuffleTeams' });
  const st = app.querySelector('[data-start]');
  if (st) st.onclick = () => act({ type: 'start' });
  $('#rename').onchange = (e) => {
    const n = e.target.value.trim();
    if (n) {
      saveName(n);
      act({ type: 'rename', name: n });
    }
  };
  app.querySelector('[data-leave]').onclick = async () => {
    if (!(await confirmModal({ title: 'ルームを退出', body: '退出すると、再度参加するまでこのルームの操作はできません。', ok: '退出', danger: true }))) return;
    const id = room.id;
    await act({ type: 'leave' });
    clearIdentity(id);
    disconnect();
    navigate('/');
  };
}

// ------------------------------------------------------------------ DRAFT
function renderDraft(prev) {
  const room = S.room;
  if (S.view !== 'draft') mountDraft();
  updateDraft(prev);
}

function mountDraft() {
  mount(
    'draft',
    `
    <section class="phase" id="phase"></section>
    <div class="tracker-wrap"><div class="tracker" id="tracker"></div></div>
    <section class="draft-grid">
      <aside class="team-panel team-A" id="team-A"></aside>
      <div class="stage">
        <div class="spotlight" id="spotlight"></div>
        <div class="picker">
          <div class="filters" id="filters"></div>
          <div class="agent-grid" id="agent-grid"></div>
        </div>
        <div class="lock-bar" id="lock-bar"></div>
      </div>
      <aside class="team-panel team-B" id="team-B"></aside>
    </section>
    <section class="draft-foot" id="draft-foot"></section>`
  );
  // filters
  const roles = [{ id: 'all', en: 'ALL', ja: 'すべて' }, ...S.roles];
  $('#filters').innerHTML = `
    <div class="role-tabs" role="tablist">${roles
      .map(
        (r) =>
          `<button class="role-tab ${S.filter.role === r.id ? 'on' : ''}" data-role="${r.id}" role="tab" title="${esc(r.ja)}">${r.id === 'all' ? '<span class="role-all">ALL</span>' : `${roleIcon(r.id)}<span class="role-label">${esc(r.en)}</span>`}</button>`
      )
      .join('')}</div>
    <input class="search" id="search" type="search" placeholder="検索" value="${esc(S.filter.q)}" />
    <label class="only-avail"><input type="checkbox" id="only-avail" ${S.filter.only ? 'checked' : ''}/> 選択可能のみ</label>`;
  $$('#filters [data-role]').forEach(
    (b) =>
      (b.onclick = () => {
        S.filter.role = b.dataset.role;
        $$('#filters [data-role]').forEach((x) => x.classList.toggle('on', x === b));
        applyFilter();
      })
  );
  $('#search').oninput = (e) => {
    S.filter.q = e.target.value.trim().toLowerCase();
    applyFilter();
  };
  $('#only-avail').onchange = (e) => {
    S.filter.only = e.target.checked;
    applyFilter();
  };
  // grid built once; tiles updated in place
  $('#agent-grid').innerHTML = S.agents
    .map(
      (a) => `<button class="tile" data-agent="${a.id}" data-role="${a.role}" style="--c1:${agentColors(a)?.[0] || '#2a3a48'}">
        <span class="tile-img">${agentImg(a, 'icon')}</span>
        <span class="tile-name">${esc(a.name)}</span>
        <span class="tile-badge"></span>
      </button>`
    )
    .join('');
  $('#agent-grid').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    onTileClick(t.dataset.agent);
  });
  $('#agent-grid').addEventListener('dblclick', (e) => {
    const t = e.target.closest('.tile');
    if (t && myTurn()) lockIn(t.dataset.agent);
  });
  document.onkeydown = (e) => {
    if (S.view !== 'draft') return;
    if (e.key === 'Enter' && S.selected && myTurn() && !e.target.closest('input')) lockIn(S.selected);
  };
  S.lastStepSeen = -1;
}

function myTurn() {
  const step = curStep();
  return S.room.status === 'drafting' && step && canAct(S.room, S.me.pid, step);
}

let previewTimer = null;
function onTileClick(id) {
  const step = curStep();
  S.selected = id;
  if (myTurn()) {
    const err = selectionError(S.room.draft, step, id, agentStates(S.room.draft));
    if (err) toast(`${agentName(id)}: ${err}`, 'error', 1600);
    else {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => act({ type: 'preview', agentId: id }, { quiet: true }), 120);
    }
  }
  updateDraft();
}

let locking = false;
async function lockIn(id) {
  const step = curStep();
  if (!step || locking) return;
  const err = selectionError(S.room.draft, step, id, agentStates(S.room.draft));
  if (err) return toast(err, 'error');
  locking = true;
  $('#lock-bar')?.classList.add('busy');
  await act({ type: 'select', stepIndex: step.i, agentId: id });
  locking = false;
  $('#lock-bar')?.classList.remove('busy');
}

function applyFilter() {
  const { role, q, only } = S.filter;
  const room = S.room;
  const step = curStep();
  const states = room?.draft ? agentStates(room.draft) : {};
  $$('#agent-grid .tile').forEach((t) => {
    const a = S.agentMap[t.dataset.agent];
    let show = (role === 'all' || a.role === role) && (!q || a.name.toLowerCase().includes(q) || (a.nameJa || '').toLowerCase().includes(q));
    if (show && only && step) show = !selectionError(room.draft, step, a.id, states);
    t.hidden = !show;
  });
}

function updateDraft(prev) {
  const room = S.room;
  const d = room.draft;
  const step = curStep();
  const states = agentStates(d);
  const mine = myTurn();
  const paused = room.status === 'paused';
  const stepChanged = prev?.draft?.stepIndex !== d.stepIndex || S.lastStepSeen !== d.stepIndex;

  // ---- phase banner
  const actorId = step ? stepActor(room, step) : null;
  const typeCls = step ? `type-${step.type}` : '';
  $('#phase').className = `phase team-${step?.team} ${typeCls} ${paused ? 'is-paused' : ''} ${mine ? 'is-mine' : ''}`;
  $('#phase').innerHTML = step
    ? `
      <div class="phase-left">
        <div class="phase-sys">${esc(S.systemMap[d.systemId]?.en || '')} · STEP ${d.stepIndex + 1}/${d.steps.length}</div>
        <div class="phase-title ${stepChanged ? 'sweep' : ''}"><span>${TYPE_LABEL[step.type]}</span> PHASE${step.phaseNo > 1 ? ` <em>${step.phaseNo}</em>` : ''}</div>
      </div>
      <div class="phase-turn">
        <div class="phase-team">${esc(teamName(step.team))}</div>
        <div class="phase-actor">${mine ? '<b class="your-turn">YOUR TURN</b>' : `${esc(pname(actorId))} が選択中`}${mine && actorId !== S.me.pid ? `<small>(${esc(pname(actorId))} の代理)</small>` : ''}</div>
      </div>
      <div class="phase-timer" id="timer">${paused ? '<span class="paused">PAUSED</span>' : d.deadline ? '' : '<span class="inf">∞</span>'}</div>`
    : '';

  // ---- step tracker
  const tracker = $('#tracker');
  tracker.innerHTML = stepChips(d.steps, { done: d.stepIndex, current: d.stepIndex, actions: d.steps.map((s) => d.actions.find((a) => a.step === s.i)) });
  const cur = tracker.querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center', behavior: stepChanged ? 'smooth' : 'auto' });

  // ---- teams
  for (const t of ['A', 'B']) $(`#team-${t}`).innerHTML = teamPanel(t, step, states);

  // ---- grid tiles
  const preview = d.preview && step && d.preview.step === step.i ? d.preview.agentId : null;
  $$('#agent-grid .tile').forEach((tile) => {
    const id = tile.dataset.agent;
    const s = states[id];
    const err = step ? selectionError(d, step, id, states) : 'x';
    const cls = ['tile'];
    let badge = '';
    if (s?.gban) {
      cls.push('is-gban');
      badge = 'G-BAN';
    } else if (s?.ban) {
      cls.push('is-ban', `by-${s.ban}`);
      badge = 'BAN';
    }
    if (s?.pick.length) {
      cls.push('is-picked', ...s.pick.map((t) => `pick-${t}`));
      if (!badge) badge = s.pick.length === 2 ? 'A · B' : s.pick[0] === 'A' ? 'ATK' : 'DEF';
    }
    if (s?.protect.length) cls.push('is-protect', ...s.protect.map((t) => `prot-${t}`));
    if (err) cls.push('unavail');
    if (id === S.selected) cls.push('is-selected');
    if (id === preview) cls.push('is-preview');
    if (mine && !paused) cls.push('can-act');
    tile.className = cls.join(' ');
    tile.querySelector('.tile-badge').textContent = badge;
    tile.title = `${agentNameJa(id)}${err && step ? ` — ${err}` : ''}`;
    tile.setAttribute('aria-disabled', String(!!err));
  });
  applyFilter();

  // ---- spotlight (big portrait)
  const focusId = (mine ? S.selected : preview || S.selected) || null;
  renderSpotlight(focusId, { preview, step, states, mine });

  // ---- lock bar
  const lock = $('#lock-bar');
  if (!step) lock.innerHTML = '';
  else if (mine) {
    const sel = S.selected;
    const err = sel ? selectionError(d, step, sel, states) : 'エージェントを選択';
    lock.className = `lock-bar type-${step.type} team-${step.team}`;
    lock.innerHTML = `
      <div class="lock-info">${sel ? `<b>${esc(agentName(sel))}</b><span>${esc(err || TYPE_JA[step.type] + 'して確定')}</span>` : `<span>エージェントを選んでください</span>`}</div>
      <button class="btn-lock" id="lock-btn" ${err || paused ? 'disabled' : ''}>${LOCK_LABEL[step.type]}</button>`;
    $('#lock-btn').onclick = () => lockIn(sel);
  } else {
    lock.className = 'lock-bar waiting';
    lock.innerHTML = `<div class="lock-info"><span class="pulse"></span><span>${esc(pname(actorId))}（${esc(teamName(step.team))}）の${TYPE_JA[step.type]}を待っています</span></div>`;
  }

  // ---- footer (host controls + global bans)
  const gb = d.actions.filter((a) => a.type === 'gban');
  $('#draft-foot').innerHTML = `
    ${gb.length ? `<div class="gbans"><span class="label">GLOBAL BANS</span>${gb.map((a) => `<span class="mini mini-gban team-${a.team}" title="${esc(agentName(a.agentId))}">${agentImg(S.agentMap[a.agentId], 'icon')}</span>`).join('')}</div>` : '<div></div>'}
    <div class="foot-tools">
      <span class="muted small">${d.mirror ? 'ミラーPick可' : 'ミラーPick不可'} · ${d.timer ? d.timer + '秒/ターン' : '時間制限なし'}</span>
      ${
        isHost()
          ? `${paused ? '<button class="btn btn-light btn-sm" data-h="resume">再開</button>' : '<button class="btn btn-ghost btn-sm" data-h="pause">一時停止</button>'}
             <button class="btn btn-ghost btn-sm btn-danger-text" data-h="abort">ドラフト中止</button>`
          : ''
      }
    </div>`;
  $$('#draft-foot [data-h]').forEach(
    (b) =>
      (b.onclick = async () => {
        const h = b.dataset.h;
        if (h === 'abort' && !(await confirmModal({ title: 'ドラフト中止', body: '進行中のドラフトを破棄してロビーに戻ります。', ok: '中止する', danger: true }))) return;
        act({ type: h });
      })
  );

  // flash the slot that just got filled
  if (prev?.draft && prev.draft.actions.length < d.actions.length) {
    const last = d.actions[d.actions.length - 1];
    const el = document.querySelector(`[data-flash="${last.step}"]`);
    if (el) el.classList.add('flash');
    if (last.auto) toast(`時間切れ: ${agentName(last.agentId)} を自動${TYPE_JA[last.type]}`, 'info', 2000);
  }
  tickTimer();
}

function teamPanel(t, step, states) {
  const room = S.room;
  const d = room.draft;
  const picks = d.actions.filter((a) => a.type === 'pick' && a.team === t);
  const slots = d.pickSlots[t].map((pid, slot) => {
    const a = picks[slot];
    const ag = a ? S.agentMap[a.agentId] : null;
    const active = step && step.type === 'pick' && step.team === t && step.slot === slot;
    const previewId = active && d.preview && d.preview.step === step.i ? d.preview.agentId : null;
    const pv = previewId ? S.agentMap[previewId] : null;
    const p = room.players[pid];
    return `<li class="slot ${ag ? 'filled' : ''} ${active ? 'active' : ''}" ${a ? `data-flash="${a.step}"` : ''} style="${ag ? `--c1:${agentColors(ag)?.[0] || '#33424f'}` : ''}">
      <span class="slot-art">${ag ? agentImg(ag, 'killfeed', 'slot-img') : pv ? agentImg(pv, 'killfeed', 'slot-img ghost') : ''}</span>
      <span class="slot-text">
        <span class="slot-agent">${ag ? esc(ag.name) : pv ? `<span class="ghost-name">${esc(pv.name)}</span>` : active ? 'SELECTING…' : '—'}</span>
        <span class="slot-player"><span class="dot ${p?.online ? 'on' : 'off'}"></span>${esc(pname(pid))}${pid === S.me.pid ? ' <i class="you">YOU</i>' : ''}${a?.auto ? ' <i class="auto">AUTO</i>' : ''}</span>
      </span>
      ${ag ? roleIcon(ag.role, 'slot-role') : ''}
    </li>`;
  });
  const listOf = (type) => {
    const steps = d.steps.filter((s) => s.type === type && s.team === t);
    if (!steps.length) return '';
    return `<div class="side-list side-${type}"><span class="label">${TYPE_LABEL[type]}</span><div class="minis">${steps
      .map((s) => {
        const a = d.actions.find((x) => x.step === s.i);
        const active = step && step.i === s.i;
        return `<span class="mini mini-${type} ${active ? 'active' : ''}" ${a ? `data-flash="${a.step}"` : ''} title="${a ? esc(agentName(a.agentId)) : ''}">${a?.agentId ? agentImg(S.agentMap[a.agentId], 'icon') : ''}</span>`;
      })
      .join('')}</div></div>`;
  };
  const isTurn = step && step.team === t;
  return `
    <div class="tp-head ${isTurn ? 'on-turn' : ''}">
      <span class="team-side">${t === 'A' ? 'ATK' : 'DEF'}</span>
      <h3>${esc(teamName(t))}</h3>
    </div>
    <ol class="slots">${slots.join('')}</ol>
    ${listOf('protect')}${listOf('ban')}${listOf('gban')}`;
}

function renderSpotlight(id, { preview, step, states, mine }) {
  const el = $('#spotlight');
  const a = id ? S.agentMap[id] : null;
  const key = `${id}|${step?.i}`;
  if (!a) {
    el.dataset.key = '';
    el.dataset.sig = '';
    el.style.removeProperty('--g1');
    el.style.removeProperty('--g2');
    el.innerHTML = `<div class="spot-empty"><div class="spot-empty-title">${step ? (mine ? 'SELECT AN AGENT' : 'WAITING') : ''}</div><p>${mine ? 'エージェントをクリックして選択 → 確定ボタン(ダブルクリック / Enterでも確定)' : ''}</p></div>`;
    return;
  }
  const s = states[id];
  const role = roleOf(a.role);
  const cols = agentColors(a);
  if (cols) {
    el.style.setProperty('--g1', cols[0]);
    el.style.setProperty('--g2', cols[1]);
  }
  const status = s?.gban ? 'GLOBAL BANNED' : s?.ban ? 'BANNED' : s?.pick?.length ? `PICKED (${s.pick.map((t) => teamName(t)).join(' / ')})` : '';
  const hoverTxt = !mine && preview === id ? pname(stepActor(S.room, step)) : '';
  const sig = `${key}|${status}|${hoverTxt}|${mine}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const changed = el.dataset.key !== key;
  el.dataset.key = key;
  el.innerHTML = `
    ${a.images?.background ? `<img class="spot-bgtext" src="${esc(a.images.background)}" alt="" />` : ''}
    <div class="spot-portrait ${changed ? 'enter' : ''}">${agentImg(a, 'portrait', 'portrait-img')}</div>
    <div class="spot-info">
      <div class="spot-role">${roleIcon(a.role)}<span>${esc(role?.en || '')}</span><small>${esc(role?.ja || '')}</small></div>
      <div class="spot-name">${esc(a.name)}</div>
      <div class="spot-ja">${esc(a.nameJa && a.nameJa !== a.name ? a.nameJa : '')}</div>
      ${status ? `<div class="spot-status">${esc(status)}</div>` : ''}
      ${hoverTxt ? `<div class="spot-hover">${esc(hoverTxt)} が検討中</div>` : ''}
    </div>`;
}

// timer loop
function tickTimer() {
  const el = $('#timer');
  const d = S.room?.draft;
  if (!el || !d || S.room.status !== 'drafting' || !d.deadline) return;
  const left = Math.max(0, d.deadline - (Date.now() + S.clockOffset));
  const total = d.timer * 1000;
  const sec = Math.ceil(left / 1000);
  const pct = Math.max(0, Math.min(1, left / total));
  el.innerHTML = `<span class="t-num ${sec <= 5 ? 'warn' : ''}">${sec}</span><span class="t-bar"><i style="transform:scaleX(${pct})"></i></span>`;
}
setInterval(tickTimer, 200);

// ------------------------------------------------------------------ RESULT
function resultFromRoom(room) {
  const d = room.draft;
  const teams = {};
  for (const t of ['A', 'B']) {
    teams[t] = {
      name: d.teamNames[t],
      players: d.roster[t].map((p) => d.names[p]),
      picks: d.actions.filter((a) => a.type === 'pick' && a.team === t).map((a) => ({ agentId: a.agentId, player: d.names[a.slotPlayer], auto: a.auto })),
      bans: d.actions.filter((a) => a.type === 'ban' && a.team === t).map((a) => a.agentId),
      gbans: d.actions.filter((a) => a.type === 'gban' && a.team === t).map((a) => a.agentId),
      protects: d.actions.filter((a) => a.type === 'protect' && a.team === t).map((a) => a.agentId),
    };
  }
  return {
    id: room.resultId,
    systemId: d.systemId,
    systemName: S.systemMap[d.systemId]?.name,
    mirror: d.mirror,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    teams,
    log: d.actions.map((a) => ({ ...a, by: a.by ? d.names[a.by] : null })),
  };
}

function resultText(r) {
  const line = (t) => {
    const T = r.teams[t];
    const picks = T.picks.map((p) => `${agentName(p.agentId)}(${p.player ?? '-'})`).join(', ');
    const extra = [
      T.gbans.length ? `GBan: ${T.gbans.map(agentName).join(', ')}` : '',
      T.protects.length ? `Protect: ${T.protects.map(agentName).join(', ')}` : '',
      T.bans.length ? `Ban: ${T.bans.map(agentName).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    return `【${T.name}】${picks}${extra ? `\n  ${extra}` : ''}`;
  };
  return `VDra ドラフト結果 (${S.systemMap[r.systemId]?.name || r.systemName})\n${line('A')}\n${line('B')}${r.id ? `\n${location.origin}/r/${r.id}` : ''}`;
}

function resultHtml(r, { inRoom }) {
  const teamBlock = (t) => {
    const T = r.teams[t];
    return `<div class="res-team team-${t}">
      <div class="res-head"><span class="team-side">${t === 'A' ? 'ATK' : 'DEF'}</span><h2>${esc(T.name)}</h2></div>
      <div class="res-cards">${T.picks
        .map((p, i) => {
          const a = S.agentMap[p.agentId];
          const c = agentColors(a);
          return `<div class="res-card" style="--i:${i};--g1:${c?.[0] || '#26343f'};--g2:${c?.[1] || '#0f1923'}">
            <div class="res-art">${agentImg(a, 'portrait', 'res-img')}</div>
            <div class="res-meta">
              <div class="res-role">${a ? roleIcon(a.role) : ''}</div>
              <div class="res-agent">${esc(agentName(p.agentId))}</div>
              <div class="res-player">${esc(p.player ?? '—')}${p.auto ? ' <i class="auto">AUTO</i>' : ''}</div>
            </div>
          </div>`;
        })
        .join('')}</div>
      <div class="res-extra">
        ${['gbans', 'protects', 'bans']
          .map((k) =>
            T[k].length
              ? `<div class="side-list side-${k.slice(0, -1)}"><span class="label">${{ gbans: 'GLOBAL BAN', protects: 'PROTECT', bans: 'BAN' }[k]}</span><div class="minis">${T[k]
                  .map((id) => `<span class="mini mini-${k === 'gbans' ? 'gban' : k === 'bans' ? 'ban' : 'protect'}" title="${esc(agentName(id))}">${agentImg(S.agentMap[id], 'icon')}</span>`)
                  .join('')}</div></div>`
              : ''
          )
          .join('')}
      </div>
    </div>`;
  };
  const date = new Date(r.finishedAt || Date.now());
  return `
    <section class="res-top">
      <div>
        <p class="eyebrow">// ${esc(S.systemMap[r.systemId]?.en || '')} · ${date.toLocaleString('ja-JP')}</p>
        <h1 class="h-display">DRAFT <span class="accent">COMPLETE</span></h1>
      </div>
      <div class="res-actions">
        ${r.id ? `<button class="btn btn-light" data-r="link">結果URLをコピー</button>` : ''}
        <button class="btn btn-ghost" data-r="text">テキストでコピー</button>
        <button class="btn btn-ghost" data-r="json">JSONで保存</button>
        ${navigator.share && r.id ? '<button class="btn btn-ghost" data-r="share">共有</button>' : ''}
        ${inRoom && isHost() ? '<button class="btn btn-red btn-cut" data-r="lobby">ロビーに戻る</button>' : ''}
        ${!inRoom ? '<a class="btn btn-red btn-cut" href="/" data-link>新しくルームを作る</a>' : ''}
      </div>
    </section>
    ${inRoom && !isHost() ? '<p class="muted small center">ホストがロビーに戻すと、次のドラフトを始められます。</p>' : ''}
    <section class="res-body">${resultHtmlTeams(teamBlock)}</section>
    <details class="res-log">
      <summary>ドラフトログ (${r.log.length}手)</summary>
      <ol>${r.log
        .map(
          (l) =>
            `<li class="team-${l.team}"><span class="log-type type-${l.type}">${TYPE_LABEL[l.type]}</span><b>${esc(teamName(l.team, { draft: { teamNames: { A: r.teams.A.name, B: r.teams.B.name } } }))}</b> ${esc(agentName(l.agentId))}<span class="muted"> ${l.auto ? '(時間切れ・自動)' : l.by ? `by ${esc(l.by)}` : ''}</span></li>`
        )
        .join('')}</ol>
    </details>`;
}
const resultHtmlTeams = (teamBlock) => `${teamBlock('A')}<div class="res-vs">VS</div>${teamBlock('B')}`;

function bindResult(r) {
  const app = $('#app');
  const on = (k, fn) => {
    const b = app.querySelector(`[data-r="${k}"]`);
    if (b) b.onclick = fn;
  };
  on('link', () => copyText(`${location.origin}/r/${r.id}`, '結果URLをコピーしました'));
  on('text', () => copyText(resultText(r), '結果をテキストでコピーしました'));
  on('json', () => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vdra-result-${r.id || Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  on('share', () => navigator.share({ title: 'VDra ドラフト結果', text: resultText(r), url: `${location.origin}/r/${r.id}` }).catch(() => {}));
  on('lobby', () => act({ type: 'backToLobby' }));
}

function renderRoomResult() {
  const r = resultFromRoom(S.room);
  const key = `result:${S.room.resultId}:${S.room.hostId}`;
  if (S.view === 'result' && $('#app').dataset.key === key) return;
  mount('result', resultHtml(r, { inRoom: true }));
  $('#app').dataset.key = key;
  bindResult(r);
}

async function renderShared(id) {
  renderTopbar();
  mount('loading', `<div class="center-msg"><div class="spinner"></div></div>`);
  try {
    const r = await api(`/api/results/${id}`);
    mount('result', resultHtml(r, { inRoom: false }));
    bindResult(r);
  } catch {
    mount('error', errorView('結果が見つかりません', 'URLが正しいか確認してください。'));
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    const [ag, sy] = await Promise.all([api('/api/agents'), api('/api/systems')]);
    S.agents = ag.agents;
    S.agentMap = Object.fromEntries(ag.agents.map((a) => [a.id, a]));
    S.roles = ag.roles;
    S.roleIcons = ag.roleIcons || {};
    S.agentSource = ag.source;
    S.systems = sy.systems;
    S.systemMap = Object.fromEntries(sy.systems.map((s) => [s.id, s]));
  } catch (e) {
    mount('error', errorView('サーバーに接続できません', 'サーバーが起動しているか確認してください。'));
    return;
  }
  onRoute();
}
boot();
