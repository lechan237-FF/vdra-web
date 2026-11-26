import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS } from '../src/methods.js';
import {
  createRoom, addPlayer, applyAction, autoResolve, currentStep, curGame, agentError, viewFor, buildResult,
  migrateRoom, transferHostIfOffline, ActionError, buildMapSteps,
} from '../src/engine.js';

const AGENTS = ['astra', 'breach', 'brimstone', 'chamber', 'clove', 'cypher', 'deadlock', 'fade', 'gekko', 'harbor', 'iso', 'jett', 'kayo', 'killjoy', 'neon', 'omen', 'phoenix', 'raze', 'reyna', 'sage', 'skye', 'sova', 'tejo', 'viper', 'vyse', 'waylay', 'yoru', 'veto'];
const MAPS = ['abyss', 'ascent', 'bind', 'breeze', 'corrode', 'fracture', 'haven', 'icebox', 'lotus', 'pearl', 'split', 'sunset'];
let t = 1000;
const ctx = (extra = {}) => ({ now: (t += 10), agentIds: AGENTS, mapIds: MAPS, ...extra });
const act = (room, pid, a, extra) => {
  if (a?.type === 'start') room.ready = { A: true, B: true }; // captains READY (tested separately)
  return applyAction(room, pid, a, ctx(extra));
};

// host 'h' + 9 players; even -> A, odd -> B (perTeam players each)
function setup(settings = {}, perTeam = 5) {
  const room = createRoom({ id: 'TEST01', hostId: 'h', hostName: 'Host', now: t });
  act(room, 'h', { type: 'setTeam', team: 'A' });
  for (let i = 1; i < perTeam * 2; i++) {
    const id = 'p' + i;
    addPlayer(room, { id, name: 'P' + i, now: t });
    act(room, id, { type: 'setTeam', team: i % 2 ? 'B' : 'A' });
  }
  for (const p of Object.values(room.players)) p.online = true;
  room.settings.hostOverride = false;
  act(room, 'h', { type: 'updateSettings', settings });
  return room;
}

const seqTeams = (game, type) => game.steps.filter((s) => s.type === type).map((s) => s.team).join('');

// Play the whole match with legal moves by the right players. `choose` can override choices.
function playAll(room, { choose = {} } = {}) {
  const m = room.match;
  let guard = 0;
  while (room.status === 'drafting' && guard++ < 500) {
    const st = currentStep(room);
    if (st.kind === 'between') {
      act(room, room.hostId, { type: 'nextGame' });
      continue;
    }
    if (st.kind === 'map') {
      const cap = m.captains[st.team];
      const id = m.mapDraft.pool.find((x) => !m.mapDraft.actions.some((a) => a.mapId === x && a.type !== 'side'));
      act(room, cap, { type: 'select', key: st.key, mapId: id });
      continue;
    }
    if (st.kind === 'side') {
      act(room, m.captains[st.team], { type: 'select', key: st.key, side: 'atk' });
      continue;
    }
    const g = curGame(m);
    if (st.kind === 'seq') {
      const pid = st.type === 'pick' ? m.pickSlots[st.team][st.slot] : m.captains[st.team];
      const id = choose.seq?.(st, g) || AGENTS.find((a) => !agentError(m, g, st.team, st.type, a));
      act(room, pid, { type: 'select', key: st.key, agentId: id });
      continue;
    }
    // simultaneous: each team's captain fills every slot
    for (const team of ['A', 'B']) {
      for (let slot = 0; slot < st.count; slot++) {
        const side = g.pending?.[team];
        if (!side || side.done || side.sel[slot]) continue;
        const own = side.sel.filter(Boolean).map((x) => x.agentId);
        const id = choose.sim?.(st, g, team, slot) || AGENTS.find((a) => !agentError(m, g, team, st.type, a, { ownPending: own }));
        act(room, m.captains[team], { type: 'select', key: st.key, team, slot, agentId: id });
        if (!curGame(m) || curGame(m).pending == null) break;
      }
    }
  }
  assert.equal(room.status, 'finished');
}

// ---------------------------------------------------------------- orders

test('Standard / Snake orders match the spec notation', () => {
  const cases = [
    ['normal', 'standard', {}, { pick: 'ABABABABAB' }],
    ['normal', 'snake', {}, { pick: 'ABBAABBAAB' }],
    ['ban', 'standard', {}, { ban: 'ABAB', pick: 'ABABABABAB' }],
    ['ban', 'snake', {}, { ban: 'ABBA', pick: 'ABBAABBAAB' }],
    ['ban', 'snake', { banCount: 3 }, { ban: 'ABBAAB' }],
    ['enemy_ban', 'snake', {}, { ban: 'ABBA', pick: 'ABBAABBAAB' }],
    ['protect_ban', 'standard', {}, { protect: 'AB', ban: 'ABAB', pick: 'ABABABABAB' }],
    ['protect_ban', 'snake', {}, { protect: 'AB', ban: 'ABBA', pick: 'ABBAABBAAB' }],
    ['protect_ban', 'snake', { protectCount: 2 }, { protect: 'ABBA' }],
    ['head_protect', 'standard', { protectCount: 2 }, { protect: 'ABAB' }],
    ['blind_ban', 'standard', {}, { ban: 'ABAB' }],
    ['blind_ban', 'snake', { blindBanCount: 4 }, { ban: 'ABBAABBA' }],
  ];
  for (const [method, order, extra, expect] of cases) {
    const room = setup({ method, order, ...extra });
    act(room, 'h', { type: 'start' });
    const g = curGame(room.match);
    for (const [type, seq] of Object.entries(expect)) assert.equal(seqTeams(g, type), seq, `${method}/${order}/${type}`);
  }
});

test('Blind phases are single simultaneous steps; Blind Enemy Ban has 4 hidden bans by default', () => {
  let room = setup({ method: 'blind_ban' });
  act(room, 'h', { type: 'start' });
  let g = curGame(room.match);
  assert.deepEqual(g.steps.filter((s) => s.kind === 'sim').map((s) => [s.type, s.count, s.hidden]), [['pick', 5, true]]);
  room = setup({ method: 'blind_enemy_ban' });
  act(room, 'h', { type: 'start' });
  g = curGame(room.match);
  assert.deepEqual(g.steps.map((s) => [s.kind, s.type, s.count]), [['sim', 'ban', 4], ['sim', 'pick', 5]]);
});

test('every method x order completes with correct counts (agent-only, and Bo3 for Fearless)', () => {
  for (const m of METHODS) {
    for (const order of ['standard', 'snake']) {
      const settings = m.seriesOnly ? { mode: 'map', series: 'bo3', mapGlobalBans: MAPS.slice(0, 5), method: m.id, order } : { method: m.id, order };
      const room = setup(settings);
      act(room, 'h', { type: 'start' });
      playAll(room);
      const res = buildResult(room, { id: 'R', now: t });
      for (const g of res.games) {
        assert.equal(g.teams.A.picks.length, 5, m.id);
        assert.equal(g.teams.B.picks.length, 5, m.id);
        const ban = { ban: 2, enemy_ban: 2, protect_ban: 2, head_protect: 2, blind_ban: 2, blind_enemy_ban: 4 }[m.id] || 0;
        assert.equal(g.teams.A.bans.length, ban, `${m.id} bans`);
        const prot = ['protect_ban', 'head_protect'].includes(m.id) ? 1 : 0;
        assert.equal(g.teams.A.protects.length, prot, `${m.id} protects`);
        assert.equal(new Set(g.teams.A.picks.map((p) => p.agentId)).size, 5, `${m.id} no duplicate in team`);
        if (m.rules.pickCross === 'unique') {
          const all = [...g.teams.A.picks, ...g.teams.B.picks].map((p) => p.agentId);
          assert.equal(new Set(all).size, 10, `${m.id} unique across teams`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- rules

test('Normal: no cross-team or same-team duplicates', () => {
  const room = setup({ method: 'normal' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  act(room, 'h', { type: 'select', key: currentStep(room).key, agentId: 'jett' });
  assert.throws(() => act(room, m.pickSlots.B[0], { type: 'select', key: currentStep(room).key, agentId: 'jett' }), /相手チームがPick/);
});

test('Ban Draft: same agent cannot be banned twice; banned agent blocked for both', () => {
  const room = setup({ method: 'ban' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  act(room, 'h', { type: 'select', key: currentStep(room).key, agentId: 'jett' });
  assert.throws(() => act(room, m.captains.B, { type: 'select', key: currentStep(room).key, agentId: 'jett' }), /Ban済み/);
  const g = curGame(m);
  assert.ok(agentError(m, g, 'A', 'pick', 'jett'));
  assert.ok(agentError(m, g, 'B', 'pick', 'jett'));
});

test('Enemy Ban: my ban only blocks the enemy; enemy cannot ban the same agent', () => {
  const room = setup({ method: 'enemy_ban' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  act(room, 'h', { type: 'select', key: currentStep(room).key, agentId: 'jett' }); // A bans Jett
  const g = curGame(m);
  assert.equal(agentError(m, g, 'A', 'pick', 'jett'), null);
  assert.match(agentError(m, g, 'B', 'pick', 'jett'), /Ban/);
  assert.match(agentError(m, g, 'B', 'ban', 'jett'), /Ban済み/);
});

test('Protect Ban vs Head Protect', () => {
  for (const [method, enemyCanPick] of [['protect_ban', true], ['head_protect', false]]) {
    const room = setup({ method });
    act(room, 'h', { type: 'start' });
    const m = room.match;
    act(room, 'h', { type: 'select', key: currentStep(room).key, agentId: 'sova' }); // A protects
    assert.throws(() => act(room, m.captains.B, { type: 'select', key: currentStep(room).key, agentId: 'sova' }), /Protect済み/); // no double protect
    act(room, m.captains.B, { type: 'select', key: currentStep(room).key, agentId: 'omen' });
    const g = curGame(m);
    assert.match(agentError(m, g, 'B', 'ban', 'sova'), /Protect/);
    assert.match(agentError(m, g, 'A', 'ban', 'sova'), /Protect/);
    assert.equal(agentError(m, g, 'A', 'pick', 'sova'), null);
    assert.equal(agentError(m, g, 'B', 'pick', 'sova') === null, enemyCanPick, method);
  }
});

test('Blind Ban Pick: opponent hidden selections never appear in another team view; mirror allowed', () => {
  const room = setup({ method: 'blind_ban' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  playUntilSim(room);
  const st = currentStep(room);
  act(room, m.captains.A, { type: 'select', key: st.key, team: 'A', slot: 0, agentId: 'jett' });
  const viewB = JSON.stringify(viewFor(room, 'B', t));
  const viewS = JSON.stringify(viewFor(room, null, t));
  const viewA = JSON.stringify(viewFor(room, 'A', t));
  assert.ok(!viewB.includes('"jett"'), 'B must not see A pending pick');
  assert.ok(!viewS.includes('"jett"'), 'spectator must not see pending pick');
  assert.ok(viewA.includes('"jett"'));
  // B cannot act for A, host on team A cannot act for B
  assert.throws(() => act(room, m.captains.B, { type: 'select', key: st.key, team: 'A', slot: 1, agentId: 'sage' }), /操作できません/);
  room.settings.hostOverride = true;
  assert.throws(() => act(room, 'h', { type: 'select', key: st.key, team: 'B', slot: 0, agentId: 'sage' }), /操作できません/);
  // B mirrors Jett
  act(room, m.captains.B, { type: 'select', key: st.key, team: 'B', slot: 0, agentId: 'jett' });
  // A cannot pick Jett twice
  assert.throws(() => act(room, m.captains.A, { type: 'select', key: st.key, team: 'A', slot: 1, agentId: 'jett' }), /自チーム/);
});

function playUntilSim(room) {
  const m = room.match;
  while (currentStep(room).kind !== 'sim') {
    const st = currentStep(room);
    const g = curGame(m);
    const id = AGENTS.find((a) => !agentError(m, g, st.team, st.type, a));
    act(room, m.captains[st.team], { type: 'select', key: st.key, agentId: id });
  }
}

test('Blind Enemy Ban Pick: duplicate bans allowed, bans hit only the enemy, picks may mirror, reveal together', () => {
  const room = setup({ method: 'blind_enemy_ban' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  let st = currentStep(room);
  const bans = { A: ['jett', 'raze', 'omen', 'sova'], B: ['jett', 'sage', 'viper', 'fade'] };
  for (const team of ['A', 'B']) for (const id of bans[team]) act(room, m.captains[team], { type: 'select', key: st.key, team, agentId: id });
  const g = curGame(m);
  assert.equal(g.actions.filter((a) => a.type === 'ban').length, 8);
  assert.ok(g.actions.every((a) => a.hidden && a.revealedAt));
  assert.match(agentError(m, g, 'A', 'pick', 'sage'), /Ban/); // B banned sage for A
  assert.equal(agentError(m, g, 'A', 'pick', 'raze'), null); // A's own ban
  assert.match(agentError(m, g, 'B', 'pick', 'raze'), /Ban/);
  assert.match(agentError(m, g, 'A', 'pick', 'jett'), /Ban/); // banned by both
  st = currentStep(room);
  act(room, m.captains.A, { type: 'select', key: st.key, team: 'A', slot: 0, agentId: 'killjoy' });
  act(room, m.captains.B, { type: 'select', key: st.key, team: 'B', slot: 0, agentId: 'killjoy' }); // mirror OK
});

test('Blind Enemy Ban: a team may finish with fewer bans; timeout fills picks randomly', () => {
  const room = setup({ method: 'blind_enemy_ban' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  const st = currentStep(room);
  act(room, m.captains.A, { type: 'select', key: st.key, team: 'A', agentId: 'jett' });
  act(room, m.captains.A, { type: 'select', key: st.key, team: 'A', finish: true });
  autoResolve(room, ctx()); // B never banned -> skipped
  const g = curGame(m);
  assert.equal(g.actions.filter((a) => a.type === 'ban').length, 1);
  assert.equal(currentStep(room).type, 'pick');
  act(room, m.captains.A, { type: 'select', key: currentStep(room).key, team: 'A', slot: 2, agentId: 'sage' });
  autoResolve(room, ctx());
  assert.equal(room.status, 'finished');
  const res = buildResult(room, { id: 'R', now: t });
  assert.equal(res.games[0].teams.A.picks.length, 5);
  assert.equal(res.games[0].teams.A.picks[2].agentId, 'sage');
  assert.equal(res.games[0].teams.B.picks.length, 5);
  assert.ok(res.games[0].teams.B.picks.every((p) => p.auto));
});

test('Fearless: own previous picks blocked for later maps, enemy unaffected; Bo5 has 5 games', () => {
  const room = setup({ mode: 'map', series: 'bo5', mapGlobalBans: MAPS.slice(0, 5), method: 'fearless' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  const seen = { A: new Set(), B: new Set() };
  playAll(room, {
    choose: {
      sim: (st, g, team, slot) => {
        const own = g.pending[team].sel.filter(Boolean).map((x) => x.agentId);
        // B always prefers the agents A used before (allowed for B)
        const order = team === 'B' ? [...m.fearlessUsed.A, ...[...AGENTS].reverse()] : AGENTS;
        return order.find((a) => !agentError(m, g, team, 'pick', a, { ownPending: own }));
      },
    },
  });
  const res = buildResult(room, { id: 'R', now: t });
  assert.equal(res.games.length, 5);
  for (const g of res.games) {
    for (const team of ['A', 'B']) {
      for (const p of g.teams[team].picks) {
        assert.ok(!seen[team].has(p.agentId), `team ${team} reused ${p.agentId}`);
      }
      g.teams[team].picks.forEach((p) => seen[team].add(p.agentId));
    }
  }
  assert.equal(res.fearlessUsed.A.length, 25);
  // B reused agents that A had used -> enemy history does not restrict
  const g2B = res.games[1].teams.B.picks.map((p) => p.agentId);
  assert.ok(g2B.some((id) => res.games[0].teams.A.picks.some((p) => p.agentId === id)));
});

test('Fearless is Bo3/Bo5 only', () => {
  const room = setup({});
  assert.throws(() => act(room, 'h', { type: 'updateSettings', settings: { method: 'fearless' } }), /専用/);
  act(room, 'h', { type: 'updateSettings', settings: { mode: 'map', method: 'fearless' } });
  act(room, 'h', { type: 'updateSettings', settings: { mode: 'agent' } });
  assert.equal(room.settings.method, 'normal');
});

// ---------------------------------------------------------------- map draft

test('map steps follow the fixed order; side choice by the other team after each pick', () => {
  const fmt = (series) => buildMapSteps(series).map((s) => (s.type === 'ban' ? `{${s.team}}` : s.type === 'pick' ? `[${s.team}]` : `(side ${s.team})`)).join('');
  assert.equal(fmt('bo3'), '{A}{B}[A](side B)[B](side A){A}{B}');
  assert.equal(fmt('bo5'), '{A}{B}[A](side B)[B](side A)[A](side B)[B](side A)');
});

test('map draft Bo3: needs exactly 7 maps, no duplicates, decider with random sides, 3 games with alternating first team', () => {
  const room = setup({ mode: 'map', series: 'bo3', method: 'ban' });
  assert.throws(() => act(room, 'h', { type: 'start' }), /Global Ban/);
  assert.throws(() => act(room, 'h', { type: 'updateSettings', settings: { mapGlobalBans: MAPS.slice(0, 6) } }), /最大5/);
  act(room, 'h', { type: 'updateSettings', settings: { mapGlobalBans: MAPS.slice(0, 5) } });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  assert.deepEqual(m.mapDraft.pool, MAPS.slice(5));
  // banned map can't be picked again
  const st = currentStep(room);
  act(room, m.captains[st.team], { type: 'select', key: st.key, mapId: 'haven' });
  const st2 = currentStep(room);
  if (st2.kind === 'map') assert.throws(() => act(room, m.captains[st2.team], { type: 'select', key: st2.key, mapId: 'haven' }), /済み/);
  assert.throws(() => act(room, m.captains.A, { type: 'select', key: st2.key, mapId: 'abyss' }));
  playAll(room);
  const maps = m.mapDraft.maps;
  assert.equal(maps.length, 3);
  assert.equal(new Set(maps.map((x) => x.mapId)).size, 3);
  assert.equal(maps[2].decider, true);
  for (const mp of maps) assert.ok(mp.startSides.A && mp.startSides.B && mp.startSides.A !== mp.startSides.B);
  for (const mp of maps.filter((x) => !x.decider)) assert.equal(mp.sideChooser, mp.pickedBy === 'A' ? 'B' : 'A');
  assert.deepEqual(m.games.map((g) => g.firstTeam), ['A', 'B', 'A']);
  assert.deepEqual(m.games.map((g) => g.mapId), maps.map((x) => x.mapId));
});

test('side step: only the non-picking team chooses', () => {
  const room = setup({ mode: 'map', series: 'bo5', mapGlobalBans: MAPS.slice(0, 5) });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  while (currentStep(room).kind !== 'side') {
    const st = currentStep(room);
    const id = m.mapDraft.pool.find((x) => !m.mapDraft.actions.some((a) => a.mapId === x));
    act(room, m.captains[st.team], { type: 'select', key: st.key, mapId: id });
  }
  const st = currentStep(room);
  const picker = m.mapDraft.maps.at(-1).pickedBy;
  assert.notEqual(st.team, picker);
  assert.throws(() => act(room, m.captains[picker], { type: 'select', key: st.key, side: 'atk' }), /ターン/);
  act(room, m.captains[st.team], { type: 'select', key: st.key, side: 'def' });
  assert.equal(m.mapDraft.maps.at(-1).startSides[st.team], 'def');
});

test('series: between maps auto-advances on timeout; history does not mix between games', () => {
  const room = setup({ mode: 'map', series: 'bo3', mapGlobalBans: MAPS.slice(0, 5), method: 'normal' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  while (m.phase !== 'between') autoResolve(room, ctx());
  assert.ok(m.deadline);
  autoResolve(room, ctx());
  assert.equal(m.phase, 'agent');
  assert.equal(m.gameIndex, 1);
  assert.equal(curGame(m).actions.length, 0);
  // normal draft per map: game 1 picks are available again on map 2
  const used = m.games[0].actions.map((a) => a.agentId);
  assert.equal(agentError(m, curGame(m), 'B', 'pick', used[0]), null);
});

// ---------------------------------------------------------------- global bans, settings, team names

test('agent Global Ban: host sets it in the lobby, capped by method; blocks everything', () => {
  const room = setup({ method: 'normal' });
  act(room, 'h', { type: 'updateSettings', settings: { agentGlobalBans: ['jett', 'raze', 'sage', 'omen'] } });
  assert.throws(() => act(room, 'h', { type: 'updateSettings', settings: { agentGlobalBans: ['jett', 'raze', 'sage', 'omen', 'sova'] } }), /最大4/);
  assert.throws(() => act(room, 'p1', { type: 'updateSettings', settings: { agentGlobalBans: [] } }), /ホスト/);
  // Fearless Bo5 needs 25 of 28 agents -> cap 3 -> trimmed
  act(room, 'h', { type: 'updateSettings', settings: { mode: 'map', series: 'bo5', method: 'fearless' } });
  assert.equal(room.settings.agentGlobalBans.length, 3);
  act(room, 'h', { type: 'updateSettings', settings: { mode: 'agent', method: 'ban', agentGlobalBans: ['jett'] } });
  act(room, 'h', { type: 'start' });
  const g = curGame(room.match);
  for (const type of ['ban', 'pick']) for (const team of ['A', 'B']) assert.match(agentError(room.match, g, team, type, 'jett'), /Global/);
});

test('count settings validated per range', () => {
  const room = setup({});
  assert.throws(() => act(room, 'h', { type: 'updateSettings', settings: { banCount: 4 } }), /1〜3/);
  assert.throws(() => act(room, 'h', { type: 'updateSettings', settings: { protectCount: 3 } }), /1〜2/);
  assert.throws(() => act(room, 'h', { type: 'updateSettings', settings: { blindBanCount: 1 } }), /2〜4/);
  act(room, 'h', { type: 'updateSettings', settings: { blindEnemyBanCount: 2 } });
});

test('team names: empty by default, host or that team captain can edit, defaults applied at start', () => {
  const room = setup({});
  assert.deepEqual(room.settings.teamNames, { A: '', B: '' });
  act(room, 'p1', { type: 'setTeamName', team: 'B', name: 'obsidian x' }); // p1 = B captain
  assert.throws(() => act(room, 'p2', { type: 'setTeamName', team: 'A', name: 'nope' }), /キャプテン/); // p2 = A member
  assert.throws(() => act(room, 'p1', { type: 'setTeamName', team: 'A', name: 'nope' }), /キャプテン/);
  act(room, 'h', { type: 'start' });
  assert.deepEqual(room.match.teamNames, { A: 'VORTEX', B: 'OBSIDIAN X' });
  assert.deepEqual(room.match.teamNameDefault, { A: true, B: false });
});

// ---------------------------------------------------------------- leaving / host

test('leave: host hands over, last player deletes the room, leaving mid-draft reassigns slots', () => {
  const room = setup({ method: 'normal' }, 2); // h,p2 in A ; p1,p3 in B
  act(room, 'h', { type: 'start' });
  const m = room.match;
  const r = act(room, 'h', { type: 'leave' });
  assert.equal(r.removed, 'h');
  assert.ok(room.players[room.hostId]);
  assert.notEqual(room.hostId, 'h');
  assert.ok(m.pickSlots.A.every((p) => p === 'p2'));
  assert.equal(m.captains.A, 'p2');
  // draft continues
  act(room, 'p2', { type: 'select', key: currentStep(room).key, agentId: 'jett' });
  for (const pid of ['p1', 'p2', 'p3'].filter((x) => x !== room.hostId)) act(room, pid, { type: 'leave' });
  const last = act(room, room.hostId, { type: 'leave' });
  assert.equal(last.deleteRoom, true);
});

test('host offline -> moves to the earliest online player', () => {
  const room = setup({});
  room.players.h.online = false;
  assert.equal(transferHostIfOffline(room, t), true);
  assert.equal(room.hostId, 'p1');
});

test('turn enforcement and stale keys', () => {
  const room = setup({ method: 'ban' });
  act(room, 'h', { type: 'start' });
  const m = room.match;
  const st = currentStep(room);
  assert.throws(() => act(room, m.captains.B, { type: 'select', key: st.key, agentId: 'jett' }), /ターン/);
  act(room, 'h', { type: 'select', key: st.key, agentId: 'jett' });
  assert.throws(() => act(room, 'h', { type: 'select', key: st.key, agentId: 'raze' }), (e) => e.code === 'STALE');
  assert.throws(() => act(room, 'p1', { type: 'start' }), ActionError);
});

test('pause / resume / abort; restart from lobby has no leftover history', () => {
  const room = setup({ method: 'ban' });
  act(room, 'h', { type: 'start' });
  act(room, 'h', { type: 'select', key: currentStep(room).key, agentId: 'jett' });
  act(room, 'h', { type: 'pause' });
  assert.throws(() => act(room, room.match.captains.B, { type: 'select', key: currentStep(room).key, agentId: 'raze' }), /一時停止/);
  act(room, 'h', { type: 'resume' });
  act(room, 'h', { type: 'abort' });
  act(room, 'h', { type: 'start' });
  assert.equal(curGame(room.match).actions.length, 0);
});

test('migrates rooms saved by the previous version', () => {
  const old = { id: 'X', hostId: 'h', status: 'drafting', settings: { systemId: 'ban_snake', timer: 45, mirror: true, hostOverride: false, teamNames: { A: 'ATTACKERS', B: 'Team K' } }, players: {}, order: { A: [], B: [] }, draft: { steps: [] } };
  migrateRoom(old);
  assert.equal(old.schema, 2);
  assert.equal(old.status, 'lobby');
  assert.equal(old.settings.method, 'ban');
  assert.equal(old.settings.order, 'snake');
  assert.equal(old.settings.timer, 45);
  assert.deepEqual(old.settings.teamNames, { A: '', B: 'Team K' });
  assert.equal(old.draft, undefined);
});

test('READY: only captains toggle it, both required to start, reset on team / rule changes', () => {
  const room = setup({});
  assert.throws(() => applyAction(room, 'p2', { type: 'setReady', ready: true }, ctx()), /キャプテン/); // p2 = A member
  applyAction(room, 'h', { type: 'setReady', ready: true }, ctx()); // A captain
  assert.throws(() => applyAction(room, 'h', { type: 'start' }, ctx()), /READY/);
  applyAction(room, 'p1', { type: 'setReady', ready: true }, ctx()); // B captain
  applyAction(room, 'p1', { type: 'setReady', ready: false }, ctx()); // can withdraw
  assert.throws(() => applyAction(room, 'h', { type: 'start' }, ctx()), /READY/);
  applyAction(room, 'p1', { type: 'setReady', ready: true }, ctx());
  applyAction(room, 'h', { type: 'updateSettings', settings: { order: 'snake' } }, ctx());
  assert.deepEqual(room.ready, { A: false, B: false });
  applyAction(room, 'h', { type: 'setReady', ready: true }, ctx());
  applyAction(room, 'p1', { type: 'setReady', ready: true }, ctx());
  applyAction(room, 'h', { type: 'start' }, ctx());
  assert.equal(room.status, 'drafting');
  assert.deepEqual(room.ready, { A: false, B: false });
});

test('host override is off by default', () => {
  const room = createRoom({ id: 'X', hostId: 'h', hostName: 'H', now: t });
  assert.equal(room.settings.hostOverride, false);
});

test('timeout keeps a selected (not locked) agent: sequential and simultaneous', () => {
  let room = setup({ method: 'normal' });
  act(room, 'h', { type: 'start' });
  act(room, 'h', { type: 'preview', id: 'sova' });
  autoResolve(room, ctx());
  assert.equal(curGame(room.match).actions[0].agentId, 'sova');
  room = setup({ method: 'blind_ban', blindBanCount: 2 });
  act(room, 'h', { type: 'start' });
  playUntilSim(room);
  const st = currentStep(room);
  const capB = room.match.captains.B;
  act(room, capB, { type: 'simPreview', key: st.key, team: 'B', slot: 3, agentId: 'yoru' });
  assert.ok(!JSON.stringify(viewFor(room, 'A', t)).includes('"yoru"'), 'tentative choice hidden from enemy');
  autoResolve(room, ctx());
  const res = buildResult(room, { id: 'R', now: t });
  assert.equal(res.games[0].teams.B.picks[3].agentId, 'yoru');
});
