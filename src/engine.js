// Pure room / match state machine (no I/O). The server calls these functions,
// then persists and broadcasts. Every meaningful mutation bumps room.version.
//
// A "match" = optional map draft + one or more agent drafts ("games").
//   Agent Draft Only        -> 1 game, no map
//   Map Draft + Agent Draft -> map draft (Bo3 / Bo5), then one agent draft per map
// Agent draft rules come from METHODS (src/methods.js) - no per-method code paths.

import { METHOD_MAP, COUNT_SETTINGS, MAX_AGENT_GLOBAL_BANS, PICKS_PER_TEAM, buildAgentSteps, agentsRequired } from './methods.js';
import { SERIES_POOL } from './maps.js';

export const MAX_PLAYERS = 20;
export const TEAM_SIZE = 5;
export const TIMER_OPTIONS = [0, 15, 20, 30, 45, 60, 90];
export const NAME_MAX = 16;
export const BETWEEN_MS = 8000; // pause between maps of a series before the next agent draft starts
export const DEFAULT_TEAM_NAMES = { A: 'VORTEX', B: 'OBSIDIAN' };
export const SERIES = {
  bo3: { games: 3, ops: { A: { ban: 2, pick: 1 }, B: { ban: 2, pick: 1 } } },
  bo5: { games: 5, ops: { A: { ban: 1, pick: 2 }, B: { ban: 1, pick: 2 } } },
};

export class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, msg) => {
  throw new ActionError(code, msg);
};
const other = (t) => (t === 'A' ? 'B' : 'A');
const TEAMS = ['A', 'B'];

export function cleanName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, NAME_MAX);
}

export function defaultSettings() {
  return {
    mode: 'agent', // agent | map
    series: 'bo3', // bo3 | bo5 (map mode)
    method: 'normal',
    order: 'standard', // standard | snake
    banCount: COUNT_SETTINGS.banCount.def,
    protectCount: COUNT_SETTINGS.protectCount.def,
    blindBanCount: COUNT_SETTINGS.blindBanCount.def,
    blindEnemyBanCount: COUNT_SETTINGS.blindEnemyBanCount.def,
    timer: 30,
    hostOverride: true,
    teamNames: { A: '', B: '' }, // empty = not entered; VORTEX / OBSIDIAN are applied at start
    agentGlobalBans: [],
    mapGlobalBans: [],
  };
}

export function createRoom({ id, hostId, hostName, now }) {
  const room = {
    schema: 2,
    id,
    createdAt: now,
    updatedAt: now,
    version: 1,
    hostId,
    status: 'lobby', // lobby | drafting | paused | finished
    settings: defaultSettings(),
    players: {},
    order: { A: [], B: [] }, // index 0 = captain
    match: null,
    resultId: null,
    history: [],
  };
  addPlayer(room, { id: hostId, name: hostName, now });
  return room;
}

// Upgrade a room saved by the previous version (schema 1: single `draft`, old system ids).
export function migrateRoom(room) {
  if (room.schema === 2) return room;
  const old = room.settings || {};
  const s = defaultSettings();
  s.timer = TIMER_OPTIONS.includes(old.timer) ? old.timer : 30;
  s.hostOverride = old.hostOverride !== false;
  for (const t of TEAMS) {
    const n = old.teamNames?.[t];
    s.teamNames[t] = n && n !== 'ATTACKERS' && n !== 'DEFENDERS' ? n : '';
  }
  if (old.systemId === 'snake' || old.systemId === 'ban_snake' || old.systemId === 'protect') s.order = 'snake';
  if (old.systemId === 'ban_standard' || old.systemId === 'ban_snake') s.method = 'ban';
  if (old.systemId === 'protect') s.method = 'protect_ban';
  room.settings = s;
  delete room.draft;
  room.match = null;
  room.status = 'lobby';
  room.schema = 2;
  return room;
}

export function addPlayer(room, { id, name, now }) {
  if (Object.keys(room.players).length >= MAX_PLAYERS) fail('ROOM_FULL', 'ルームが満員です');
  const n = cleanName(name);
  if (!n) fail('BAD_NAME', '名前を入力してください');
  room.players[id] = { id, name: uniqueName(room, n, id), team: null, joinedAt: now, online: false };
  touch(room, now);
  return room.players[id];
}

function uniqueName(room, name, selfId) {
  const taken = new Set(Object.values(room.players).filter((p) => p.id !== selfId).map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const c = `${name.slice(0, NAME_MAX - 3)}(${i})`;
    if (!taken.has(c)) return c;
  }
  return name;
}

export function touch(room, now) {
  room.version++;
  room.updatedAt = now;
}

function setPlayerTeam(room, pid, team) {
  const p = room.players[pid];
  if (!p) fail('NO_PLAYER', 'プレイヤーが見つかりません');
  if (team !== null && team !== 'A' && team !== 'B') fail('BAD_TEAM', '不正なチームです');
  if (p.team === team) return;
  if (team && room.order[team].length >= TEAM_SIZE) fail('TEAM_FULL', 'チームは5人までです');
  if (p.team) room.order[p.team] = room.order[p.team].filter((x) => x !== pid);
  p.team = team;
  if (team) room.order[team].push(pid);
}

const isHost = (room, pid) => room.hostId === pid;
const requireHost = (room, pid) => {
  if (!isHost(room, pid)) fail('NOT_HOST', 'ホストのみ操作できます');
};
const inLobby = (room) => room.status === 'lobby' || room.status === 'finished';
const requireLobby = (room) => {
  if (!inLobby(room)) fail('NOT_LOBBY', 'ドラフト中は変更できません');
};
const byJoin = (a, b) => a.joinedAt - b.joinedAt;

// Pick the next host: earliest joined online player, else earliest joined player.
export function chooseNextHost(room, exclude = null) {
  const ps = Object.values(room.players).filter((p) => p.id !== exclude).sort(byJoin);
  return (ps.find((p) => p.online) || ps[0])?.id ?? null;
}

// Called by the server when the host goes offline: host moves immediately to an online player.
export function transferHostIfOffline(room, now) {
  const h = room.players[room.hostId];
  if (h && h.online) return false;
  const next = Object.values(room.players).filter((p) => p.online && p.id !== room.hostId).sort(byJoin)[0];
  if (!next) return false;
  room.hostId = next.id;
  touch(room, now);
  return true;
}

// Remove a player. Keeps the match consistent: their pick slots go to remaining teammates.
function removePlayer(room, pid) {
  const p = room.players[pid];
  if (!p) return;
  if (p.team) room.order[p.team] = room.order[p.team].filter((x) => x !== pid);
  delete room.players[pid];
  const m = room.match;
  if (m) {
    for (const t of TEAMS) {
      if (!m.roster[t].includes(pid)) continue;
      m.roster[t] = m.roster[t].filter((x) => x !== pid);
      const members = m.roster[t];
      let k = 0;
      m.pickSlots[t] = m.pickSlots[t].map((owner) => (owner === pid ? (members.length ? members[k++ % members.length] : null) : owner));
      if (m.captains[t] === pid) m.captains[t] = members[0] ?? null;
    }
  }
  if (room.hostId === pid) room.hostId = chooseNextHost(room);
}

// ---------------------------------------------------------------- match helpers

const methodOf = (m) => METHOD_MAP[m.method];
export const curGame = (m) => (m && m.phase === 'agent' ? m.games[m.gameIndex] : null);

// The current step, normalized:
// { key, phase:'map'|'agent'|'between', kind:'seq'|'sim'|'map'|'side'|'between', type, team, slot, count, hidden }
export function currentStep(room) {
  const m = room.match;
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

// Status of every agent in a game, from REVEALED actions only.
export function agentStates(game) {
  const st = {};
  const get = (id) => (st[id] ||= { ban: [], protect: [], pick: [] });
  for (const a of game.actions) if (a.agentId) get(a.agentId)[a.type].push(a.team);
  return st;
}

const EMPTY = { ban: [], protect: [], pick: [] };

// Returns null if `team` may select `agentId` for `type`, else a reason (Japanese).
// `ownPending` = the team's own unrevealed selections in a simultaneous step.
export function agentError(m, game, team, type, agentId, { states = agentStates(game), ownPending = [] } = {}) {
  const rules = methodOf(m).rules;
  const s = states[agentId] || EMPTY;
  const opp = other(team);
  if (m.agentGlobalBans.includes(agentId)) return 'Global Ban中です';
  if (type === 'protect') {
    if (s.protect.includes(team)) return '既にProtect済みです';
    if (s.protect.includes(opp)) return '相手チームがProtect済みです';
    if (s.ban.length) return 'Ban済みです';
    return null;
  }
  if (type === 'ban') {
    if (ownPending.includes(agentId) || s.ban.includes(team)) return '既にBan済みです';
    if (rules.banCross === 'unique' && s.ban.includes(opp)) return '相手チームがBan済みです';
    if (s.protect.includes(opp)) return '相手チームがProtectしています';
    if (s.protect.includes(team)) return '自チームがProtectしています';
    if (s.pick.length) return 'Pick済みです';
    return null;
  }
  if (type === 'pick') {
    for (const bt of s.ban) {
      if (rules.banTarget === 'both') return 'Ban済みです';
      if (bt !== team) return '相手チームにBanされています';
    }
    if (ownPending.includes(agentId) || s.pick.includes(team)) return '自チームでPick済みです';
    if (rules.pickCross === 'unique' && s.pick.includes(opp)) return '相手チームがPick済みです';
    if (rules.protectEffect === 'noEnemyBanPick' && s.protect.includes(opp)) return '相手チームがProtectしています';
    if (methodOf(m).fearless && m.fearlessUsed[team].includes(agentId)) return '前のマップで使用済みです(Fearless)';
    return null;
  }
  return '不正な操作です';
}

export function validAgentsFor(m, game, team, type, agentIds, ownPending = []) {
  const states = agentStates(game);
  return agentIds.filter((id) => !agentError(m, game, team, type, id, { states, ownPending }));
}

// ---------------------------------------------------------------- who may act

function away(room, pid, team) {
  const p = pid && room.players[pid];
  return !p || !p.online || p.team !== team;
}

// Fallbacks so a disconnected player never blocks the draft:
// assigned player -> captain -> any teammate (when the captain is also away).
function teamFallback(room, pid, team, actor) {
  const m = room.match;
  if (actor && actor === pid) return true;
  if (!away(room, actor, team)) return false;
  const me = room.players[pid];
  if (!me || me.team !== team) return false;
  const cap = m.captains[team];
  return pid === cap || away(room, cap, team);
}

// For a sequential / map / side step.
export function stepActor(room, step) {
  const m = room.match;
  if (step.kind === 'seq' && step.type === 'pick') return m.pickSlots[step.team][step.slot] ?? null;
  return m.captains[step.team] ?? null;
}

export function canActStep(room, pid, step) {
  if (!step || step.kind === 'between' || step.kind === 'sim') return false;
  if (room.settings.hostOverride && isHost(room, pid)) return true;
  return teamFallback(room, pid, step.team, stepActor(room, step));
}

// For a simultaneous step: may `pid` fill `slot` (picks) / a ban for `team`?
// The host override never crosses into the other team's hidden selection.
export function canActSim(room, pid, step, team, slot = null) {
  const m = room.match;
  const me = room.players[pid];
  if (!me) return false;
  if (step.hidden && me.team !== team) return false;
  if (room.settings.hostOverride && isHost(room, pid) && me.team === team) return true;
  if (me.team !== team) return false;
  if (pid === m.captains[team]) return true; // captain may fill any slot of the team
  if (step.type === 'pick') return teamFallback(room, pid, team, m.pickSlots[team][slot]);
  return teamFallback(room, pid, team, m.captains[team]);
}

// ---------------------------------------------------------------- settings

export function globalBanCap(settings, agentCount) {
  const method = METHOD_MAP[settings.method];
  const games = settings.mode === 'map' ? SERIES[settings.series].games : 1;
  return Math.max(0, Math.min(MAX_AGENT_GLOBAL_BANS, agentCount - agentsRequired(method, settings, games)));
}

function updateSettings(room, a, ctx) {
  const s = room.settings;
  if (a.mode !== undefined) {
    if (!['agent', 'map'].includes(a.mode)) fail('BAD_MODE', '不正なドラフトモードです');
    s.mode = a.mode;
    if (s.mode === 'agent' && METHOD_MAP[s.method].seriesOnly) s.method = 'normal';
  }
  if (a.series !== undefined) {
    if (!SERIES[a.series]) fail('BAD_SERIES', 'Bo3 / Bo5 を選択してください');
    s.series = a.series;
  }
  if (a.method !== undefined) {
    const m = METHOD_MAP[a.method];
    if (!m) fail('BAD_METHOD', '不正なドラフト方式です');
    if (m.seriesOnly && s.mode !== 'map') fail('SERIES_ONLY', `${m.name} は Map Draft + Agent Draft (Bo3/Bo5) 専用です`);
    s.method = a.method;
  }
  if (a.order !== undefined) {
    if (!['standard', 'snake'].includes(a.order)) fail('BAD_ORDER', '不正なドラフト順序です');
    s.order = a.order;
  }
  for (const k of Object.keys(COUNT_SETTINGS)) {
    if (a[k] === undefined) continue;
    const v = Number(a[k]);
    const r = COUNT_SETTINGS[k];
    if (!Number.isInteger(v) || v < r.min || v > r.max) fail('BAD_COUNT', `${r.label}は${r.min}〜${r.max}です`);
    s[k] = v;
  }
  if (a.timer !== undefined) {
    if (!TIMER_OPTIONS.includes(Number(a.timer))) fail('BAD_TIMER', '不正なタイマー設定です');
    s.timer = Number(a.timer);
  }
  if (a.hostOverride !== undefined) s.hostOverride = !!a.hostOverride;
  if (a.agentGlobalBans !== undefined) {
    if (!Array.isArray(a.agentGlobalBans)) fail('BAD_BANS', '不正な値です');
    const list = [...new Set(a.agentGlobalBans)];
    if (list.some((id) => !ctx.agentIds.includes(id))) fail('BAD_AGENT', '不明なエージェントです');
    const cap = globalBanCap(s, ctx.agentIds.length);
    if (list.length > cap) fail('BAN_LIMIT', `この設定ではエージェントのGlobal Banは最大${cap}体です`);
    s.agentGlobalBans = list;
  }
  if (a.mapGlobalBans !== undefined) {
    if (!Array.isArray(a.mapGlobalBans)) fail('BAD_BANS', '不正な値です');
    const list = [...new Set(a.mapGlobalBans)];
    const mapIds = ctx.mapIds || [];
    if (list.some((id) => !mapIds.includes(id))) fail('BAD_MAP', '不明なマップです');
    const cap = Math.max(0, mapIds.length - SERIES_POOL);
    if (list.length > cap) fail('BAN_LIMIT', `マップのGlobal Banは最大${cap}個です(残り${SERIES_POOL}マップ)`);
    s.mapGlobalBans = list;
  }
  // Other settings may have lowered the agent Global Ban cap: trim from the end.
  const cap = globalBanCap(s, ctx.agentIds.length);
  if (s.agentGlobalBans.length > cap) s.agentGlobalBans = s.agentGlobalBans.slice(0, cap);
}

// ---------------------------------------------------------------- start

function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Fixed map ban/pick order ({} = Ban, [] = Pick, D = Decider):
//   Bo3: {A}{B}[A][B]{A}{B}[D]      Bo5: {A}{B}[A][B][A][B][D]
// Right after each pick, the team that did NOT pick chooses the starting side of that map.
export const MAP_ORDER = {
  bo3: [['ban', 'A'], ['ban', 'B'], ['pick', 'A'], ['pick', 'B'], ['ban', 'A'], ['ban', 'B']],
  bo5: [['ban', 'A'], ['ban', 'B'], ['pick', 'A'], ['pick', 'B'], ['pick', 'A'], ['pick', 'B']],
};
export function buildMapSteps(series) {
  const steps = [];
  for (const [type, team] of MAP_ORDER[series]) {
    steps.push({ i: steps.length, type, team });
    if (type === 'pick') steps.push({ i: steps.length, type: 'side', team: other(team) });
  }
  return steps;
}

function newGame(m, index, mapId) {
  const method = methodOf(m);
  const firstTeam = index % 2 === 0 ? 'A' : 'B'; // first mover alternates map by map
  return {
    index,
    mapId,
    firstTeam,
    steps: buildAgentSteps(method, m.counts, firstTeam),
    stepIndex: 0,
    actions: [],
    pending: null,
    startedAt: null,
    finishedAt: null,
  };
}

function startMatch(room, ctx) {
  const { now } = ctx;
  const s = room.settings;
  const method = METHOD_MAP[s.method];
  if (!room.order.A.length || !room.order.B.length) fail('TEAM_EMPTY', '両チームに1人以上必要です');
  if (method.seriesOnly && s.mode !== 'map') fail('SERIES_ONLY', `${method.name} は Bo3/Bo5 専用です`);
  const cap = globalBanCap(s, ctx.agentIds.length);
  if (s.agentGlobalBans.length > cap) fail('BAN_LIMIT', `エージェントのGlobal Banは最大${cap}体です`);
  let pool = null;
  if (s.mode === 'map') {
    pool = (ctx.mapIds || []).filter((id) => !s.mapGlobalBans.includes(id));
    if (pool.length !== SERIES_POOL) {
      if (pool.length < SERIES_POOL) fail('MAP_POOL', `マップが${SERIES_POOL}つ未満のため開始できません`);
      fail('MAP_POOL', `マップのGlobal Banをあと${pool.length - SERIES_POOL}個選んでください(残り${SERIES_POOL}マップにする)`);
    }
  }
  const teamNames = {};
  const teamNameDefault = {};
  for (const t of TEAMS) {
    teamNameDefault[t] = !s.teamNames[t];
    teamNames[t] = s.teamNames[t] || DEFAULT_TEAM_NAMES[t];
  }
  const pickSlots = {};
  for (const t of TEAMS) {
    const members = room.order[t];
    pickSlots[t] = Array.from({ length: TEAM_SIZE }, (_, i) => members[i % members.length]);
  }
  const counts = { order: s.order };
  for (const k of Object.keys(COUNT_SETTINGS)) counts[k] = s[k];
  const m = {
    mode: s.mode,
    series: s.mode === 'map' ? s.series : null,
    method: s.method,
    counts,
    timer: s.timer,
    teamNames,
    teamNameDefault,
    roster: { A: [...room.order.A], B: [...room.order.B] },
    names: Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.name])),
    captains: { A: room.order.A[0], B: room.order.B[0] },
    pickSlots,
    agentGlobalBans: [...s.agentGlobalBans],
    mapGlobalBans: s.mode === 'map' ? [...s.mapGlobalBans] : [],
    phase: s.mode === 'map' ? 'map' : 'agent',
    mapDraft: null,
    games: [],
    gameIndex: 0,
    fearlessUsed: { A: [], B: [] }, // per-team, whole series
    deadline: null,
    pausedRemaining: null,
    preview: null,
    startedAt: now,
    finishedAt: null,
  };
  if (s.mode === 'map') {
    m.mapDraft = { pool, steps: buildMapSteps(s.series), stepIndex: 0, actions: [], maps: [] };
  } else {
    m.games = [newGame(m, 0, null)];
    m.games[0].startedAt = now;
  }
  room.match = m;
  room.status = 'drafting';
  room.resultId = null;
  enterStep(room, now);
}

// ---------------------------------------------------------------- progression

function stepSeconds(room) {
  const m = room.match;
  const st = currentStep(room);
  if (!st) return null;
  if (st.kind === 'between') return BETWEEN_MS / 1000;
  if (!m.timer) return null;
  if (st.kind === 'sim') return m.timer * st.count;
  return m.timer;
}

// Called whenever the step changes: arm the deadline, prepare simultaneous state.
function enterStep(room, now) {
  const m = room.match;
  m.preview = null;
  const st = currentStep(room);
  if (st && st.kind === 'sim') {
    const g = curGame(m);
    if (!g.pending || g.pending.step !== st.i) {
      g.pending = { step: st.i, type: st.type, count: st.count, A: newSide(st.count), B: newSide(st.count) };
    }
  }
  const sec = stepSeconds(room);
  m.deadline = sec ? now + sec * 1000 : null;
}
const newSide = (count) => ({ sel: Array(count).fill(null), done: false, doneAt: null });

function finishGame(room, now) {
  const m = room.match;
  const g = curGame(m);
  g.finishedAt = now;
  g.pending = null;
  for (const a of g.actions) if (a.type === 'pick' && a.agentId && !m.fearlessUsed[a.team].includes(a.agentId)) m.fearlessUsed[a.team].push(a.agentId);
  if (m.gameIndex < m.games.length - 1) {
    m.phase = 'between';
  } else {
    m.phase = 'done';
    m.finishedAt = now;
    m.deadline = null;
    room.status = 'finished';
  }
}

function advanceGame(room, now) {
  const m = room.match;
  m.gameIndex++;
  m.phase = 'agent';
  curGame(m).startedAt = now;
}

function afterAgentStep(room, now) {
  const m = room.match;
  const g = curGame(m);
  g.stepIndex++;
  if (g.stepIndex >= g.steps.length) finishGame(room, now);
  if (room.status !== 'finished') enterStep(room, now);
  touch(room, now);
}

function commitAgentSeq(room, agentId, { by, auto, now }) {
  const m = room.match;
  const g = curGame(m);
  const st = currentStep(room);
  const err = agentError(m, g, st.team, st.type, agentId);
  if (err) fail('INVALID_AGENT', err);
  g.actions.push({
    step: st.i, type: st.type, team: st.team, agentId, by: by ?? null,
    slot: st.type === 'pick' ? st.slot : null,
    slotPlayer: st.type === 'pick' ? m.pickSlots[st.team][st.slot] ?? null : null,
    auto: !!auto, at: now, revealedAt: now, hidden: false,
  });
  afterAgentStep(room, now);
}

// Simultaneous step: record one selection for `team` (not revealed yet).
function commitAgentSim(room, team, { agentId, slot, by, auto, now }) {
  const m = room.match;
  const g = curGame(m);
  const p = g.pending;
  const side = p[team];
  if (side.done) fail('TEAM_DONE', 'このチームの選択は確定済みです');
  let idx;
  if (p.type === 'pick') {
    idx = Number(slot);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.count) fail('BAD_SLOT', '不正な枠です');
    if (side.sel[idx]) fail('SLOT_DONE', 'この枠は確定済みです');
  } else {
    idx = side.sel.indexOf(null);
  }
  const own = side.sel.filter(Boolean).map((x) => x.agentId);
  const err = agentError(m, g, team, p.type, agentId, { ownPending: own });
  if (err) fail('INVALID_AGENT', err);
  side.sel[idx] = { agentId, by: by ?? null, auto: !!auto, at: now };
  if (side.sel.every(Boolean)) {
    side.done = true;
    side.doneAt = now;
  }
  touch(room, now);
  maybeReveal(room, now);
}

// A team may also finish a hidden BAN step early with fewer bans ("Banしない" for the rest).
function finishSimSide(room, team, now) {
  const p = curGame(room.match).pending;
  if (p.type !== 'ban') fail('BAD_ACTION', 'Pickは全枠の選択が必要です');
  if (p[team].done) return;
  p[team].done = true;
  p[team].doneAt = now;
  touch(room, now);
  maybeReveal(room, now);
}

function maybeReveal(room, now) {
  const m = room.match;
  const g = curGame(m);
  const p = g.pending;
  if (!p || !p.A.done || !p.B.done) return;
  for (const t of TEAMS) {
    p[t].sel.forEach((x, idx) => {
      if (!x) return; // ban not used
      g.actions.push({
        step: p.step, type: p.type, team: t, agentId: x.agentId, by: x.by,
        slot: p.type === 'pick' ? idx : null,
        slotPlayer: p.type === 'pick' ? m.pickSlots[t][idx] ?? null : null,
        auto: x.auto, at: x.at, revealedAt: now, hidden: true,
      });
    });
  }
  g.pending = null;
  afterAgentStep(room, now);
}

// ---- map draft
function mapStates(md) {
  const st = {};
  for (const a of md.actions) if (a.mapId) st[a.mapId] = a;
  return st;
}
export function mapError(m, mapId) {
  const md = m.mapDraft;
  if (!md.pool.includes(mapId)) return 'このマップは使用できません';
  if (mapStates(md)[mapId]) return '既にBan / Pick済みです';
  return null;
}

function commitMap(room, { mapId, side, by, auto, now }) {
  const m = room.match;
  const md = m.mapDraft;
  const st = currentStep(room);
  if (st.type === 'side') {
    if (side !== 'atk' && side !== 'def') fail('BAD_SIDE', '攻撃 / 防衛を選択してください');
    const target = md.maps[md.maps.length - 1];
    target.startSides = { [st.team]: side, [other(st.team)]: side === 'atk' ? 'def' : 'atk' };
    md.actions.push({ step: st.i, type: 'side', team: st.team, mapId: target.mapId, side, by: by ?? null, auto: !!auto, at: now });
  } else {
    const err = mapError(m, mapId);
    if (err) fail('INVALID_MAP', err);
    md.actions.push({ step: st.i, type: st.type, team: st.team, mapId, by: by ?? null, auto: !!auto, at: now });
    if (st.type === 'pick') md.maps.push({ mapId, pickedBy: st.team, sideChooser: other(st.team), startSides: null, decider: false });
  }
  md.stepIndex++;
  if (md.stepIndex >= md.steps.length) {
    const used = new Set(md.actions.filter((a) => a.mapId && a.type !== 'side').map((a) => a.mapId));
    const decider = md.pool.find((id) => !used.has(id));
    const rnd = (room._random || Math.random)() < 0.5 ? 'atk' : 'def';
    md.maps.push({ mapId: decider, pickedBy: null, sideChooser: null, startSides: { A: rnd, B: rnd === 'atk' ? 'def' : 'atk' }, decider: true });
    m.games = md.maps.map((mp, i) => newGame(m, i, mp.mapId));
    m.phase = 'agent';
    m.gameIndex = 0;
    m.games[0].startedAt = now;
  }
  enterStep(room, now);
  touch(room, now);
}

// ---------------------------------------------------------------- timeouts

// Resolve the current step when its deadline passes. Returns true if something changed.
export function autoResolve(room, ctx) {
  const { now } = ctx;
  const random = ctx.random || Math.random;
  const m = room.match;
  const st = currentStep(room);
  if (!st || room.status !== 'drafting') return false;
  const pv = m.preview && m.preview.key === st.key ? m.preview : null;
  if (st.kind === 'between') {
    advanceGame(room, now);
    enterStep(room, now);
    touch(room, now);
    return true;
  }
  if (st.kind === 'side') {
    commitMap(room, { side: random() < 0.5 ? 'atk' : 'def', auto: true, now });
    return true;
  }
  if (st.kind === 'map') {
    let id = pv && !mapError(m, pv.mapId) ? pv.mapId : null;
    if (!id) {
      const pool = m.mapDraft.pool.filter((x) => !mapError(m, x));
      id = pool[Math.floor(random() * pool.length)];
    }
    commitMap(room, { mapId: id, auto: true, now });
    return true;
  }
  const g = curGame(m);
  if (st.kind === 'seq') {
    let id = pv && !agentError(m, g, st.team, st.type, pv.agentId) ? pv.agentId : null;
    if (!id) {
      const pool = validAgentsFor(m, g, st.team, st.type, ctx.agentIds);
      id = pool.length ? pool[Math.floor(random() * pool.length)] : null;
    }
    if (id) commitAgentSeq(room, id, { by: null, auto: true, now });
    else {
      g.actions.push({ step: st.i, type: st.type, team: st.team, agentId: null, auto: true, skipped: true, at: now, revealedAt: now, hidden: false });
      afterAgentStep(room, now);
    }
    return true;
  }
  // simultaneous: picks are filled at random, unused bans are skipped
  const p = g.pending;
  for (const t of TEAMS) {
    const side = p[t];
    if (side.done) continue;
    if (p.type === 'pick') {
      side.sel.forEach((x, idx) => {
        if (x) return;
        const own = side.sel.filter(Boolean).map((y) => y.agentId);
        const pool = validAgentsFor(m, g, t, 'pick', ctx.agentIds, own);
        if (pool.length) side.sel[idx] = { agentId: pool[Math.floor(random() * pool.length)], by: null, auto: true, at: now };
      });
    }
    side.done = true;
    side.doneAt = now;
  }
  maybeReveal(room, now);
  return true;
}

// ---------------------------------------------------------------- actions

// ctx = { now, agentIds, mapIds, random? }
// Returns { changed, light?, deleteRoom?, removed? }
export function applyAction(room, pid, action, ctx) {
  const { now } = ctx;
  if (!room.players[pid]) fail('NO_PLAYER', 'このルームに参加していません');
  const t = action?.type;
  switch (t) {
    case 'rename': {
      const n = cleanName(action.name);
      if (!n) fail('BAD_NAME', '名前を入力してください');
      room.players[pid].name = uniqueName(room, n, pid);
      touch(room, now);
      return { changed: true };
    }
    case 'setTeam': {
      requireLobby(room);
      const target = action.target ?? pid;
      if (target !== pid) requireHost(room, pid);
      setPlayerTeam(room, target, action.team ?? null);
      touch(room, now);
      return { changed: true };
    }
    case 'setTeamName': {
      requireLobby(room);
      const team = action.team;
      if (team !== 'A' && team !== 'B') fail('BAD_TEAM', '不正なチームです');
      if (!isHost(room, pid) && room.order[team][0] !== pid) fail('NOT_ALLOWED', 'チーム名はホストかそのチームのキャプテンのみ変更できます');
      room.settings.teamNames[team] = cleanName(action.name).toUpperCase();
      touch(room, now);
      return { changed: true };
    }
    case 'moveOrder': {
      requireLobby(room);
      requireHost(room, pid);
      const p = room.players[action.target];
      if (!p || !p.team) fail('NO_PLAYER', 'プレイヤーが見つかりません');
      const arr = room.order[p.team];
      const i = arr.indexOf(p.id);
      const j = i + (action.dir === 'up' ? -1 : 1);
      if (j < 0 || j >= arr.length) return { changed: false };
      [arr[i], arr[j]] = [arr[j], arr[i]];
      touch(room, now);
      return { changed: true };
    }
    case 'shuffleTeams': {
      requireLobby(room);
      requireHost(room, pid);
      const random = ctx.random || Math.random;
      const ids = [...room.order.A, ...room.order.B];
      const pool = shuffle(ids.length >= 2 ? ids : Object.keys(room.players), random);
      for (const id of pool) room.players[id].team = null;
      room.order = { A: [], B: [] };
      pool.slice(0, TEAM_SIZE * 2).forEach((id, i) => {
        const team = i % 2 === 0 ? 'A' : 'B';
        room.players[id].team = team;
        room.order[team].push(id);
      });
      touch(room, now);
      return { changed: true };
    }
    case 'kick': {
      requireHost(room, pid);
      if (action.target === pid) fail('BAD_TARGET', '自分はキックできません');
      if (!room.players[action.target]) fail('NO_PLAYER', 'プレイヤーが見つかりません');
      removePlayer(room, action.target);
      touch(room, now);
      return { changed: true, removed: action.target };
    }
    case 'leave': {
      // The last player leaving deletes the room.
      if (Object.keys(room.players).length <= 1) return { changed: true, deleteRoom: true, removed: pid };
      removePlayer(room, pid); // also hands the host role over when needed
      touch(room, now);
      return { changed: true, removed: pid };
    }
    case 'transferHost': {
      requireHost(room, pid);
      if (!room.players[action.target]) fail('NO_PLAYER', 'プレイヤーが見つかりません');
      room.hostId = action.target;
      touch(room, now);
      return { changed: true };
    }
    case 'updateSettings': {
      requireLobby(room);
      requireHost(room, pid);
      updateSettings(room, action.settings || {}, ctx);
      touch(room, now);
      return { changed: true };
    }
    case 'start': {
      requireHost(room, pid);
      requireLobby(room);
      startMatch(room, ctx);
      touch(room, now);
      return { changed: true };
    }
    case 'preview': {
      if (room.status !== 'drafting') return { changed: false };
      const st = currentStep(room);
      if (!st || !canActStep(room, pid, st)) return { changed: false };
      const id = action.id ?? null;
      if (st.kind === 'map') {
        if (id && !ctx.mapIds.includes(id)) return { changed: false };
        room.match.preview = id ? { key: st.key, mapId: id, by: pid } : null;
      } else if (st.kind === 'seq') {
        if (id && !ctx.agentIds.includes(id)) return { changed: false };
        room.match.preview = id ? { key: st.key, agentId: id, by: pid } : null;
      } else return { changed: false };
      return { changed: true, light: true }; // not persisted, no version bump
    }
    case 'select': {
      if (room.status === 'paused') fail('PAUSED', '一時停止中です');
      if (room.status !== 'drafting') fail('NOT_DRAFTING', 'ドラフト中ではありません');
      const st = currentStep(room);
      if (!st || action.key !== st.key) fail('STALE', '既にターンが進んでいます');
      if (st.kind === 'between') fail('STALE', '次のマップの準備中です');
      if (st.kind === 'sim') {
        const team = action.team;
        if (team !== 'A' && team !== 'B') fail('BAD_TEAM', '不正なチームです');
        if (!canActSim(room, pid, st, team, action.slot)) fail('NOT_YOUR_TURN', 'この枠は操作できません');
        if (action.finish) {
          finishSimSide(room, team, now);
          return { changed: true };
        }
        if (!ctx.agentIds.includes(action.agentId)) fail('BAD_AGENT', '不明なエージェントです');
        commitAgentSim(room, team, { agentId: action.agentId, slot: action.slot, by: pid, now });
        return { changed: true };
      }
      if (!canActStep(room, pid, st)) fail('NOT_YOUR_TURN', 'あなたのターンではありません');
      if (st.kind === 'map' || st.kind === 'side') {
        if (st.kind === 'map' && !ctx.mapIds.includes(action.mapId)) fail('BAD_MAP', '不明なマップです');
        commitMap(room, { mapId: action.mapId, side: action.side, by: pid, now });
        return { changed: true };
      }
      if (!ctx.agentIds.includes(action.agentId)) fail('BAD_AGENT', '不明なエージェントです');
      commitAgentSeq(room, action.agentId, { by: pid, now });
      return { changed: true };
    }
    case 'nextGame': {
      requireHost(room, pid);
      if (room.match?.phase !== 'between' || room.status !== 'drafting') return { changed: false };
      advanceGame(room, now);
      enterStep(room, now);
      touch(room, now);
      return { changed: true };
    }
    case 'pause': {
      requireHost(room, pid);
      if (room.status !== 'drafting') fail('NOT_DRAFTING', 'ドラフト中ではありません');
      const m = room.match;
      m.pausedRemaining = m.deadline ? Math.max(0, m.deadline - now) : null;
      m.deadline = null;
      room.status = 'paused';
      touch(room, now);
      return { changed: true };
    }
    case 'resume': {
      requireHost(room, pid);
      if (room.status !== 'paused') fail('NOT_PAUSED', '一時停止中ではありません');
      const m = room.match;
      room.status = 'drafting';
      if (m.pausedRemaining != null) m.deadline = now + Math.max(m.pausedRemaining, 5000);
      else {
        const sec = stepSeconds(room);
        m.deadline = sec ? now + sec * 1000 : null;
      }
      m.pausedRemaining = null;
      touch(room, now);
      return { changed: true };
    }
    case 'abort': {
      requireHost(room, pid);
      if (room.status !== 'drafting' && room.status !== 'paused') fail('NOT_DRAFTING', 'ドラフト中ではありません');
      room.match = null;
      room.status = 'lobby';
      touch(room, now);
      return { changed: true };
    }
    case 'backToLobby': {
      requireHost(room, pid);
      if (room.status !== 'finished') fail('NOT_FINISHED', 'ドラフトが終了していません');
      room.status = 'lobby';
      room.match = null;
      touch(room, now);
      return { changed: true };
    }
    default:
      fail('BAD_ACTION', '不明な操作です');
  }
}

// ---------------------------------------------------------------- views

// What a given viewer may see. Hidden (blind) selections of the other team are removed:
// only the number of filled slots is sent. Spectators see neither team's hidden selections.
export function viewFor(room, viewerTeam, now) {
  const m = room.match;
  let match = m;
  const g = curGame(m);
  if (m && g && g.pending) {
    const st = currentStep(room);
    const pending = { step: g.pending.step, type: g.pending.type, count: g.pending.count };
    for (const t of TEAMS) {
      const side = g.pending[t];
      if (!st.hidden || t === viewerTeam) pending[t] = side;
      else pending[t] = { sel: side.sel.map((x) => (x ? { hidden: true } : null)), done: side.done, doneAt: side.doneAt };
    }
    const games = m.games.map((x) => (x === g ? { ...x, pending } : x));
    match = { ...m, games };
  }
  return { ...room, match, serverNow: now };
}

// ---------------------------------------------------------------- results

export function buildResult(room, { id, now }) {
  const m = room.match;
  const games = m.games.map((g) => {
    const teams = {};
    for (const t of TEAMS) {
      const mine = g.actions.filter((a) => a.team === t && a.agentId);
      teams[t] = {
        protects: mine.filter((a) => a.type === 'protect').map((a) => a.agentId),
        bans: mine.filter((a) => a.type === 'ban').map((a) => a.agentId),
        picks: mine
          .filter((a) => a.type === 'pick')
          .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
          .map((a) => ({ agentId: a.agentId, player: a.slotPlayer ? m.names[a.slotPlayer] ?? null : null, auto: a.auto })),
      };
    }
    const mp = m.mapDraft?.maps.find((x) => x.mapId === g.mapId) || null;
    return {
      index: g.index,
      mapId: g.mapId,
      firstTeam: g.firstTeam,
      map: mp,
      teams,
      log: g.actions.map((a) => ({ type: a.type, team: a.team, agentId: a.agentId, by: a.by ? m.names[a.by] ?? '?' : null, auto: a.auto, hidden: a.hidden, at: a.at, revealedAt: a.revealedAt, skipped: !!a.skipped })),
    };
  });
  return {
    version: 2,
    id,
    roomId: room.id,
    mode: m.mode,
    series: m.series,
    method: m.method,
    counts: m.counts,
    teamNames: m.teamNames,
    teamNameDefault: m.teamNameDefault,
    rosters: { A: m.roster.A.map((p) => m.names[p]), B: m.roster.B.map((p) => m.names[p]) },
    agentGlobalBans: m.agentGlobalBans,
    mapGlobalBans: m.mapGlobalBans,
    mapDraft: m.mapDraft
      ? { pool: m.mapDraft.pool, maps: m.mapDraft.maps, log: m.mapDraft.actions.map((a) => ({ ...a, by: a.by ? m.names[a.by] ?? '?' : null })) }
      : null,
    games,
    fearlessUsed: m.fearlessUsed,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt ?? now,
  };
}

export { PICKS_PER_TEAM };
