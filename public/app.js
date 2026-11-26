// V Dra client — vanilla JS, no build step.
// The server is the single source of truth; this file renders the (per-team) state pushed over SSE.
// Rule checks here only drive the UI (dimming, messages); the server validates every action again.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SITE_TITLE = 'V Dra';
const TYPE_LABEL = { protect: 'PROTECT', ban: 'BAN', pick: 'PICK' };
const TYPE_JA = { protect: 'Protect', ban: 'Ban', pick: 'Pick' };
const LOCK_LABEL = { protect: 'PROTECT', ban: 'BAN', pick: 'LOCK IN' };
const STATUS_JA = { lobby: 'ロビー', drafting: 'ドラフト中', paused: '一時停止中', finished: '終了' };
const SIDE_JA = { atk: 'ATTACK START', def: 'DEFENSE START' };
const SIDE_EN = { atk: 'ATTACK', def: 'DEFENSE' };
const NAME_PH = { A: '例：VORTEX', B: '例：OBSIDIAN' };

// ---- icons (shared by every screen)
const ICON = {
  protect: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2 4 5.3v6.1c0 5 3.4 9.3 8 10.6 4.6-1.3 8-5.6 8-10.6V5.3z" fill="currentColor"/></svg>',
  ban: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.8"/><path d="M6 6l12 12" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>',
  pick: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  global: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 12h17M12 3.4c2.6 2.4 3.6 5.3 3.6 8.6s-1 6.2-3.6 8.6c-2.6-2.4-3.6-5.3-3.6-8.6s1-6.2 3.6-8.6z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  hidden: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M4 20 20 4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  map: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5 9 4l6 2.5 6-2.5v13.5L15 20l-6-2.5L3 20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 4v13.5M15 6.5V20" stroke="currentColor" stroke-width="2"/></svg>',
  up: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eye: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
  crown: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" fill="currentColor"/></svg>',
  kick: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  copy: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V4H4v12h4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  link: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  shuffle: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  exit: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4H5v16h9M10 12h11M17 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  side: '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4 3 8l4 4M3 8h12M17 20l4-4-4-4M21 16H9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const icon = (type) => ICON[type] || '';

const S = {
  agents: [], agentMap: {}, roles: [], roleIcons: {},
  maps: [], mapMap: {}, pool: 7,
  methods: [], methodMap: {}, countSettings: {}, series: {}, defaultTeamNames: { A: 'VORTEX', B: 'OBSIDIAN' }, maxAgentGlobalBans: 4,
  route: null, room: null, me: null, es: null, conn: 'idle', clockOffset: 0, view: null,
  filter: { role: 'all', q: '', only: false },
  selected: null, // locally highlighted agent / map
  simSlot: null, // chosen slot during a simultaneous pick
  lastKey: null,
  resultTab: 0,
};

// ------------------------------------------------------------------ storage
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

// Every action carries an id: a retry after a network error is never applied twice.
async function act(action, { quiet = false } = {}) {
  if (!S.me || !S.room) return null;
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
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function openModal(html, { onClose } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  root.querySelector('.modal-back').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-back')) close();
  });
  return { root: root.querySelector('.modal'), close };
}

function confirmModal({ title, body, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const m = openModal(
      `<h3>${esc(title)}</h3><p>${esc(body)}</p>
       <div class="modal-actions"><button class="btn btn-ghost" data-r="0">キャンセル</button><button class="btn ${danger ? 'btn-red' : 'btn-light'}" data-r="1">${esc(ok)}</button></div>`,
      { onClose: () => resolve(false) }
    );
    m.root.addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]');
      if (!r) return;
      const v = r.dataset.r === '1';
      resolve(v);
      $('#modal-root').innerHTML = '';
    });
    m.root.querySelector('[data-r="1"]').focus();
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

// ------------------------------------------------------------------ visuals
const hex = (c) => (c ? '#' + c.slice(0, 6) : null);
const agentColors = (a) => (a?.colors?.length >= 2 ? a.colors.map(hex) : null);
const initials = (n) => String(n || '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
const roleOf = (id) => S.roles.find((r) => r.id === id);
function roleIcon(roleId, cls = 'role-ico') {
  const url = S.roleIcons[roleId];
  return url ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" />` : `<span class="${cls} role-ico-fallback">${esc((roleOf(roleId)?.en || '?')[0])}</span>`;
}
function fallbackTag(name, cls, role = '') {
  return `<span class="ag-fallback ${cls}" ${role ? `data-role="${esc(role)}"` : ''}>${esc(initials(name))}</span>`;
}
function imgTag(url, alt, cls, fb) {
  if (!url) return fb;
  const fbText = esc(initials(alt));
  return `<img class="${cls}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ag-fallback ${cls}',textContent:'${fbText}'}))" />`;
}
function agentImg(a, kind = 'icon', cls = '') {
  if (!a) return `<span class="ag-fallback ${cls}">?</span>`;
  return imgTag(a.images?.[kind] || a.images?.icon, a.name, cls, fallbackTag(a.name, cls, a.role));
}
function mapImg(mp, kind = 'list', cls = '') {
  if (!mp) return `<span class="ag-fallback ${cls}">?</span>`;
  return imgTag(mp.images?.[kind] || mp.images?.splash, mp.name, cls, `<span class="map-fallback ${cls}">${esc(mp.name)}</span>`);
}
const agentName = (id) => S.agentMap[id]?.name || id || '—';
const agentNameJa = (id) => S.agentMap[id]?.nameJa || agentName(id);
const mapName = (id) => S.mapMap[id]?.name || id || '—';

// ------------------------------------------------------------------ rules (UI mirror of src/engine.js)
const other = (t) => (t === 'A' ? 'B' : 'A');
const curGame = (m) => (m && m.phase === 'agent' ? m.games[m.gameIndex] : null);

function curStep(room = S.room) {
  const m = room?.match;
  if (!m || room.status === 'finished') return null;
  if (m.phase === 'map') {
    const md = m.mapDraft;
    const s = md.steps[md.stepIndex];
    if (!s) return null;
    return { key: `map:${md.stepIndex}`, phase: 'map', kind: s.type === 'side' ? 'side' : 'map', type: s.type, team: s.team, i: md.stepIndex };
  }
  if (m.phase === 'agent') {
    const g = curGame(m);
    const s = g.steps[g.stepIndex];
    if (!s) return null;
    return { key: `g${g.index}:${g.stepIndex}`, phase: 'agent', ...s, i: g.stepIndex, game: g.index };
  }
  if (m.phase === 'between') return { key: `between:${m.gameIndex}`, phase: 'between', kind: 'between' };
  return null;
}

function agentStates(game) {
  const st = {};
  for (const a of game.actions) if (a.agentId) (st[a.agentId] ||= { ban: [], protect: [], pick: [] })[a.type].push(a.team);
  return st;
}
const EMPTY = { ban: [], protect: [], pick: [] };

function agentError(m, game, team, type, id, { states = agentStates(game), ownPending = [] } = {}) {
  const method = S.methodMap[m.method];
  const rules = method.rules;
  const s = states[id] || EMPTY;
  const opp = other(team);
  if (m.agentGlobalBans.includes(id)) return 'Global Ban中';
  if (type === 'protect') {
    if (s.protect.includes(team)) return 'Protect済み';
    if (s.protect.includes(opp)) return '相手がProtect済み';
    if (s.ban.length) return 'Ban済み';
    return null;
  }
  if (type === 'ban') {
    if (ownPending.includes(id) || s.ban.includes(team)) return 'Ban済み';
    if (rules.banCross === 'unique' && s.ban.includes(opp)) return '相手がBan済み';
    if (s.protect.includes(opp)) return '相手がProtect中';
    if (s.protect.includes(team)) return '自チームがProtect中';
    if (s.pick.length) return 'Pick済み';
    return null;
  }
  for (const bt of s.ban) {
    if (rules.banTarget === 'both') return 'Ban済み';
    if (bt !== team) return '相手にBanされています';
  }
  if (ownPending.includes(id) || s.pick.includes(team)) return '自チームでPick済み';
  if (rules.pickCross === 'unique' && s.pick.includes(opp)) return '相手がPick済み';
  if (rules.protectEffect === 'noEnemyBanPick' && s.protect.includes(opp)) return '相手がProtect中';
  if (method.fearless && m.fearlessUsed[team].includes(id)) return '前のマップで使用済み';
  return null;
}
function mapError(m, id) {
  const md = m.mapDraft;
  if (!md.pool.includes(id)) return '使用できません';
  if (md.actions.some((a) => a.mapId === id && a.type !== 'side')) return 'Ban / Pick済み';
  return null;
}

const awayP = (room, pid, team) => {
  const p = pid && room.players[pid];
  return !p || !p.online || p.team !== team;
};
function teamFallback(room, pid, team, actor) {
  if (actor && actor === pid) return true;
  if (!awayP(room, actor, team)) return false;
  const me = room.players[pid];
  if (!me || me.team !== team) return false;
  const cap = room.match.captains[team];
  return pid === cap || awayP(room, cap, team);
}
function stepActor(room, st) {
  const m = room.match;
  if (st.kind === 'seq' && st.type === 'pick') return m.pickSlots[st.team][st.slot] ?? null;
  return m.captains[st.team] ?? null;
}
function canActStep(room, pid, st) {
  if (!st || st.kind === 'between' || st.kind === 'sim') return false;
  if (room.settings.hostOverride && room.hostId === pid) return true;
  return teamFallback(room, pid, st.team, stepActor(room, st));
}
function canActSim(room, pid, st, team, slot = null) {
  const m = room.match;
  const me = room.players[pid];
  if (!me) return false;
  if (st.hidden && me.team !== team) return false;
  if (room.settings.hostOverride && room.hostId === pid && me.team === team) return true;
  if (me.team !== team) return false;
  if (pid === m.captains[team]) return true;
  if (st.type === 'pick') return teamFallback(room, pid, team, m.pickSlots[team][slot]);
  return teamFallback(room, pid, team, m.captains[team]);
}

const isHost = () => S.room && S.me && S.room.hostId === S.me.pid;
const myTeam = () => S.room?.players[S.me?.pid]?.team ?? null;
const pname = (pid) => S.room?.players[pid]?.name || S.room?.match?.names?.[pid] || '—';
function teamName(t, room = S.room) {
  return room?.match?.teamNames?.[t] || room?.settings?.teamNames?.[t] || S.defaultTeamNames[t];
}

function agentsRequired(methodId, s, games) {
  const v = (k) => Number(s[k] ?? S.countSettings[k]?.def);
  switch (methodId) {
    case 'normal': return 10;
    case 'ban': case 'enemy_ban': case 'protect_ban': case 'head_protect': return 10 + 2 * v('banCount');
    case 'blind_ban': return 5 + 2 * v('blindBanCount');
    case 'blind_enemy_ban': return 5 + v('blindEnemyBanCount');
    case 'fearless': return 5 * games;
  }
  return 10;
}
function globalBanCap(s) {
  const games = s.mode === 'map' ? S.series[s.series].games : 1;
  return Math.max(0, Math.min(S.maxAgentGlobalBans, S.agents.length - agentsRequired(s.method, s, games)));
}

// Expand a method into steps (UI preview only).
function previewSteps(method, s, first = 'A') {
  const steps = [];
  method.phases.forEach((ph) => {
    const n = typeof ph.count === 'number' ? ph.count : Number(s[ph.count]);
    if (ph.simultaneous) return steps.push({ kind: 'sim', type: ph.type, count: n, hidden: ph.hidden });
    const order = method.usesOrder ? s.order : 'standard';
    for (let k = 0; k < n * 2; k++) {
      const firstMove = order === 'snake' ? k % 4 === 0 || k % 4 === 3 : k % 2 === 0;
      steps.push({ kind: 'seq', type: ph.type, team: firstMove ? first : other(first) });
    }
  });
  return steps;
}

function chip(step, { done = false, current = false, agent = null, title = '' } = {}) {
  const cls = ['chip', `chip-${step.type}`, step.team ? `team-${step.team}` : 'team-AB', step.kind === 'sim' ? 'chip-sim' : '', done ? 'done' : '', current ? 'current' : ''].join(' ');
  const inner = agent ? agentImg(agent, 'icon', 'chip-img') : step.kind === 'sim' ? `${icon(step.type)}<em>×${step.count}</em>` : icon(step.type);
  return `<span class="${cls}" title="${esc(title)}">${inner}</span>`;
}

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
  if (S.room?.id === r.id && S.me) return render();
  const me = loadIdentity(r.id, { sessionOnly: true });
  if (me) return connect(r.id, me);
  return renderJoin(r.id);
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
  es.addEventListener('left', (e) => {
    es.close();
    clearIdentity(roomId);
    disconnect();
    let deleted = false;
    try {
      deleted = JSON.parse(e.data).deleted;
    } catch {}
    toast(deleted ? 'ルームが削除されました' : 'ルームから退出しました', 'info');
    navigate('/');
  });
  es.onerror = () => {
    if (S.es !== es) return;
    S.conn = 'reconnecting';
    renderTopbar();
    if (es.readyState === EventSource.CLOSED) {
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
            mount('error', errorView('ルームが見つかりません', '削除された、または存在しないルームIDです。'));
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
  toast('参加情報が無効になりました', 'error');
  navigate('/');
}

window.addEventListener('online', () => {
  if (S.route?.name === 'room' && S.me && (!S.es || S.es.readyState === EventSource.CLOSED)) openStream(S.route.id);
});

function applyState(room) {
  const prev = S.room;
  S.room = room;
  if (S.me && !room.players[S.me.pid]) {
    clearIdentity(room.id);
    disconnect();
    navigate('/');
    return;
  }
  const st = curStep(room);
  const key = st?.key ?? null;
  if (key !== S.lastKey) {
    S.selected = null;
    S.simSlot = null;
  }
  render(prev);
  if (st && key !== S.lastKey && prev) notifyTurn(room, st);
  if (prev && prev.hostId !== room.hostId && room.hostId === S.me.pid) toast('あなたがホストになりました', 'turn');
  S.lastKey = key;
}

function notifyTurn(room, st) {
  let mine = false;
  if (st.kind === 'sim') mine = !!myTeam() && canActSim(room, S.me.pid, st, myTeam(), room.match.pickSlots[myTeam()]?.indexOf(S.me.pid));
  else if (st.kind !== 'between') mine = stepActor(room, st) === S.me.pid;
  if (!mine) return;
  toast(st.kind === 'sim' ? '同時選択が始まりました' : 'あなたのターンです', 'turn', 2000);
  try {
    navigator.vibrate?.(60);
  } catch {}
  if (document.hidden) document.title = `▶ あなたのターン — ${SITE_TITLE}`;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = SITE_TITLE;
});

// ------------------------------------------------------------------ mount
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
  const lobby = S.room.status === 'lobby' || (S.room.status === 'finished' && S.localLobby);
  el.innerHTML = `
    ${
      lobby
        ? `<div class="tb-invite">
      <input class="tb-url mono" readonly value="${esc(inviteUrl())}" aria-label="招待URL" />
      <button class="tb-btn tb-btn-light" data-copy="url">${icon('link')}URLコピー</button>
      <span class="tb-room"><span>ROOM ID</span><b>${esc(S.room.id)}</b></span>
      <button class="tb-btn" data-copy="code">${icon('copy')}IDコピー</button>
    </div>`
        : `<button class="room-chip" data-copy="url" title="招待URLをコピー"><span>ROOM</span><b>${esc(S.room.id)}</b></button>`
    }
    <span class="conn conn-${S.conn}">${S.conn === 'live' ? 'LIVE' : '再接続中…'}</span>
    ${me && !lobby ? `<span class="me-chip">${esc(me.name)}${isHost() ? '<i>HOST</i>' : ''}</span>` : ''}`;
  const u = el.querySelector('[data-copy="url"]');
  if (u) u.onclick = () => copyText(inviteUrl(), '招待URLをコピーしました');
  const c = el.querySelector('[data-copy="code"]');
  if (c) c.onclick = () => copyText(S.room.id, 'ルームIDをコピーしました');
}
const inviteUrl = () => `${location.origin}/room/${S.room.id}`;

function setPov() {
  const drafting = S.room && (S.room.status === 'drafting' || S.room.status === 'paused');
  const t = drafting ? myTeam() : null;
  document.body.classList.toggle('pov-A', t === 'A');
  document.body.classList.toggle('pov-B', t === 'B');
}

function render(prev) {
  if (S.room && S.room.status !== 'finished') S.localLobby = false;
  renderTopbar();
  setPov();
  if (!S.room) return;
  const st = S.room.status;
  if (st === 'finished' && S.localLobby) return renderLobby();
  if (st === 'lobby') return renderLobby();
  if (st === 'finished') return renderRoomResult();
  const m = S.room.match;
  if (m.phase === 'map') return renderMapDraft(prev);
  if (m.phase === 'between') return renderBetween();
  return renderAgentDraft(prev);
}

function errorView(title, msg) {
  return `<div class="center-msg"><h2 class="h-display">${esc(title)}</h2><p>${esc(msg)}</p><a class="btn btn-red" href="/" data-link>トップへ戻る</a></div>`;
}

// ------------------------------------------------------------------ HOME
function renderHome() {
  renderTopbar();
  document.title = SITE_TITLE;
  mount(
    'home',
    `
    <section class="hero">
      <div class="hero-text">
        <p class="eyebrow">// VALORANT DRAFT</p>
        <h1 class="h-hero">DRAFT <span>YOUR SQUAD</span></h1>
        <p class="lead">ルームを作ってURLを送るだけ。マップドラフト(Bo3/Bo5)からエージェントのProtect・Ban・Pickまで、全員の画面でリアルタイムに。</p>
      </div>
      <div class="hero-cards">
        <form class="card card-sq card-create" id="create-form" autocomplete="off">
          <span class="card-tag">01</span>
          <h2>ルームを作成</h2>
          <p class="card-sub">ホストとしてルームを作り、URLで招待</p>
          <div class="card-fields">
            <label class="sq-field"><span>PLAYER NAME</span><input name="name" maxlength="16" required placeholder="例：Lecter" value="${esc(savedName())}" /></label>
          </div>
          <button class="btn btn-red btn-cut card-go" type="submit">CREATE ROOM</button>
        </form>
        <form class="card card-sq card-join" id="join-form" autocomplete="off">
          <span class="card-tag">02</span>
          <h2>ルームに参加</h2>
          <p class="card-sub">ルームIDを入力して参加</p>
          <div class="card-fields">
            <label class="sq-field"><span>ROOM ID</span><input name="code" maxlength="6" required placeholder="ABC123" class="mono upper" /></label>
            <label class="sq-field"><span>PLAYER NAME</span><input name="name" maxlength="16" required placeholder="例：Lecter" value="${esc(savedName())}" /></label>
          </div>
          <button class="btn btn-light btn-cut card-go" type="submit">JOIN ROOM</button>
        </form>
      </div>
    </section>
    <section class="formats">
      <h3 class="h-section">DRAFT SYSTEMS<span>8 METHODS · STANDARD / SNAKE · BO3 / BO5</span></h3>
      <div class="format-grid">${S.methods.map(formatCard).join('')}</div>
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

function formatCard(m) {
  const defaults = { order: 'standard', ...Object.fromEntries(Object.entries(S.countSettings).map(([k, v]) => [k, v.def])) };
  const steps = previewSteps(m, defaults);
  return `<div class="format-card">
    <div class="format-no">${String(m.no).padStart(2, '0')}</div>
    <div class="format-body">
      <div class="format-en">${esc(m.name)}${m.seriesOnly ? '<i class="tag tag-series">Bo3/Bo5</i>' : ''}</div>
      <p>${esc(m.desc)}</p>
      <div class="chips">${steps.map((s) => chip(s)).join('')}</div>
    </div>
  </div>`;
}

async function joinRoom(code, name, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/rooms/${code}/join`, { body: { name } });
    saveIdentity(r.roomId, { pid: r.pid, token: r.token });
    if (S.route?.name === 'room' && S.route.id === r.roomId) connect(r.roomId, { pid: r.pid, token: r.token });
    else navigate(`/room/${r.roomId}`);
  } catch (err) {
    toast(err.status === 404 ? 'ルームが見つかりません' : err.message, 'error');
    if (btn) btn.disabled = false;
  }
}

async function renderJoin(roomId) {
  renderTopbar();
  mount('join', `<div class="center-msg"><div class="spinner"></div></div>`);
  let info;
  try {
    info = await api(`/api/rooms/${roomId}`);
  } catch {
    return mount('error', errorView('ルームが見つかりません', '削除された、または存在しないルームIDです。'));
  }
  const prevId = loadIdentity(roomId);
  mount(
    'join',
    `<div class="join-wrap">
      <form class="card join-card" id="join2" autocomplete="off">
        <p class="eyebrow">// INVITATION</p>
        <h2 class="h-display">ROOM <span class="mono accent">${esc(roomId)}</span></h2>
        <p class="muted small">ホスト: ${esc(info.host || '—')}　参加者 ${info.players}/${info.max}　状態: ${esc(STATUS_JA[info.status] || info.status)}</p>
        ${info.status === 'drafting' || info.status === 'paused' ? '<p class="note">ドラフト進行中のため、観戦者として参加します。</p>' : ''}
        <div class="card-row">
          <input name="name" maxlength="16" required placeholder="例：Lecter" value="${esc(savedName())}" aria-label="プレイヤー名" />
          <button class="btn btn-red btn-cut" type="submit">JOIN</button>
        </div>
        ${prevId ? `<button type="button" class="btn btn-ghost btn-sm" id="rejoin">前回の参加者として再接続</button>` : ''}
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
  const s = room.settings;
  const method = S.methodMap[s.method];
  const me = room.players[S.me.pid];
  const spectators = Object.values(room.players).filter((p) => !p.team).sort((a, b) => a.joinedAt - b.joinedAt);
  const mapNeed = s.mode === 'map' ? S.maps.length - S.pool - s.mapGlobalBans.length : 0;
  const ready = room.ready || { A: false, B: false };
  const startBlock = !room.order.A.length || !room.order.B.length
    ? '両チームに1人以上必要です'
    : mapNeed > 0
      ? `マップのGlobal Banをあと${mapNeed}個選んでください`
      : !ready.A || !ready.B
        ? `両チームのキャプテンのREADY待ち(A ${ready.A ? '✓' : '—'} / B ${ready.B ? '✓' : '—'})`
        : '';
  const cap = globalBanCap(s);

  const playerRow = (p, idx, team) => `
    <li class="pl ${p.id === S.me.pid ? 'is-me' : ''}" style="--i:${idx}">
      <span class="dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'オンライン' : 'オフライン'}"></span>
      ${
        p.id === S.me.pid
          ? `<input id="rename" class="pl-name-input" maxlength="16" value="${esc(p.name)}" placeholder="例：Lecter" title="クリックして名前を変更" aria-label="あなたの名前" />`
          : `<span class="pl-name">${esc(p.name)}</span>`
      }
      ${p.id === room.hostId ? '<i class="tag tag-host">HOST</i>' : ''}
      ${team && idx === 0 ? '<i class="tag tag-cap" title="Ban / Protect / マップ操作 / チーム名">CAPTAIN</i>' : ''}
      ${
        host
          ? `<span class="pl-tools">
        ${team ? `<button class="ico" data-act="up" data-id="${p.id}" title="上へ(並び順)" ${idx === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="ico" data-act="down" data-id="${p.id}" title="下へ(並び順)">${icon('down')}</button>` : ''}
        ${team !== 'A' ? `<button class="ico ico-team ico-A" data-act="toA" data-id="${p.id}" title="TEAM Aへ移動">A</button>` : ''}
        ${team !== 'B' ? `<button class="ico ico-team ico-B" data-act="toB" data-id="${p.id}" title="TEAM Bへ移動">B</button>` : ''}
        ${team ? `<button class="ico" data-act="toS" data-id="${p.id}" title="観戦へ移動">${icon('eye')}</button>` : ''}
        ${p.id !== room.hostId ? `<button class="ico ico-crown" data-act="host" data-id="${p.id}" title="ホストを譲る">${icon('crown')}</button><button class="ico ico-danger" data-act="kick" data-id="${p.id}" title="キック">${icon('kick')}</button>` : ''}
      </span>`
          : ''
      }
    </li>`;

  const teamCol = (t) => {
    const list = room.order[t].map((id) => room.players[id]).filter(Boolean);
    const canEditName = host || room.order[t][0] === S.me.pid;
    const empty = Array.from({ length: 5 - list.length }, () => `<li class="pl pl-empty">EMPTY</li>`).join('');
    return `<div class="team-col team-${t}">
      <div class="team-head">
        <span class="team-side">TEAM ${t}</span>
        <input class="team-name-input" data-team-name="${t}" maxlength="16" value="${esc(s.teamNames[t])}" placeholder="${NAME_PH[t]}" ${canEditName ? '' : 'disabled'} aria-label="TEAM ${t} のチーム名" />
        <span class="team-count">${list.length}/5</span>
      </div>
      <ol class="pl-list">${list.map((p, i) => playerRow(p, i, t)).join('')}${empty}</ol>
      ${
        room.order[t][0] === S.me.pid
          ? `<button class="btn btn-sm ready-btn ${ready[t] ? 'is-ready' : ''}" data-ready="${ready[t] ? '0' : '1'}">${ready[t] ? `${icon('pick')} READY(押すと解除)` : 'READY'}</button>`
          : `<div class="ready-state ${ready[t] ? 'is-ready' : ''}">${ready[t] ? `${icon('pick')} READY` : list.length ? 'キャプテンのREADY待ち' : ''}</div>`
      }
      ${me.team !== t ? `<button class="btn btn-sm btn-team btn-team-${t}" data-join="${t}" ${list.length >= 5 ? 'disabled' : ''}>TEAM ${t} に入る</button>` : `<button class="btn btn-sm btn-ghost" data-join="">観戦に移る</button>`}
    </div>`;
  };

  const seg = (name, opts, cur, disabledFn = () => false) =>
    `<div class="seg" role="radiogroup">${opts
      .map(([v, label]) => `<button class="seg-btn ${String(cur) === String(v) ? 'on' : ''}" data-set="${name}" data-v="${esc(v)}" ${host && !disabledFn(v) ? '' : 'disabled'}>${label}</button>`)
      .join('')}</div>`;

  const countOpts = method.settings
    .map((k) => {
      const c = S.countSettings[k];
      const opts = [];
      for (let v = c.min; v <= c.max; v++) opts.push([v, `${v}`]);
      return `<div class="opt"><span>${esc(c.label)}</span>${seg(k, opts, s[k])}</div>`;
    })
    .join('');

  const steps = previewSteps(method, s);
  const settingsHtml = `
    <div class="panel settings ${host ? '' : 'readonly'}">
      <div class="panel-head"><h3>DRAFT SETTINGS</h3>${host ? '' : '<span class="muted small">ホストのみ変更できます</span>'}</div>
      <div class="opt"><span>モード</span>${seg('mode', [['agent', 'AGENT ONLY'], ['map', 'MAP + AGENT']], s.mode)}</div>
      ${s.mode === 'map' ? `<div class="opt"><span>シリーズ</span>${seg('series', [['bo3', 'BO3'], ['bo5', 'BO5']], s.series)}</div>` : ''}
      <div class="method-list">
        ${S.methods
          .map((m) => {
            const dis = m.seriesOnly && s.mode !== 'map';
            return `<button class="method ${m.id === s.method ? 'on' : ''}" data-set="method" data-v="${m.id}" ${host && !dis ? '' : 'disabled'} title="${esc(m.desc)}${dis ? '(Map + Agent Draft のみ)' : ''}">
              <span class="method-no">${m.no}</span><span class="method-name">${esc(m.name)}</span>
            </button>`;
          })
          .join('')}
      </div>
      <div class="method-detail">
        <p>${esc(method.desc)}</p>
        <div class="chips">${steps.map((x) => chip(x)).join('')}</div>
      </div>
      ${method.usesOrder ? `<div class="opt"><span>ドラフト順序</span>${seg('order', [['standard', 'STANDARD'], ['snake', 'SNAKE']], s.order)}</div>` : ''}
      ${countOpts}
      <div class="opt"><span>1手の制限時間</span>
        <select data-set-select="timer" ${host ? '' : 'disabled'}>${[0, 15, 20, 30, 45, 60, 90].map((v) => `<option value="${v}" ${s.timer === v ? 'selected' : ''}>${v ? v + '秒' : 'なし'}</option>`).join('')}</select>
      </div>
      <div class="opt"><span>ホストが全ターンを代理操作</span><span class="switch"><input type="checkbox" data-set-check="hostOverride" ${s.hostOverride ? 'checked' : ''} ${host ? '' : 'disabled'} /><i></i></span></div>
      <div class="gb-row">
        <button class="gb-btn" data-gb="agent" ${host ? '' : 'disabled'}>
          <span class="gb-label">${icon('global')} エージェント Global Ban <b>${s.agentGlobalBans.length}/${cap}</b></span>
          <span class="minis">${s.agentGlobalBans.map((id) => `<span class="mini mini-ban">${agentImg(S.agentMap[id], 'icon')}</span>`).join('') || '<span class="muted small">なし</span>'}</span>
        </button>
        ${
          s.mode === 'map'
            ? `<button class="gb-btn ${mapNeed > 0 ? 'need' : ''}" data-gb="map" ${host ? '' : 'disabled'}>
          <span class="gb-label">${icon('map')} マップ Global Ban <b>${s.mapGlobalBans.length}/${Math.max(0, S.maps.length - S.pool)}</b></span>
          <span class="minis">${s.mapGlobalBans.map((id) => `<span class="mini mini-map">${esc(mapName(id))}</span>`).join('') || `<span class="muted small">残り${S.maps.length}マップ → ${S.pool}マップにしてください</span>`}</span>
        </button>`
            : ''
        }
      </div>
    </div>`;

  const keepScroll = window.scrollY;
  const ae = document.activeElement;
  const focusKey = ae && $('#app').contains(ae) && ae.matches('input[id], input[data-team-name]') ? (ae.id ? '#' + ae.id : `[data-team-name="${ae.dataset.teamName}"]`) : null;
  const focusVal = focusKey ? { v: ae.value, s: ae.selectionStart, e: ae.selectionEnd } : null;

  mount(
    'lobby',
    `
    <section class="lobby-head">
      <p class="eyebrow">// LOBBY</p>
      <p class="muted small lobby-tip">自分の名前はチーム欄の名前をクリックすると変更できます${me.team && room.order[me.team][0] === S.me.pid ? '。キャプテンはチーム名も入力できます' : ''}</p>
    </section>
    <section class="lobby-grid">
      <div class="teams">
        ${teamCol('A')}
        ${teamCol('B')}
        <div class="spec">
          <div class="panel-head"><h3>${icon('eye')} SPECTATORS</h3><span class="muted small">${spectators.length}人</span></div>
          <ul class="pl-list spec-list">${spectators.length ? spectators.map((p, i) => playerRow(p, i, null)).join('') : '<li class="pl pl-empty">なし</li>'}</ul>
        </div>
        <div class="action-row">
          ${host ? `<button class="btn btn-ghost act-btn" data-shuffle>${icon('shuffle')}ランダムでチーム分け</button>` : ''}
          ${host ? `<button class="btn btn-red btn-cut act-btn btn-start" data-start ${startBlock ? 'disabled' : ''} title="${esc(startBlock)}">START DRAFT</button>` : `<div class="waiting act-btn"><span class="pulse"></span>ホストの開始を待っています</div>`}
          ${room.status === 'finished' ? `<button class="btn btn-ghost act-btn" data-back-result>結果に戻る</button>` : ''}
          <button class="btn btn-ghost act-btn btn-leave" data-leave>${icon('exit')}退出</button>
          ${host && startBlock ? `<span class="muted small start-hint">${esc(startBlock)}</span>` : ''}
        </div>
        ${room.history?.length ? `<div class="history"><span class="muted small">過去の結果</span>${room.history.slice(0, 5).map((id, i) => `<a href="/r/${esc(id)}" data-link>#${room.history.length - i}</a>`).join('')}</div>` : ''}
      </div>
      <aside class="side">${settingsHtml}</aside>
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

  const app = $('#app');
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
  $$('[data-set]', app).forEach(
    (b) =>
      (b.onclick = () => {
        const k = b.dataset.set;
        const v = b.dataset.v;
        act({ type: 'updateSettings', settings: { [k]: S.countSettings[k] ? Number(v) : v } });
      })
  );
  $$('[data-set-select]', app).forEach((el) => (el.onchange = () => act({ type: 'updateSettings', settings: { [el.dataset.setSelect]: Number(el.value) } })));
  $$('[data-set-check]', app).forEach((el) => (el.onchange = () => act({ type: 'updateSettings', settings: { [el.dataset.setCheck]: el.checked } })));
  $$('[data-team-name]', app).forEach((el) => {
    let t = null;
    el.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => act({ type: 'setTeamName', team: el.dataset.teamName, name: el.value }, { quiet: true }), 350);
    };
    el.onchange = () => {
      clearTimeout(t);
      act({ type: 'setTeamName', team: el.dataset.teamName, name: el.value });
    };
  });
  $$('[data-ready]', app).forEach((b) => (b.onclick = () => act({ type: 'setReady', ready: b.dataset.ready === '1' })));
  const backRes = app.querySelector('[data-back-result]');
  if (backRes)
    backRes.onclick = () => {
      S.localLobby = false;
      render();
    };
  const sh = app.querySelector('[data-shuffle]');
  if (sh) sh.onclick = () => act({ type: 'shuffleTeams' });
  const st = app.querySelector('[data-start]');
  if (st) st.onclick = () => act({ type: 'start' });
  $$('[data-gb]', app).forEach((b) => (b.onclick = () => (b.dataset.gb === 'agent' ? openAgentGlobalBan() : openMapGlobalBan())));
  const rn = $('#rename');
  if (rn) {
    const commit = () => {
      if (!rn.isConnected) return; // replaced by a re-render while typing: the new input keeps the text
      const n = rn.value.trim();
      const cur = S.room.players[S.me.pid]?.name;
      if (!n) return (rn.value = cur || '');
      if (n === cur) return;
      saveName(n);
      act({ type: 'rename', name: n });
    };
    rn.onkeydown = (e) => {
      if (e.key === 'Enter') rn.blur();
      if (e.key === 'Escape') {
        rn.value = S.room.players[S.me.pid]?.name || '';
        rn.blur();
      }
    };
    rn.onblur = commit;
  }
  app.querySelector('[data-leave]').onclick = leaveRoom;
}

async function leaveRoom() {
  const alone = Object.keys(S.room.players).length <= 1;
  const body = alone ? 'あなたしかいないため、退出するとルームは削除されます。' : isHost() ? '退出すると、ホストは残っている参加者に引き継がれます。' : 'ルームから退出します。';
  if (!(await confirmModal({ title: 'ルームを退出', body, ok: '退出', danger: true }))) return;
  const id = S.room.id;
  await act({ type: 'leave' });
  clearIdentity(id);
  disconnect();
  navigate('/');
}

function openAgentGlobalBan() {
  const s = S.room.settings;
  const cap = globalBanCap(s);
  const sel = new Set(s.agentGlobalBans);
  const m = openModal(`
    <h3>${icon('global')} エージェント Global Ban</h3>
    <p class="muted small">全マップ・全フェーズで両チーム使用不可になります。この設定では最大 <b>${cap}</b> 体。</p>
    <div class="pick-grid agent-pick-grid">${S.agents
      .map((a) => `<button class="pg-item ${sel.has(a.id) ? 'on' : ''}" data-id="${a.id}" title="${esc(a.nameJa)}">${agentImg(a, 'icon')}<span>${esc(a.name)}</span></button>`)
      .join('')}</div>
    <div class="modal-actions"><span class="muted small" id="gb-count"></span><button class="btn btn-ghost" data-x>キャンセル</button><button class="btn btn-red" data-save>保存</button></div>`);
  m.root.classList.add('modal-wide');
  const upd = () => ($('#gb-count').textContent = `${sel.size} / ${cap}`);
  upd();
  m.root.querySelector('.pick-grid').onclick = (e) => {
    const b = e.target.closest('.pg-item');
    if (!b) return;
    const id = b.dataset.id;
    if (sel.has(id)) sel.delete(id);
    else if (sel.size < cap) sel.add(id);
    else return toast(`最大${cap}体です`, 'error', 1400);
    b.classList.toggle('on', sel.has(id));
    upd();
  };
  m.root.querySelector('[data-x]').onclick = m.close;
  m.root.querySelector('[data-save]').onclick = async () => {
    await act({ type: 'updateSettings', settings: { agentGlobalBans: [...sel] } });
    m.close();
  };
}

function openMapGlobalBan() {
  const s = S.room.settings;
  const cap = Math.max(0, S.maps.length - S.pool);
  const sel = new Set(s.mapGlobalBans);
  const m = openModal(`
    <h3>${icon('map')} マップ Global Ban</h3>
    <p class="muted small">使用しないマップを <b>${cap}</b> 個選んでください(残り${S.pool}マップでマップドラフトを行います)。</p>
    <div class="pick-grid map-pick-grid">${S.maps
      .map((mp) => `<button class="pg-item pg-map ${sel.has(mp.id) ? 'on' : ''}" data-id="${mp.id}">${mapImg(mp, 'list')}<span>${esc(mp.name)}</span></button>`)
      .join('')}</div>
    <div class="modal-actions"><span class="muted small" id="gb-count"></span><button class="btn btn-ghost" data-x>キャンセル</button><button class="btn btn-red" data-save>保存</button></div>`);
  m.root.classList.add('modal-wide');
  const upd = () => ($('#gb-count').textContent = `Ban ${sel.size} / ${cap}(残り ${S.maps.length - sel.size} マップ)`);
  upd();
  m.root.querySelector('.pick-grid').onclick = (e) => {
    const b = e.target.closest('.pg-item');
    if (!b) return;
    const id = b.dataset.id;
    if (sel.has(id)) sel.delete(id);
    else if (sel.size < cap) sel.add(id);
    else return toast(`最大${cap}個です`, 'error', 1400);
    b.classList.toggle('on', sel.has(id));
    upd();
  };
  m.root.querySelector('[data-x]').onclick = m.close;
  m.root.querySelector('[data-save]').onclick = async () => {
    await act({ type: 'updateSettings', settings: { mapGlobalBans: [...sel] } });
    m.close();
  };
}

// ------------------------------------------------------------------ shared draft chrome
function seriesBar(compact = false) {
  const m = S.room.match;
  if (m.mode !== 'map') return '';
  if (compact) {
    const maps = m.mapDraft.maps;
    return `<div class="series-strip"><span class="ss-title">${esc(m.series.toUpperCase())}</span>${maps
      .map((mp, i) => {
        const cur = m.gameIndex === i;
        const done = m.games[i]?.finishedAt;
        return `<span class="ss-cell ${cur ? 'current' : ''} ${done ? 'done' : ''}">
          <b>${i + 1}</b><span class="ss-name">${esc(mapName(mp.mapId))}</span>
          ${mp.decider ? '<i class="tag tag-decider">D</i>' : `<i class="tag team-tag-${mp.pickedBy}">${mp.pickedBy}</i>`}
          ${cur && mp.startSides ? `<i class="side-tag side-${mp.startSides.A}">A ${SIDE_EN[mp.startSides.A]}</i><i class="side-tag side-${mp.startSides.B}">B ${SIDE_EN[mp.startSides.B]}</i>` : ''}
          ${done ? icon('pick') : ''}
        </span>`;
      })
      .join('')}</span></div>`;
  }
  const maps = m.mapDraft.maps;
  const total = S.series[m.series].games;
  const cells = Array.from({ length: total }, (_, i) => {
    const mp = maps[i];
    const cur = m.phase !== 'map' && m.gameIndex === i;
    const done = m.games[i]?.finishedAt;
    return `<div class="sb-cell ${cur ? 'current' : ''} ${done ? 'done' : ''}">
      <span class="sb-no">MAP ${i + 1}</span>
      <span class="sb-name">${mp ? esc(mapName(mp.mapId)) : '—'}</span>
      ${mp ? `<span class="sb-meta">${mp.decider ? '<i class="tag tag-decider">DECIDER</i>' : `<i class="tag team-tag-${mp.pickedBy}">${mp.pickedBy} PICK</i>`}${mp.startSides ? `<i class="side-tag">A:${SIDE_EN[mp.startSides.A]}</i>` : ''}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="series-bar"><span class="sb-title">${esc(m.series.toUpperCase())}</span>${cells}</div>`;
}

function centerTracker() {
  const tr = $('#tracker');
  const cur = tr?.querySelector('.current');
  const box = tr?.parentElement;
  if (!cur || !box) return;
  box.scrollLeft = cur.offsetLeft - box.clientWidth / 2 + cur.offsetWidth / 2;
}

// Current map + starting sides, shown prominently during the agent draft of a series.
function mapBadge() {
  const m = S.room.match;
  const g = curGame(m);
  if (!g?.mapId) return '';
  const mp = m.mapDraft?.maps[m.gameIndex];
  const img = S.mapMap[g.mapId]?.images?.list;
  return `<div class="phase-map" style="${img ? `--map:url('${esc(img)}')` : ''}">
    <span class="pm-no">MAP ${m.gameIndex + 1}/${m.games.length}${mp?.decider ? ' · DECIDER' : ''}</span>
    <b class="pm-name">${esc(mapName(g.mapId))}</b>
    ${mp?.startSides ? `<span class="pm-sides"><i class="side-tag side-${mp.startSides.A}">A ${SIDE_EN[mp.startSides.A]}</i><i class="side-tag side-${mp.startSides.B}">B ${SIDE_EN[mp.startSides.B]}</i></span>` : ''}
  </div>`;
}

function phaseBanner(st, { mine, actorText }) {
  const room = S.room;
  const m = room.match;
  const paused = room.status === 'paused';
  let title;
  let teamTxt;
  let typeCls = st.type;
  if (st.kind === 'sim') {
    title = `BLIND ${TYPE_LABEL[st.type]}`;
    teamTxt = 'BOTH TEAMS';
  } else if (st.kind === 'map') {
    title = `MAP ${st.type.toUpperCase()}`;
    teamTxt = `TEAM ${st.team}：${esc(teamName(st.team))}`;
  } else if (st.kind === 'side') {
    title = 'SIDE SELECT';
    typeCls = 'side';
    teamTxt = `TEAM ${st.team}：${esc(teamName(st.team))}`;
  } else {
    title = TYPE_LABEL[st.type];
    teamTxt = `TEAM ${st.team}：${esc(teamName(st.team))}`;
  }
  const iconType = st.kind === 'side' ? 'side' : st.type;
  const sub =
    m.phase === 'map'
      ? `MAP DRAFT · STEP ${m.mapDraft.stepIndex + 1}/${m.mapDraft.steps.length}`
      : `${esc(S.methodMap[m.method].name)}${m.mode === 'map' ? ` · MAP ${m.gameIndex + 1}/${m.games.length} ${esc(mapName(curGame(m)?.mapId))}` : ''} · STEP ${curGame(m).stepIndex + 1}/${curGame(m).steps.length}`;
  return `
    <section class="phase team-${st.team || 'AB'} type-${typeCls} ${paused ? 'is-paused' : ''} ${mine ? 'is-mine' : ''} ${m.mode === 'map' && m.phase === 'agent' ? 'phase-compact' : ''}">
      ${m.phase === 'agent' ? mapBadge() : ''}
      <div class="phase-left">
        <div class="phase-sys">${sub}</div>
        <div class="phase-title"><span class="phase-ico">${icon(iconType)}</span><span>${teamTxt.split('：')[0]}</span><b>${title}</b></div>
      </div>
      <div class="phase-mid"><div class="tracker" id="tracker"></div></div>
      <div class="phase-turn">
        <div class="phase-team">${st.kind === 'sim' ? `${icon('hidden')} 相手の選択は公開まで見えません` : teamTxt.split('：')[1] || ''}</div>
        <div class="phase-actor">${mine ? '<b class="your-turn">YOUR TURN</b>' : actorText}</div>
      </div>
      <div class="phase-timer" id="timer">${paused ? '<span class="paused">PAUSED</span>' : m.deadline ? '' : '<span class="inf">∞</span>'}</div>
    </section>`;
}

function hostFooter() {
  const room = S.room;
  const m = room.match;
  const paused = room.status === 'paused';
  const gb = m.agentGlobalBans;
  return `
    ${gb.length ? `<div class="gbans"><span class="label">${icon('global')} GLOBAL BAN</span>${gb.map((id) => `<span class="mini mini-ban" title="${esc(agentName(id))}">${agentImg(S.agentMap[id], 'icon')}</span>`).join('')}</div>` : '<div></div>'}
    <div class="foot-tools">
      <span class="muted small">${m.timer ? m.timer + '秒/手' : '時間制限なし'}</span>
      ${isHost() ? `${paused ? '<button class="btn btn-light btn-sm" data-h="resume">再開</button>' : '<button class="btn btn-ghost btn-sm" data-h="pause">一時停止</button>'}<button class="btn btn-ghost btn-sm btn-danger-text" data-h="abort">ドラフト中止</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-h="leave">退出</button>
    </div>`;
}
function bindFooter() {
  $$('#draft-foot [data-h]').forEach(
    (b) =>
      (b.onclick = async () => {
        const h = b.dataset.h;
        if (h === 'leave') return leaveRoom();
        if (h === 'abort' && !(await confirmModal({ title: 'ドラフト中止', body: '進行中のドラフトを破棄してロビーに戻ります。', ok: '中止する', danger: true }))) return;
        act({ type: h });
      })
  );
}

// ------------------------------------------------------------------ MAP DRAFT
function renderMapDraft() {
  const room = S.room;
  const m = room.match;
  const md = m.mapDraft;
  const st = curStep();
  const mine = canActStep(room, S.me.pid, st);
  const actor = stepActor(room, st);
  if (S.view !== 'map') {
    mount('map', `<div id="series"></div><div id="phase"></div><section class="map-stage" id="map-stage"></section><div class="lock-bar" id="lock-bar"></div><section class="draft-foot" id="draft-foot"></section>`);
  }
  $('#series').innerHTML = seriesBar();
  $('#phase').innerHTML = phaseBanner(st, { mine, actorText: `${esc(pname(actor))} が選択中` });
  $('#tracker').innerHTML = md.steps
    .map((s, i) => {
      const a = md.actions[i];
      const title = `${i + 1}. TEAM ${s.team} ${s.type === 'side' ? '攻守選択' : 'MAP ' + s.type.toUpperCase()}${a?.mapId ? ' — ' + mapName(a.mapId) : ''}${a?.side ? ' ' + SIDE_JA[a.side] : ''}`;
      return chip({ type: s.type === 'side' ? 'side' : s.type, team: s.team }, { done: i < md.stepIndex, current: i === md.stepIndex, title });
    })
    .join('');
  centerTracker();
  const state = {};
  for (const a of md.actions) if (a.type !== 'side') state[a.mapId] = a;
  const preview = m.preview?.key === st.key ? m.preview.mapId : null;
  const picked = md.maps;
  $('#map-stage').innerHTML = `
    <div class="map-grid">${md.pool
      .map((id) => {
        const mp = S.mapMap[id];
        const a = state[id];
        const err = st.kind === 'map' ? mapError(m, id) : 'x';
        const order = picked.findIndex((x) => x.mapId === id);
        const cls = ['map-card', a ? `is-${a.type} by-${a.team}` : '', !a && st.kind === 'map' && mine && !err ? 'can-act' : '', S.selected === id ? 'is-selected' : '', preview === id ? 'is-preview' : ''].join(' ');
        const p = order >= 0 ? picked[order] : null;
        return `<button class="${cls}" data-map="${id}" ${a || !mine || st.kind !== 'map' ? 'aria-disabled="true"' : ''}>
          <span class="map-img">${mapImg(mp, 'list')}</span>
          <span class="map-name">${esc(mapName(id))}</span>
          ${a ? `<span class="map-badge">${icon(a.type)} TEAM ${a.team} ${a.type.toUpperCase()}</span>` : ''}
          ${p ? `<span class="map-order">MAP ${order + 1}${p.startSides ? ` · A:${SIDE_EN[p.startSides.A]} / B:${SIDE_EN[p.startSides.B]}` : ''}</span>` : ''}
        </button>`;
      })
      .join('')}</div>
    ${m.mapGlobalBans.length ? `<div class="map-gbans"><span class="label">${icon('global')} GLOBAL BAN</span>${m.mapGlobalBans.map((id) => `<span class="tag">${esc(mapName(id))}</span>`).join('')}</div>` : ''}`;
  $$('#map-stage .map-card').forEach(
    (b) =>
      (b.onclick = () => {
        if (st.kind !== 'map' || !mine) return;
        const id = b.dataset.map;
        const err = mapError(m, id);
        if (err) return toast(err, 'error', 1400);
        S.selected = id;
        act({ type: 'preview', id }, { quiet: true });
        renderMapDraft();
      })
  );
  // lock bar
  const lock = $('#lock-bar');
  if (st.kind === 'side') {
    const target = picked[picked.length - 1];
    lock.className = `lock-bar team-${st.team} type-side`;
    lock.innerHTML = mine
      ? `<div class="lock-info"><b>${esc(mapName(target.mapId))}</b><span>TEAM ${st.team} のスタートサイドを選択</span></div>
         <button class="btn-lock btn-side" data-side="atk">${SIDE_JA.atk}</button><button class="btn-lock btn-side alt" data-side="def">${SIDE_JA.def}</button>`
      : `<div class="lock-info"><span class="pulse"></span><span>TEAM ${st.team}(${esc(teamName(st.team))})が ${esc(mapName(target.mapId))} の攻守を選択中</span></div>`;
    $$('[data-side]', lock).forEach((b) => (b.onclick = () => act({ type: 'select', key: st.key, side: b.dataset.side })));
  } else if (mine) {
    lock.className = `lock-bar team-${st.team} type-${st.type}`;
    lock.innerHTML = `<div class="lock-info">${S.selected ? `<b>${esc(mapName(S.selected))}</b><span>MAP ${st.type.toUpperCase()}</span>` : '<span>マップを選んでください</span>'}</div>
      <button class="btn-lock" id="lock-btn" ${S.selected && room.status === 'drafting' ? '' : 'disabled'}>${icon(st.type)} MAP ${st.type.toUpperCase()}</button>`;
    $('#lock-btn').onclick = () => act({ type: 'select', key: st.key, mapId: S.selected });
  } else {
    lock.className = 'lock-bar waiting';
    lock.innerHTML = `<div class="lock-info"><span class="pulse"></span><span>${esc(pname(actor))}(TEAM ${st.team})のマップ${st.type === 'ban' ? 'Ban' : 'Pick'}を待っています</span></div>`;
  }
  $('#draft-foot').innerHTML = hostFooter();
  bindFooter();
  tickTimer();
}

// ------------------------------------------------------------------ BETWEEN MAPS
function renderBetween() {
  const m = S.room.match;
  const g = m.games[m.gameIndex];
  const next = m.games[m.gameIndex + 1];
  const nextMap = m.mapDraft?.maps[m.gameIndex + 1];
  mount(
    'between',
    `<div id="series">${seriesBar()}</div>
    <section class="between">
      <p class="eyebrow">// MAP ${m.gameIndex + 1} COMPLETE</p>
      <h2 class="h-display">${esc(mapName(g.mapId))}</h2>
      <div class="between-teams">${['A', 'B'].map((t) => `<div class="bt team-${t}"><span class="team-side">TEAM ${t}</span><b>${esc(teamName(t))}</b><div class="minis">${g.actions.filter((a) => a.type === 'pick' && a.team === t).map((a) => `<span class="mini">${agentImg(S.agentMap[a.agentId], 'icon')}</span>`).join('')}</div></div>`).join('')}</div>
      <div class="between-next">
        <span>NEXT</span><b>MAP ${m.gameIndex + 2} · ${esc(mapName(next.mapId))}</b>
        ${nextMap?.startSides ? `<span class="muted small">A:${SIDE_JA[nextMap.startSides.A]} / B:${SIDE_JA[nextMap.startSides.B]}</span>` : ''}
        <span class="muted small">TEAM ${next.firstTeam} 先攻</span>
        <span class="t-num" id="between-count"></span>
      </div>
      ${isHost() ? '<button class="btn btn-light btn-sm" data-next>すぐに次へ</button>' : ''}
    </section>
    <section class="draft-foot" id="draft-foot">${hostFooter()}</section>`
  );
  const nb = $('[data-next]');
  if (nb) nb.onclick = () => act({ type: 'nextGame' });
  bindFooter();
  tickTimer();
}

// ------------------------------------------------------------------ AGENT DRAFT
function mountAgentDraft() {
  mount(
    'agent',
    `<div class="map-bg" id="map-bg" aria-hidden="true"></div>
    <div id="series"></div>
    <div id="phase"></div>
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
  const roles = [{ id: 'all', en: 'ALL', ja: 'すべて' }, ...S.roles];
  $('#filters').innerHTML = `
    <div class="role-tabs" role="tablist">${roles
      .map((r) => `<button class="role-tab ${S.filter.role === r.id ? 'on' : ''}" data-role="${r.id}" title="${esc(r.ja)}">${r.id === 'all' ? '<span class="role-all">ALL</span>' : `${roleIcon(r.id)}<span class="role-label">${esc(r.en)}</span>`}</button>`)
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
  $('#agent-grid').innerHTML = S.agents
    .map(
      (a) => `<button class="tile" data-agent="${a.id}" data-role="${a.role}" style="--c1:${agentColors(a)?.[0] || '#2a3a48'}">
        <span class="tile-img">${agentImg(a, 'icon')}</span>
        <span class="tile-name">${esc(a.name)}</span>
        <span class="tile-badges"></span>
      </button>`
    )
    .join('');
  $('#agent-grid').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (t) onTileClick(t.dataset.agent);
  });
  $('#agent-grid').addEventListener('dblclick', (e) => {
    const t = e.target.closest('.tile');
    if (t && actingTeam()) lockIn(t.dataset.agent);
  });
  document.onkeydown = (e) => {
    if (S.view !== 'agent') return;
    if (e.key === 'Enter' && S.selected && actingTeam() && !e.target.closest('input')) lockIn(S.selected);
  };
}

// The team this client may currently act for (null if none).
function actingTeam() {
  const room = S.room;
  const st = curStep();
  if (!st || room.status !== 'drafting') return null;
  if (st.kind === 'seq') return canActStep(room, S.me.pid, st) ? st.team : null;
  if (st.kind === 'sim') {
    const t = myTeam();
    if (!t) return null;
    const side = curGame(room.match).pending?.[t];
    if (!side || side.done) return null;
    if (st.type === 'pick') return simSlotFor(t) != null ? t : null;
    return canActSim(room, S.me.pid, st, t) ? t : null;
  }
  return null;
}
// The pick slot this client is filling in a simultaneous pick.
function simSlotFor(team) {
  const room = S.room;
  const st = curStep();
  const side = curGame(room.match).pending?.[team];
  if (!side) return null;
  const ok = (i) => i != null && i >= 0 && !side.sel[i] && canActSim(room, S.me.pid, st, team, i);
  if (ok(S.simSlot)) return S.simSlot;
  const own = room.match.pickSlots[team].indexOf(S.me.pid);
  if (ok(own)) return own;
  for (let i = 0; i < side.sel.length; i++) if (ok(i)) return i;
  return null;
}

function onTileClick(id) {
  const st = curStep();
  S.selected = id;
  const team = actingTeam();
  if (team) {
    const err = tileError(id, team);
    if (err) toast(`${agentName(id)}: ${err}`, 'error', 1600);
    else if (st.kind === 'seq') act({ type: 'preview', id }, { quiet: true });
    else if (st.kind === 'sim') act({ type: 'simPreview', key: st.key, team, slot: st.type === 'pick' ? simSlotFor(team) : null, agentId: id }, { quiet: true });
  }
  updateAgentDraft();
}

function tileError(id, team) {
  const m = S.room.match;
  const g = curGame(m);
  const st = curStep();
  if (!st || !g) return 'x';
  if (st.kind === 'sim') {
    const own = (g.pending?.[team]?.sel || []).filter((x) => x && x.agentId).map((x) => x.agentId);
    return agentError(m, g, team, st.type, id, { ownPending: own });
  }
  return agentError(m, g, team, st.type, id);
}

let locking = false;
async function lockIn(id) {
  const st = curStep();
  const team = actingTeam();
  if (!st || !team || locking || !id) return;
  const err = tileError(id, team);
  if (err) return toast(err, 'error');
  locking = true;
  $('#lock-bar')?.classList.add('busy');
  if (st.kind === 'sim') {
    const slot = st.type === 'pick' ? simSlotFor(team) : null;
    await act({ type: 'select', key: st.key, team, slot, agentId: id });
    S.selected = null;
    S.simSlot = null;
  } else await act({ type: 'select', key: st.key, agentId: id });
  locking = false;
  $('#lock-bar')?.classList.remove('busy');
  if (S.view === 'agent') updateAgentDraft();
}

function applyFilter() {
  const { role, q, only } = S.filter;
  const st = curStep();
  const team = actingTeam() || (st?.kind === 'seq' ? (myTeam() || st.team) : myTeam());
  $$('#agent-grid .tile').forEach((t) => {
    const a = S.agentMap[t.dataset.agent];
    let show = (role === 'all' || a.role === role) && (!q || a.name.toLowerCase().includes(q) || (a.nameJa || '').toLowerCase().includes(q));
    if (show && only && team) show = !tileError(a.id, team);
    t.hidden = !show;
  });
}

function renderAgentDraft() {
  if (S.view !== 'agent') mountAgentDraft();
  updateAgentDraft();
}

function updateAgentDraft() {
  const room = S.room;
  const m = room.match;
  const g = curGame(m);
  const st = curStep();
  if (!st || !g) return;
  const states = agentStates(g);
  const team = actingTeam();
  const mine = !!team;
  const paused = room.status === 'paused';
  const actor = st.kind === 'seq' ? stepActor(room, st) : null;

  $('#series').innerHTML = seriesBar(true);
  const bg = $('#map-bg');
  const mpImg = g.mapId ? S.mapMap[g.mapId]?.images?.splash || S.mapMap[g.mapId]?.images?.list : null;
  if (bg && bg.dataset.map !== (g.mapId || '')) {
    bg.dataset.map = g.mapId || '';
    bg.style.backgroundImage = mpImg ? `url("${mpImg}")` : '';
    bg.classList.toggle('on', !!mpImg);
  }
  $('#app').classList.toggle('has-series', m.mode === 'map');
  let actorText = '';
  if (st.kind === 'seq') actorText = `${esc(pname(actor))} が選択中`;
  else {
    const p = g.pending;
    actorText = ['A', 'B'].map((t) => `TEAM ${t} ${p?.[t]?.done ? '確定' : `${p?.[t]?.sel.filter(Boolean).length || 0}/${st.count}`}`).join(' · ');
  }
  $('#phase').innerHTML = phaseBanner(st, { mine, actorText });

  // tracker
  $('#tracker').innerHTML = g.steps
    .map((s, i) => {
      const a = s.kind === 'seq' ? g.actions.find((x) => x.step === i) : null;
      const title = s.kind === 'sim' ? `${i + 1}. 両チーム同時 ${TYPE_LABEL[s.type]} ×${s.count}(非公開)` : `${i + 1}. TEAM ${s.team} ${TYPE_LABEL[s.type]}${a?.agentId ? ' — ' + agentName(a.agentId) : ''}`;
      return chip(s, { done: i < g.stepIndex, current: i === g.stepIndex, agent: a?.agentId ? S.agentMap[a.agentId] : null, title });
    })
    .join('');
  centerTracker();

  for (const t of ['A', 'B']) $(`#team-${t}`).innerHTML = teamPanel(t, st, g);
  $$('.slot[data-slot]').forEach(
    (el) =>
      (el.onclick = () => {
        const t = el.dataset.team;
        const i = Number(el.dataset.slot);
        if (st.kind === 'sim' && st.type === 'pick' && t === myTeam() && canActSim(room, S.me.pid, st, t, i) && !g.pending?.[t]?.sel[i]) {
          S.simSlot = i;
          updateAgentDraft();
        }
      })
  );

  // tiles
  const preview = m.preview && m.preview.key === st.key ? m.preview.agentId : null;
  const perspective = team || (st.kind === 'seq' ? st.team : myTeam());
  const fearless = S.methodMap[m.method].fearless;
  const ownPendingIds = st.kind === 'sim' && myTeam() ? (g.pending?.[myTeam()]?.sel || []).filter((x) => x?.agentId).map((x) => x.agentId) : [];
  $$('#agent-grid .tile').forEach((tile) => {
    const id = tile.dataset.agent;
    const s = states[id] || EMPTY;
    const err = perspective ? tileError(id, perspective) : 'x';
    const cls = ['tile'];
    const badges = [];
    if (m.agentGlobalBans.includes(id)) {
      cls.push('is-gban');
      badges.push(`<i class="b b-gban">${icon('global')}</i>`);
    }
    for (const t of s.ban) {
      cls.push('is-ban', `ban-${t}`);
      badges.push(`<i class="b b-ban team-${t}" title="TEAM ${t} BAN">${icon('ban')}</i>`);
    }
    for (const t of s.protect) {
      cls.push('is-protect', `prot-${t}`);
      badges.push(`<i class="b b-protect team-${t}" title="TEAM ${t} PROTECT">${icon('protect')}</i>`);
    }
    for (const t of s.pick) {
      cls.push('is-picked', `pick-${t}`);
      badges.push(`<i class="b b-pick team-${t}" title="TEAM ${t} PICK">${icon('pick')}</i>`);
    }
    if (ownPendingIds.includes(id)) {
      cls.push('is-pending');
      badges.push(`<i class="b b-pending" title="自チーム選択済み(未公開)">${icon(st.type)}</i>`);
    }
    if (fearless && perspective && m.fearlessUsed[perspective].includes(id)) {
      cls.push('is-used');
      badges.push('<i class="b b-used">USED</i>');
    }
    if (err) cls.push('unavail');
    if (id === S.selected) cls.push('is-selected');
    if (id === preview) cls.push('is-preview');
    if (mine && !paused) cls.push('can-act');
    tile.className = cls.join(' ');
    tile.querySelector('.tile-badges').innerHTML = badges.join('');
    tile.title = `${agentNameJa(id)}${err && err !== 'x' ? ` — ${err}` : ''}`;
  });
  applyFilter();

  renderSpotlight((mine ? S.selected : preview || S.selected) || null, { preview, st, actor });

  // lock bar
  const lock = $('#lock-bar');
  if (mine) {
    const sel = S.selected;
    const err = sel ? tileError(sel, team) : 'エージェントを選択';
    const slot = st.kind === 'sim' && st.type === 'pick' ? simSlotFor(team) : null;
    lock.className = `lock-bar type-${st.type} team-${team}`;
    const what = st.kind === 'sim' ? (st.type === 'pick' ? `枠${slot + 1}(${esc(pname(m.pickSlots[team][slot]))})` : `Ban ${(g.pending[team].sel.filter(Boolean).length || 0) + 1}/${st.count}`) : '';
    lock.innerHTML = `
      <div class="lock-info">${sel ? `<b>${esc(agentName(sel))}</b><span>${esc(err || `${TYPE_JA[st.type]}して確定`)}${what ? ` · ${what}` : ''}</span>` : `<span>エージェントを選んでください${what ? ` · ${what}` : ''}</span>`}</div>
      ${st.kind === 'sim' && st.type === 'ban' ? '<button class="btn btn-ghost btn-sm" id="finish-ban">残りはBanしない</button>' : ''}
      <button class="btn-lock" id="lock-btn" ${err || paused ? 'disabled' : ''}>${icon(st.type)} ${LOCK_LABEL[st.type]}</button>`;
    $('#lock-btn').onclick = () => lockIn(sel);
    const fb = $('#finish-ban');
    if (fb)
      fb.onclick = async () => {
        if (await confirmModal({ title: 'Banを終了', body: '残りのBan枠は使わずに確定します。', ok: '確定' })) act({ type: 'select', key: st.key, team, finish: true });
      };
  } else if (st.kind === 'sim' && myTeam() && g.pending?.[myTeam()]?.done) {
    lock.className = 'lock-bar waiting';
    lock.innerHTML = `<div class="lock-info"><span class="pulse"></span><span>自チームは確定済み。相手チームの確定を待っています(確定後に同時公開)</span></div>`;
  } else {
    lock.className = 'lock-bar waiting';
    lock.innerHTML = `<div class="lock-info"><span class="pulse"></span><span>${st.kind === 'sim' ? '両チームが同時に選択中です(内容は公開まで非表示)' : `${esc(pname(actor))}(TEAM ${st.team})の${TYPE_JA[st.type]}を待っています`}</span></div>`;
  }
  $('#draft-foot').innerHTML = hostFooter();
  bindFooter();
  tickTimer();
}

function teamPanel(t, st, g) {
  const room = S.room;
  const m = room.match;
  const picks = g.actions.filter((a) => a.type === 'pick' && a.team === t);
  const pend = st.kind === 'sim' && st.type === 'pick' ? g.pending?.[t] : null;
  const activeSlot = st.kind === 'sim' && st.type === 'pick' && t === myTeam() ? simSlotFor(t) : null;
  const mp = m.mapDraft?.maps[m.gameIndex];
  const slots = m.pickSlots[t].map((pid, slot) => {
    const a = picks.find((x) => x.slot === slot) || (st.kind !== 'sim' ? picks[slot] : null);
    const ag = a ? S.agentMap[a.agentId] : null;
    const pv = pend?.sel[slot];
    const pvAgent = pv?.agentId ? S.agentMap[pv.agentId] : null;
    const seqActive = st.kind === 'seq' && st.type === 'pick' && st.team === t && st.slot === slot;
    const previewId = seqActive && m.preview?.key === st.key ? m.preview.agentId : null;
    const ghost = previewId ? S.agentMap[previewId] : null;
    const p = room.players[pid];
    const active = seqActive || activeSlot === slot;
    const canClick = activeSlot != null && !pv;
    let label = '—';
    if (ag) label = esc(ag.name);
    else if (pvAgent) label = `<span class="ghost-name">${esc(pvAgent.name)}</span> <i class="locked">LOCKED</i>`;
    else if (pv?.hidden) label = `<span class="hidden-pick">${icon('hidden')} 選択済み</span>`;
    else if (ghost) label = `<span class="ghost-name">${esc(ghost.name)}</span>`;
    else if (active) label = 'SELECTING…';
    else if (pend) label = '<span class="muted">選択中…</span>';
    return `<li class="slot ${ag ? 'filled' : ''} ${pvAgent ? 'pending' : ''} ${active ? 'active' : ''} ${canClick ? 'clickable' : ''}" data-team="${t}" data-slot="${slot}" style="${ag || pvAgent ? `--c1:${agentColors(ag || pvAgent)?.[0] || '#33424f'}` : ''}">
      <span class="slot-art">${ag ? agentImg(ag, 'killfeed', 'slot-img') : pvAgent ? agentImg(pvAgent, 'killfeed', 'slot-img ghost') : ghost ? agentImg(ghost, 'killfeed', 'slot-img ghost') : ''}</span>
      <span class="slot-text">
        <span class="slot-agent">${label}</span>
        <span class="slot-player"><span class="dot ${p?.online ? 'on' : 'off'}"></span>${esc(pname(pid))}${pid === S.me.pid ? ' <i class="you">YOU</i>' : ''}${a?.auto ? ' <i class="auto">AUTO</i>' : ''}</span>
      </span>
      ${ag ? roleIcon(ag.role, 'slot-role') : ''}
    </li>`;
  });
  const listOf = (type) => {
    const n = g.steps.filter((s) => s.type === type).reduce((acc, s) => acc + (s.kind === 'sim' ? s.count : s.team === t ? 1 : 0), 0);
    if (!n) return '';
    const done = g.actions.filter((a) => a.type === type && a.team === t);
    const simHere = st.kind === 'sim' && st.type === type ? g.pending?.[t] : null;
    const items = [];
    for (let k = 0; k < n; k++) {
      const a = done[k];
      if (a) {
        items.push(`<span class="mini mini-${type}" title="${esc(agentName(a.agentId))}">${agentImg(S.agentMap[a.agentId], 'icon')}</span>`);
        continue;
      }
      const sel = simHere?.sel[k];
      if (sel?.agentId) items.push(`<span class="mini mini-${type} pending" title="${esc(agentName(sel.agentId))}(未公開)">${agentImg(S.agentMap[sel.agentId], 'icon')}</span>`);
      else if (sel?.hidden) items.push(`<span class="mini mini-hidden">${icon('hidden')}</span>`);
      else {
        const seqActive = st.kind === 'seq' && st.type === type && st.team === t && g.steps.filter((s) => s.type === type && s.team === t).findIndex((s) => s.i === st.i) === k;
        items.push(`<span class="mini mini-${type} ${seqActive || (simHere && !simHere.done && k === simHere.sel.filter(Boolean).length) ? 'active' : ''}"></span>`);
      }
    }
    return `<div class="side-list side-${type}"><span class="label">${icon(type)} ${TYPE_LABEL[type]}</span><div class="minis">${items.join('')}</div></div>`;
  };
  const isTurn = st.kind === 'sim' || st.team === t;
  const fearless = S.methodMap[m.method].fearless;
  const used = fearless ? m.fearlessUsed[t] : [];
  return `
    <div class="tp-head ${isTurn ? 'on-turn' : ''}">
      <span class="team-side">TEAM ${t}</span>
      <h3>${esc(teamName(t))}</h3>
      ${mp?.startSides ? `<span class="side-tag side-${mp.startSides[t]}">${SIDE_EN[mp.startSides[t]]}</span>` : ''}
    </div>
    <ol class="slots">${slots.join('')}</ol>
    ${listOf('protect')}${listOf('ban')}
    ${used.length ? `<div class="side-list side-used"><span class="label">FEARLESS USED ${used.length}</span><div class="minis">${used.map((id) => `<span class="mini mini-used" title="${esc(agentName(id))}">${agentImg(S.agentMap[id], 'icon')}</span>`).join('')}</div></div>` : ''}`;
}

function renderSpotlight(id, { preview, st, actor }) {
  const el = $('#spotlight');
  const a = id ? S.agentMap[id] : null;
  const team = actingTeam();
  if (!a) {
    el.dataset.sig = '';
    el.style.removeProperty('--g1');
    el.style.removeProperty('--g2');
    el.innerHTML = `<div class="spot-empty"><div class="spot-empty-title">${team ? 'SELECT AN AGENT' : 'WAITING'}</div><p>${team ? 'クリックで選択 → 確定ボタン(ダブルクリック / Enterでも確定)' : ''}</p></div>`;
    return;
  }
  const hoverTxt = !team && preview === id && actor ? pname(actor) : '';
  const sig = `${id}|${st.key}|${hoverTxt}|${!!team}`;
  if (el.dataset.sig === sig) return;
  const changed = el.dataset.id !== id;
  el.dataset.sig = sig;
  el.dataset.id = id;
  const role = roleOf(a.role);
  const cols = agentColors(a);
  if (cols) {
    el.style.setProperty('--g1', cols[0]);
    el.style.setProperty('--g2', cols[1]);
  }
  el.innerHTML = `
    ${a.images?.icon ? `<img class="spot-face" src="${esc(a.images.icon)}" alt="" />` : ''}
    ${a.images?.background ? `<img class="spot-bgtext" src="${esc(a.images.background)}" alt="" />` : ''}
    <div class="spot-portrait ${changed ? 'enter' : ''}">${agentImg(a, 'portrait', 'portrait-img')}</div>
    <div class="spot-info">
      <div class="spot-role">${roleIcon(a.role)}<span>${esc(role?.en || '')}</span><small>${esc(role?.ja || '')}</small></div>
      <div class="spot-name">${esc(a.name)}</div>
      <div class="spot-ja">${esc(a.nameJa && a.nameJa !== a.name ? a.nameJa : '')}</div>
      ${hoverTxt ? `<div class="spot-hover">${esc(hoverTxt)} が検討中</div>` : ''}
    </div>`;
}

function tickTimer() {
  const m = S.room?.match;
  if (!m || S.room.status !== 'drafting' || !m.deadline) return;
  const left = Math.max(0, m.deadline - (Date.now() + S.clockOffset));
  const sec = Math.ceil(left / 1000);
  const bc = $('#between-count');
  if (bc) bc.textContent = `${sec}`;
  const el = $('#timer');
  if (!el) return;
  const st = curStep();
  const total = st?.kind === 'sim' ? m.timer * st.count * 1000 : st?.kind === 'between' ? 8000 : m.timer * 1000;
  const pct = total ? Math.max(0, Math.min(1, left / total)) : 0;
  el.innerHTML = `<span class="t-num ${sec <= 5 ? 'warn' : ''}">${sec}</span><span class="t-bar"><i style="transform:scaleX(${pct})"></i></span>`;
}
setInterval(tickTimer, 200);

// ------------------------------------------------------------------ RESULT
// Results saved by the previous version (single draft) are converted for display.
function normalizeResult(r) {
  if (r.version === 2) return r;
  const team = (t) => ({ protects: r.teams[t].protects || [], bans: r.teams[t].bans || [], picks: r.teams[t].picks || [] });
  return {
    version: 1, id: r.id, mode: 'agent', series: null, method: null, legacyName: r.systemName,
    teamNames: { A: r.teams.A.name, B: r.teams.B.name }, rosters: { A: r.teams.A.players || [], B: r.teams.B.players || [] },
    agentGlobalBans: [...(r.teams.A.gbans || []), ...(r.teams.B.gbans || [])], mapGlobalBans: [], mapDraft: null,
    games: [{ index: 0, mapId: null, firstTeam: 'A', map: null, teams: { A: team('A'), B: team('B') }, log: r.log || [] }],
    fearlessUsed: { A: [], B: [] }, startedAt: r.startedAt, finishedAt: r.finishedAt,
  };
}

function resultText(r) {
  const lines = [`${SITE_TITLE} ドラフト結果 — ${r.method ? S.methodMap[r.method]?.name : r.legacyName || ''}${r.series ? ' / ' + r.series.toUpperCase() : ''}`];
  lines.push(`TEAM A: ${r.teamNames.A} / TEAM B: ${r.teamNames.B}`);
  if (r.agentGlobalBans.length) lines.push(`Agent Global Ban: ${r.agentGlobalBans.map(agentName).join(', ')}`);
  r.games.forEach((g, i) => {
    if (r.mode === 'map') lines.push(`\n■ MAP ${i + 1} ${mapName(g.mapId)}${g.map?.decider ? ' (Decider)' : ` (${g.map?.pickedBy} Pick)`}${g.map?.startSides ? ` A:${SIDE_EN[g.map.startSides.A]} B:${SIDE_EN[g.map.startSides.B]}` : ''}`);
    for (const t of ['A', 'B']) {
      const T = g.teams[t];
      const extra = [T.protects.length ? `Protect: ${T.protects.map(agentName).join(', ')}` : '', T.bans.length ? `Ban: ${T.bans.map(agentName).join(', ')}` : ''].filter(Boolean).join(' / ');
      lines.push(`[${r.teamNames[t]}] ${T.picks.map((p) => `${agentName(p.agentId)}${p.player ? `(${p.player})` : ''}`).join(', ')}${extra ? `\n   ${extra}` : ''}`);
    }
  });
  if (r.id) lines.push(`\n${location.origin}/r/${r.id}`);
  return lines.join('\n');
}

function sideOf(g, t) {
  return g.map?.startSides ? `<span class="side-tag side-${g.map.startSides[t]}">${SIDE_JA[g.map.startSides[t]]}</span>` : '';
}
const miniList = (type, ids) =>
  ids.length
    ? `<div class="side-list side-${type}"><span class="label">${icon(type)} ${TYPE_LABEL[type]}</span><div class="minis">${ids.map((id) => `<span class="mini mini-${type}" title="${esc(agentName(id))}">${agentImg(S.agentMap[id], 'icon')}</span>`).join('')}</div></div>`
    : '';

// One map: both teams side by side (Protect / Ban / Pick), sized to fit one screen.
function gameHtml(r, g) {
  const teamBlock = (t) => {
    const T = g.teams[t];
    return `<div class="res-team team-${t}">
      <div class="res-head"><span class="team-side">TEAM ${t}</span><h2>${esc(r.teamNames[t])}</h2>${sideOf(g, t)}</div>
      <div class="res-cards">${T.picks
        .map((p, i) => {
          const a = S.agentMap[p.agentId];
          const c = agentColors(a);
          return `<div class="res-card" style="--i:${i};--g1:${c?.[0] || '#26343f'};--g2:${c?.[1] || '#0f1923'}">
            <div class="res-art">${agentImg(a, 'portrait', 'res-img')}</div>
            <div class="res-meta"><div class="res-role">${a ? roleIcon(a.role) : ''}</div><div class="res-agent">${esc(agentName(p.agentId))}</div><div class="res-player">${esc(p.player ?? '—')}${p.auto ? ' <i class="auto">AUTO</i>' : ''}</div></div>
          </div>`;
        })
        .join('')}</div>
      <div class="res-extra">${miniList('protect', T.protects)}${miniList('ban', T.bans)}</div>
    </div>`;
  };
  const head =
    r.mode === 'map'
      ? `<div class="res-map-head" style="${S.mapMap[g.mapId]?.images?.list ? `--map:url('${esc(S.mapMap[g.mapId].images.list)}')` : ''}"><span class="eyebrow">MAP ${g.index + 1}</span><h3>${esc(mapName(g.mapId))}</h3><span class="muted small">${g.map?.decider ? 'DECIDER(攻守ランダム)' : `TEAM ${g.map?.pickedBy} Pick / 攻守: TEAM ${g.map?.sideChooser} が選択`} · TEAM ${g.firstTeam} 先攻</span></div>`
      : '';
  return `${head}<section class="res-body res-split">${teamBlock('A')}${teamBlock('B')}</section>`;
}

function resultHtml(r, { inRoom }) {
  const date = new Date(r.finishedAt || Date.now());
  const methodName = r.method ? S.methodMap[r.method]?.name : r.legacyName || '';
  const fearless = r.method && S.methodMap[r.method]?.fearless;
  const md = r.mapDraft;
  return `
    <section class="res-top">
      <div class="res-title"><h1>DRAFT <span class="accent">COMPLETE</span></h1></div>
      <div class="res-actions">
        <button class="btn btn-red btn-sm" data-r="shot">${icon('copy')}結果をスクショ保存</button>
        <button class="btn btn-ghost btn-sm" data-r="text">テキストでコピー</button>
        ${inRoom ? '<button class="btn btn-ghost btn-sm" data-r="lobby">ロビーに戻る</button><button class="btn btn-ghost btn-sm" data-r="leave">退出</button>' : '<a class="btn btn-ghost btn-sm" href="/" data-link>新しくルームを作る</a>'}
      </div>
    </section>
    <div id="res-capture" class="res-capture">
      <header class="rc-head">
        <div class="rc-teams"><span class="team-side rc-A">TEAM A</span><b>${esc(r.teamNames.A)}</b><span class="rc-vs">VS</span><b>${esc(r.teamNames.B)}</b><span class="team-side rc-B">TEAM B</span></div>
        <div class="rc-meta">${esc(methodName)}${r.series ? ' · ' + r.series.toUpperCase() : ''}${r.counts?.order && S.methodMap[r.method]?.usesOrder ? ' · ' + r.counts.order.toUpperCase() : ''} · ${date.toLocaleString('ja-JP')}</div>
      </header>
      ${
        r.agentGlobalBans.length || r.mapGlobalBans.length || md
          ? `<div class="rc-strip">
        ${r.agentGlobalBans.length ? `<span class="rc-label">${icon('global')} AGENT GLOBAL BAN</span>${r.agentGlobalBans.map((id) => `<span class="mini mini-ban" title="${esc(agentName(id))}">${agentImg(S.agentMap[id], 'icon')}</span>`).join('')}` : ''}
        ${md ? `<span class="rc-label">${icon('map')} MAP DRAFT</span>${md.log.filter((a) => a.type !== 'side').map((a) => `<span class="ov-md ${a.type} team-${a.team}">${icon(a.type)}${a.team} ${esc(mapName(a.mapId))}</span>`).join('')}<span class="ov-md decider">DECIDER ${esc(mapName(md.maps.at(-1).mapId))}</span>` : ''}
        ${r.mapGlobalBans.length ? `<span class="rc-label">${icon('global')} MAP GLOBAL BAN</span>${r.mapGlobalBans.map((id) => `<span class="tag rc-gbmap">${esc(mapName(id))}</span>`).join('')}` : ''}
      </div>`
          : ''
      }
      ${r.games.map((g) => `<div class="rc-game">${gameHtml(r, g)}</div>`).join('')}
      ${fearless ? fearlessHtml(r) : ''}
      <p class="rc-foot">V Dra · ${location.host}</p>
    </div>`;
}

function fearlessHtml(r) {
  const rows = ['A', 'B']
    .map(
      (t) => `<div class="fl-row team-${t}"><span class="team-side">TEAM ${t}</span>${r.games
        .map((g, i) => `<div class="fl-map"><span class="muted small">MAP ${i + 1}</span><div class="minis">${g.teams[t].picks.map((p) => `<span class="mini" title="${esc(agentName(p.agentId))}">${agentImg(S.agentMap[p.agentId], 'icon')}</span>`).join('')}</div></div>`)
        .join('')}</div>`
    )
    .join('');
  return `<section class="fearless-hist"><h4>FEARLESS 使用済みエージェント履歴</h4>${rows}</section>`;
}

// ---- full-length screenshot of the results (not only the visible part)
async function toDataUrl(url) {
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'force-cache' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
async function inlineFontsCss() {
  // Latin display fonts only (Japanese falls back to the system font in the image)
  try {
    const cssUrl = 'https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@600;700&display=swap';
    let css = await (await fetch(cssUrl)).text();
    const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((x) => x[1]))];
    for (const u of urls) {
      const d = await toDataUrl(u);
      if (d) css = css.split(u).join(d);
    }
    return css;
  } catch {
    return '';
  }
}
async function captureResult() {
  const src = $('#res-capture');
  if (!src || S.capturing) return;
  S.capturing = true;
  toast('画像を作成しています…', 'info', 1800);
  try {
    const w = Math.ceil(src.scrollWidth);
    const h = Math.ceil(src.scrollHeight);
    const clone = src.cloneNode(true);
    await Promise.all(
      [...clone.querySelectorAll('img')].map(async (img) => {
        const d = await toDataUrl(img.getAttribute('src'));
        img.removeAttribute('onerror');
        img.removeAttribute('loading');
        if (d) img.setAttribute('src', d);
        else img.replaceWith(Object.assign(document.createElement('span'), { className: 'ag-fallback ' + img.className, textContent: initials(img.alt) }));
      })
    );
    await Promise.all(
      [...clone.querySelectorAll('[style*="url("]')].map(async (el) => {
        const st = el.getAttribute('style');
        const mm = st.match(/url\(['"]?([^'")]+)['"]?\)/);
        if (!mm) return;
        const d = await toDataUrl(mm[1]);
        el.setAttribute('style', d ? st.replace(mm[1], d) : st.replace(/url\([^)]*\)/g, 'none'));
      })
    );
    let css = await (await fetch('/style.css')).text();
    css = css.replace(/:root\s*\{/, ':root, .capture-root {');
    css += await inlineFontsCss();
    css += '*{animation:none!important;transition:none!important}.res-card,.res-cards>*{opacity:1!important;transform:none!important}';
    const xmlCss = css.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const body = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="capture-root" style="width:${w}px;height:${h}px;background:#0f1923;color:#ece8e1;font-family:'Noto Sans JP',system-ui,sans-serif;font-size:15px;line-height:1.55"><style>${xmlCss}</style>${body}</div></foreignObject></svg>`;
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#0f1923';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('blob');
    const name = `vdra-result-${S.room?.resultId || Date.now()}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      await navigator.share({ files: [file], title: 'V Dra ドラフト結果' }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    toast('スクショを保存しました', 'ok');
  } catch (e) {
    console.warn('capture failed', e);
    toast('このブラウザでは画像を作成できませんでした。ブラウザのスクリーンショット機能をご利用ください', 'error', 4000);
  } finally {
    S.capturing = false;
  }
}

function bindResult(r) {
  const app = $('#app');
  const on = (k, fn) => {
    const b = app.querySelector(`[data-r="${k}"]`);
    if (b) b.onclick = fn;
  };
  on('shot', captureResult);
  on('text', () => copyText(resultText(r), '結果をテキストでコピーしました'));
  on('lobby', () => {
    // only this viewer goes back; nobody else is moved
    S.localLobby = true;
    render();
  });
  on('leave', leaveRoom);
}

let roomResultCache = null;
async function renderRoomResult() {
  const id = S.room.resultId;
  const key = `result:${id}:${S.room.hostId}`;
  if (S.view === 'result' && $('#app').dataset.key === key) return;
  if (S.view !== 'result') S.resultTab = 0;
  let r = roomResultCache?.id === id ? roomResultCache : null;
  if (!r) {
    try {
      r = normalizeResult(await api(`/api/results/${id}`));
      roomResultCache = r;
    } catch {
      return mount('error', errorView('結果を読み込めません', '通信状態を確認してください。'));
    }
  }
  if (S.room?.resultId !== id) return;
  mount('result', resultHtml(r, { inRoom: true }));
  $('#app').dataset.key = key;
  bindResult(r);
}

async function renderShared(id) {
  renderTopbar();
  mount('loading', `<div class="center-msg"><div class="spinner"></div></div>`);
  try {
    const r = normalizeResult(await api(`/api/results/${id}`));
    S.resultTab = 0;
    mount('result', resultHtml(r, { inRoom: false }));
    bindResult(r);
  } catch {
    mount('error', errorView('結果が見つかりません', 'URLが正しいか確認してください。'));
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  document.title = SITE_TITLE;
  try {
    const [ag, mp, me] = await Promise.all([api('/api/agents'), api('/api/maps'), api('/api/methods')]);
    S.agents = ag.agents;
    S.agentMap = Object.fromEntries(ag.agents.map((a) => [a.id, a]));
    S.roles = ag.roles;
    S.roleIcons = ag.roleIcons || {};
    S.maps = mp.maps;
    S.mapMap = Object.fromEntries(mp.maps.map((m) => [m.id, m]));
    S.pool = mp.pool;
    S.methods = me.methods;
    S.methodMap = Object.fromEntries(me.methods.map((m) => [m.id, m]));
    S.countSettings = me.countSettings;
    S.series = me.series;
    S.defaultTeamNames = me.defaultTeamNames;
    S.maxAgentGlobalBans = me.maxAgentGlobalBans;
  } catch {
    mount('error', errorView('サーバーに接続できません', 'サーバーが起動しているか確認してください。'));
    return;
  }
  onRoute();
}
boot();
