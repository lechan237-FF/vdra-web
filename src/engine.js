// Pure room / draft state machine. No I/O here: the server calls these functions,
// then persists and broadcasts the result. Every mutation bumps room.version.

import { SYSTEM_MAP, buildSteps } from './systems.js';

export const MAX_PLAYERS = 20;
export const TEAM_SIZE = 5;
export const TIMER_OPTIONS = [0, 15, 20, 30, 45, 60, 90];
export const NAME_MAX = 16;

export class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, msg) => {
  throw new ActionError(code, msg);
};

export function cleanName(name) {
  const n = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, NAME_MAX);
  return n;
}

export function createRoom({ id, hostId, hostName, now }) {
  const room = {
    id,
    createdAt: now,
    updatedAt: now,
    version: 1,
    hostId,
    status: 'lobby', // lobby | drafting | paused | finished
    settings: {
      systemId: 'standard',
      timer: 30,
      mirror: SYSTEM_MAP.standard.mirror,
      hostOverride: true,
      teamNames: { A: 'ATTACKERS', B: 'DEFENDERS' },
    },
    players: {},
    order: { A: [], B: [] }, // player order inside a team; index 0 = captain
    draft: null,
    resultId: null,
    history: [], // result ids of past drafts in this room
  };
  addPlayer(room, { id: hostId, name: hostName, now });
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

function touch(room, now) {
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

function removePlayer(room, pid) {
  const p = room.players[pid];
  if (!p) return;
  if (p.team) room.order[p.team] = room.order[p.team].filter((x) => x !== pid);
  delete room.players[pid];
}

const isHost = (room, pid) => room.hostId === pid;
const requireHost = (room, pid) => {
  if (!isHost(room, pid)) fail('NOT_HOST', 'ホストのみ操作できます');
};
const requireLobby = (room) => {
  if (room.status !== 'lobby' && room.status !== 'finished') fail('NOT_LOBBY', 'ドラフト中は変更できません');
};

// ---------------------------------------------------------------- draft helpers

export function currentStep(room) {
  const d = room.draft;
  if (!d || d.stepIndex >= d.steps.length) return null;
  return d.steps[d.stepIndex];
}

// Aggregate what has happened to each agent so far.
export function agentStates(draft) {
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

// Returns null if allowed, or a Japanese reason string.
export function selectionError(draft, step, agentId, states = agentStates(draft)) {
  const s = states[agentId] || { gban: null, ban: null, protect: [], pick: [] };
  const opp = other(step.team);
  if (s.gban) return 'Global Ban済みです';
  switch (step.type) {
    case 'gban':
      return null;
    case 'protect':
      if (s.ban) return 'Ban済みです';
      if (s.protect.includes(step.team)) return '既にProtect済みです';
      if (!draft.mirror && s.protect.includes(opp)) return '相手チームがProtect済みです';
      return null;
    case 'ban':
      if (s.ban) return 'Ban済みです';
      if (s.pick.length) return 'Pick済みのエージェントはBanできません';
      if (s.protect.includes(opp)) return '相手チームがProtectしています';
      if (s.protect.includes(step.team)) return '自チームがProtectしています';
      return null;
    case 'pick':
      if (s.ban) return 'Ban済みです';
      if (s.pick.includes(step.team)) return '自チームでPick済みです';
      if (!draft.mirror && s.pick.includes(opp)) return '相手チームがPick済みです';
      if (!draft.mirror && s.protect.includes(opp)) return '相手チームがProtectしています';
      return null;
    default:
      return '不正な操作です';
  }
}

export function validAgents(draft, step, agentIds) {
  const states = agentStates(draft);
  return agentIds.filter((id) => !selectionError(draft, step, id, states));
}

// Who must act for this step.
export function stepActor(room, step) {
  const d = room.draft;
  if (step.type === 'pick') return d.pickSlots[step.team][step.slot] ?? d.captains[step.team];
  return d.captains[step.team];
}

export function canAct(room, pid, step) {
  if (!step) return false;
  const d = room.draft;
  if (room.settings.hostOverride && isHost(room, pid)) return true;
  const actor = stepActor(room, step);
  if (actor === pid) return true;
  // Fallbacks so a disconnected player never blocks the draft:
  const actorP = room.players[actor];
  const actorAway = !actorP || !actorP.online || actorP.team !== step.team;
  if (!actorAway) return false;
  const me = room.players[pid];
  if (!me || me.team !== step.team) return false;
  // captain may act for an absent teammate; if captain is also absent, any teammate may act
  const cap = room.players[d.captains[step.team]];
  const capAway = !cap || !cap.online || cap.team !== step.team;
  return pid === d.captains[step.team] || capAway;
}

function startDraft(room, now) {
  const sys = SYSTEM_MAP[room.settings.systemId];
  if (!sys) fail('BAD_SYSTEM', '不正なドラフト形式です');
  if (!room.order.A.length || !room.order.B.length) fail('TEAM_EMPTY', '両チームに1人以上必要です');
  const steps = buildSteps(sys);
  const pickSlots = {};
  for (const t of ['A', 'B']) {
    const members = room.order[t];
    // 5 pick slots; when fewer than 5 players, members take turns
    pickSlots[t] = Array.from({ length: TEAM_SIZE }, (_, i) => members[i % members.length]);
  }
  room.draft = {
    systemId: sys.id,
    mirror: !!room.settings.mirror,
    timer: room.settings.timer,
    steps,
    stepIndex: 0,
    actions: [],
    pickSlots,
    captains: { A: room.order.A[0], B: room.order.B[0] },
    teamNames: { ...room.settings.teamNames },
    roster: { A: [...room.order.A], B: [...room.order.B] },
    names: Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.name])),
    startedAt: now,
    finishedAt: null,
    deadline: null,
    pausedRemaining: null,
    preview: null,
  };
  room.status = 'drafting';
  room.resultId = null;
  armDeadline(room, now);
}

function armDeadline(room, now) {
  const d = room.draft;
  d.deadline = d.timer > 0 && d.stepIndex < d.steps.length ? now + d.timer * 1000 : null;
}

// Apply one selection. `by` = player id or null for auto.
export function commitSelection(room, agentId, { by, auto = false, now }) {
  const d = room.draft;
  const step = currentStep(room);
  if (!step) fail('NO_STEP', 'ドラフトは終了しています');
  const err = selectionError(d, step, agentId);
  if (err) fail('INVALID_AGENT', err);
  d.actions.push({
    step: step.i,
    type: step.type,
    team: step.team,
    agentId,
    by: by ?? null,
    slotPlayer: step.type === 'pick' ? stepActor(room, step) : null,
    auto,
    at: now,
  });
  d.stepIndex++;
  d.preview = null;
  if (d.stepIndex >= d.steps.length) {
    d.finishedAt = now;
    d.deadline = null;
    room.status = 'finished';
  } else {
    armDeadline(room, now);
  }
  touch(room, now);
}

// Called by the server timer. Picks a random valid agent for the current step.
export function autoSelect(room, agentIds, { now, random = Math.random }) {
  const step = currentStep(room);
  if (!step || room.status !== 'drafting') return false;
  const d = room.draft;
  // Prefer the agent the actor was hovering if still valid
  let choice = null;
  if (d.preview && d.preview.step === step.i && !selectionError(d, step, d.preview.agentId)) {
    choice = d.preview.agentId;
  } else {
    const pool = validAgents(d, step, agentIds);
    if (pool.length) choice = pool[Math.floor(random() * pool.length)];
  }
  if (!choice) {
    // Nothing selectable (practically impossible) - skip the step safely.
    d.actions.push({ step: step.i, type: step.type, team: step.team, agentId: null, by: null, auto: true, at: now, skipped: true });
    d.stepIndex++;
    if (d.stepIndex >= d.steps.length) {
      d.finishedAt = now;
      d.deadline = null;
      room.status = 'finished';
    } else armDeadline(room, now);
    touch(room, now);
    return true;
  }
  commitSelection(room, choice, { by: null, auto: true, now });
  return true;
}

// ---------------------------------------------------------------- actions

// ctx = { now, agentIds: string[], systems }
// Returns { changed: boolean, finished?: boolean, light?: boolean }
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
      const pool = ids.length >= 2 ? ids : Object.keys(room.players);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
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
      requireLobby(room);
      requireHost(room, pid);
      if (action.target === pid) fail('BAD_TARGET', '自分はキックできません');
      if (!room.players[action.target]) fail('NO_PLAYER', 'プレイヤーが見つかりません');
      removePlayer(room, action.target);
      touch(room, now);
      return { changed: true, kicked: action.target };
    }
    case 'leave': {
      if (room.status === 'drafting' || room.status === 'paused') {
        const me = room.players[pid];
        if (me.team) fail('IN_DRAFT', 'ドラフト中はチームから退出できません');
      }
      const wasHost = isHost(room, pid);
      removePlayer(room, pid);
      if (wasHost) {
        const next = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)[0];
        room.hostId = next ? next.id : null;
      }
      touch(room, now);
      return { changed: true };
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
      const s = room.settings;
      const a = action.settings || {};
      if (a.systemId !== undefined) {
        if (!SYSTEM_MAP[a.systemId]) fail('BAD_SYSTEM', '不正なドラフト形式です');
        if (a.systemId !== s.systemId) {
          s.systemId = a.systemId;
          s.mirror = SYSTEM_MAP[a.systemId].mirror; // reset to the format default
        }
      }
      if (a.timer !== undefined) {
        if (!TIMER_OPTIONS.includes(Number(a.timer))) fail('BAD_TIMER', '不正なタイマー設定です');
        s.timer = Number(a.timer);
      }
      if (a.mirror !== undefined) s.mirror = !!a.mirror;
      if (a.hostOverride !== undefined) s.hostOverride = !!a.hostOverride;
      if (a.teamNames) {
        for (const k of ['A', 'B']) {
          if (a.teamNames[k] !== undefined) {
            const n = cleanName(a.teamNames[k]).toUpperCase();
            s.teamNames[k] = n || (k === 'A' ? 'ATTACKERS' : 'DEFENDERS');
          }
        }
      }
      touch(room, now);
      return { changed: true };
    }
    case 'start': {
      requireHost(room, pid);
      requireLobby(room);
      startDraft(room, now);
      touch(room, now);
      return { changed: true };
    }
    case 'preview': {
      if (room.status !== 'drafting') return { changed: false };
      const step = currentStep(room);
      if (!step || !canAct(room, pid, step)) return { changed: false };
      if (action.agentId != null && !ctx.agentIds.includes(action.agentId)) return { changed: false };
      room.draft.preview = action.agentId ? { step: step.i, agentId: action.agentId, by: pid } : null;
      // preview is not a meaningful state change: no version bump, not persisted
      return { changed: true, light: true };
    }
    case 'select': {
      if (room.status === 'paused') fail('PAUSED', '一時停止中です');
      if (room.status !== 'drafting') fail('NOT_DRAFTING', 'ドラフト中ではありません');
      const step = currentStep(room);
      // Optimistic concurrency: the client says which step it is acting on.
      if (action.stepIndex !== step.i) fail('STALE', '既にターンが進んでいます');
      if (!canAct(room, pid, step)) fail('NOT_YOUR_TURN', 'あなたのターンではありません');
      if (!ctx.agentIds.includes(action.agentId)) fail('BAD_AGENT', '不明なエージェントです');
      commitSelection(room, action.agentId, { by: pid, now });
      return { changed: true, finished: room.status === 'finished' };
    }
    case 'pause': {
      requireHost(room, pid);
      if (room.status !== 'drafting') fail('NOT_DRAFTING', 'ドラフト中ではありません');
      const d = room.draft;
      d.pausedRemaining = d.deadline ? Math.max(0, d.deadline - now) : null;
      d.deadline = null;
      room.status = 'paused';
      touch(room, now);
      return { changed: true };
    }
    case 'resume': {
      requireHost(room, pid);
      if (room.status !== 'paused') fail('NOT_PAUSED', '一時停止中ではありません');
      const d = room.draft;
      d.deadline = d.pausedRemaining != null ? now + Math.max(d.pausedRemaining, 5000) : null;
      if (d.deadline == null && d.timer > 0) armDeadline(room, now);
      d.pausedRemaining = null;
      room.status = 'drafting';
      touch(room, now);
      return { changed: true };
    }
    case 'abort': {
      requireHost(room, pid);
      if (room.status !== 'drafting' && room.status !== 'paused') fail('NOT_DRAFTING', 'ドラフト中ではありません');
      room.draft = null;
      room.status = 'lobby';
      touch(room, now);
      return { changed: true };
    }
    case 'backToLobby': {
      requireHost(room, pid);
      if (room.status !== 'finished') fail('NOT_FINISHED', 'ドラフトが終了していません');
      room.status = 'lobby';
      room.draft = null;
      touch(room, now);
      return { changed: true };
    }
    default:
      fail('BAD_ACTION', '不明な操作です');
  }
}

// ---------------------------------------------------------------- results

export function buildResult(room, { id, now }) {
  const d = room.draft;
  const sys = SYSTEM_MAP[d.systemId];
  const teams = {};
  for (const t of ['A', 'B']) {
    const picks = d.actions
      .filter((a) => a.type === 'pick' && a.team === t)
      .map((a) => ({ agentId: a.agentId, player: d.names[a.slotPlayer] ?? null, auto: a.auto }));
    teams[t] = {
      name: d.teamNames[t],
      players: d.roster[t].map((p) => d.names[p] ?? '?'),
      picks,
      bans: d.actions.filter((a) => a.type === 'ban' && a.team === t).map((a) => a.agentId),
      gbans: d.actions.filter((a) => a.type === 'gban' && a.team === t).map((a) => a.agentId),
      protects: d.actions.filter((a) => a.type === 'protect' && a.team === t).map((a) => a.agentId),
    };
  }
  return {
    id,
    roomId: room.id,
    systemId: sys.id,
    systemName: sys.name,
    mirror: d.mirror,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt ?? now,
    teams,
    log: d.actions.map((a) => ({
      step: a.step,
      type: a.type,
      team: a.team,
      agentId: a.agentId,
      by: a.by ? d.names[a.by] ?? '?' : null,
      auto: a.auto,
      skipped: !!a.skipped,
    })),
  };
}

// State sent to clients (no tokens are stored on the room object, so it is safe as-is).
export function publicRoom(room, now) {
  return { ...room, serverNow: now };
}
