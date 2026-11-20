import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEMS, buildSteps } from '../src/systems.js';
import { createRoom, addPlayer, applyAction, autoSelect, currentStep, buildResult, selectionError, ActionError } from '../src/engine.js';

const AGENTS = ['astra', 'breach', 'brimstone', 'chamber', 'clove', 'cypher', 'deadlock', 'fade', 'gekko', 'harbor', 'iso', 'jett', 'kayo', 'killjoy', 'neon', 'omen', 'phoenix', 'raze', 'reyna', 'sage', 'skye', 'sova', 'tejo', 'viper', 'vyse', 'waylay', 'yoru', 'veto'];
let t = 1000;
const ctx = () => ({ now: (t += 10), agentIds: AGENTS });

function setup(systemId, perTeam = 5) {
  const room = createRoom({ id: 'TEST01', hostId: 'h', hostName: 'Host', now: t });
  applyAction(room, 'h', { type: 'setTeam', team: 'A' }, ctx());
  for (let i = 1; i < perTeam * 2; i++) {
    const id = 'p' + i;
    addPlayer(room, { id, name: 'P' + i, now: t });
    applyAction(room, id, { type: 'setTeam', team: i % 2 ? 'B' : 'A' }, ctx());
  }
  applyAction(room, 'h', { type: 'updateSettings', settings: { systemId } }, ctx());
  applyAction(room, 'h', { type: 'start' }, ctx());
  return room;
}

// Act as the correct player (not host override) for every step.
function actor(room) {
  const step = currentStep(room);
  const d = room.draft;
  return step.type === 'pick' ? d.pickSlots[step.team][step.slot] : d.captains[step.team];
}
function onlineAll(room) {
  for (const p of Object.values(room.players)) p.online = true;
}

test('every system: 5 picks per team, step counts, completes', () => {
  for (const sys of SYSTEMS) {
    const steps = buildSteps(sys);
    assert.equal(steps.filter((s) => s.type === 'pick' && s.team === 'A').length, 5, sys.id);
    assert.equal(steps.filter((s) => s.type === 'pick' && s.team === 'B').length, 5, sys.id);
    const room = setup(sys.id);
    onlineAll(room);
    room.settings.hostOverride = false;
    let guard = 0;
    while (room.status === 'drafting' && guard++ < 100) {
      const step = currentStep(room);
      const pid = actor(room);
      // choose the first valid agent
      const agent = AGENTS.find((a) => !selectionError(room.draft, step, a));
      applyAction(room, pid, { type: 'select', stepIndex: step.i, agentId: agent }, ctx());
    }
    assert.equal(room.status, 'finished', sys.id);
    const res = buildResult(room, { id: 'R', now: t });
    assert.equal(res.teams.A.picks.length, 5);
    assert.equal(res.teams.B.picks.length, 5);
    if (!sys.mirror) {
      const all = [...res.teams.A.picks, ...res.teams.B.picks].map((p) => p.agentId);
      assert.equal(new Set(all).size, 10, `${sys.id} exclusive picks`);
    }
  }
});

test('snake order is A B B A A B B A A B', () => {
  const sys = SYSTEMS.find((s) => s.id === 'snake');
  assert.equal(buildSteps(sys).map((s) => s.team).join(''), 'ABBAABBAAB');
});

test('turn enforcement, stale step and duplicate selection are rejected', () => {
  const room = setup('ban_standard');
  onlineAll(room);
  room.settings.hostOverride = false;
  const step = currentStep(room); // ban by A captain (h)
  // B player cannot act on A's turn
  assert.throws(() => applyAction(room, room.draft.captains.B, { type: 'select', stepIndex: 0, agentId: 'jett' }, ctx()), /ターン/);
  applyAction(room, 'h', { type: 'select', stepIndex: step.i, agentId: 'jett' }, ctx());
  // same click arriving twice (stale stepIndex)
  assert.throws(() => applyAction(room, 'h', { type: 'select', stepIndex: 0, agentId: 'raze' }, ctx()), (e) => e.code === 'STALE');
  // B cannot ban jett again
  assert.throws(() => applyAction(room, room.draft.captains.B, { type: 'select', stepIndex: 1, agentId: 'jett' }, ctx()), (e) => e.code === 'INVALID_AGENT');
  // unknown agent
  assert.throws(() => applyAction(room, room.draft.captains.B, { type: 'select', stepIndex: 1, agentId: 'zzz' }, ctx()), ActionError);
});

test('mirror: standard allows same agent on both teams, not twice in one team', () => {
  const room = setup('standard');
  onlineAll(room);
  applyAction(room, actor(room), { type: 'select', stepIndex: 0, agentId: 'jett' }, ctx());
  applyAction(room, actor(room), { type: 'select', stepIndex: 1, agentId: 'jett' }, ctx()); // B mirrors
  assert.throws(() => applyAction(room, actor(room), { type: 'select', stepIndex: 2, agentId: 'jett' }, ctx()), /自チーム/);
});

test('protect: opponent cannot ban or pick a protected agent', () => {
  const room = setup('protect');
  onlineAll(room);
  applyAction(room, actor(room), { type: 'select', stepIndex: 0, agentId: 'sova' }, ctx()); // A protects sova
  applyAction(room, actor(room), { type: 'select', stepIndex: 1, agentId: 'omen' }, ctx()); // B protects omen
  // A bans: cannot ban omen (B protected) nor sova (own)
  assert.throws(() => applyAction(room, actor(room), { type: 'select', stepIndex: 2, agentId: 'omen' }, ctx()), /Protect/);
  assert.throws(() => applyAction(room, actor(room), { type: 'select', stepIndex: 2, agentId: 'sova' }, ctx()), /Protect/);
  const d = room.draft;
  const pickStepB = d.steps.find((s) => s.type === 'pick' && s.team === 'B');
  assert.ok(selectionError(d, pickStepB, 'sova'));
  assert.equal(selectionError(d, pickStepB, 'omen'), null);
});

test('global ban blocks everything afterwards', () => {
  const room = setup('full');
  onlineAll(room);
  applyAction(room, actor(room), { type: 'select', stepIndex: 0, agentId: 'chamber' }, ctx());
  const d = room.draft;
  for (const s of d.steps.slice(1)) assert.ok(selectionError(d, s, 'chamber'), s.type);
});

test('tournament: phase-2 ban cannot target picked agents', () => {
  const room = setup('tournament');
  onlineAll(room);
  const picked = [];
  while (currentStep(room).i < 10) {
    const step = currentStep(room);
    const agent = AGENTS.find((a) => !selectionError(room.draft, step, a));
    if (step.type === 'pick') picked.push(agent);
    applyAction(room, actor(room), { type: 'select', stepIndex: step.i, agentId: agent }, ctx());
  }
  const step = currentStep(room);
  assert.equal(step.type, 'ban');
  assert.ok(selectionError(room.draft, step, picked[0]));
});

test('timeout auto-selects a valid agent and prefers hovered agent', () => {
  const room = setup('ban_snake');
  onlineAll(room);
  applyAction(room, 'h', { type: 'preview', agentId: 'viper' }, ctx());
  autoSelect(room, AGENTS, { now: (t += 10) });
  assert.equal(room.draft.actions[0].agentId, 'viper');
  assert.equal(room.draft.actions[0].auto, true);
  autoSelect(room, AGENTS, { now: (t += 10), random: () => 0 });
  assert.ok(room.draft.actions[1].agentId && room.draft.actions[1].agentId !== 'viper');
});

test('fallback: offline actor -> captain can act; non-team player cannot', () => {
  const room = setup('standard');
  onlineAll(room);
  room.settings.hostOverride = false;
  applyAction(room, actor(room), { type: 'select', stepIndex: 0, agentId: 'jett' }, ctx()); // A
  applyAction(room, actor(room), { type: 'select', stepIndex: 1, agentId: 'sage' }, ctx()); // B
  // step 2: A slot 1 (a non-captain). Make them offline.
  const slotPlayer = actor(room);
  assert.notEqual(slotPlayer, room.draft.captains.A);
  // captain cannot act while slot player is online
  assert.throws(() => applyAction(room, 'h', { type: 'select', stepIndex: 2, agentId: 'omen' }, ctx()), /ターン/);
  room.players[slotPlayer].online = false;
  applyAction(room, 'h', { type: 'select', stepIndex: 2, agentId: 'omen' }, ctx());
  assert.equal(room.draft.actions[2].slotPlayer, slotPlayer);
});

test('fewer players than 5: members rotate through pick slots', () => {
  const room = setup('standard', 2);
  assert.deepEqual(room.draft.pickSlots.A.length, 5);
  assert.equal(new Set(room.draft.pickSlots.A).size, 2);
});

test('lobby permissions and pause/resume', () => {
  const room = setup('standard');
  assert.throws(() => applyAction(room, 'p1', { type: 'start' }, ctx()), /ホスト/);
  assert.throws(() => applyAction(room, 'h', { type: 'updateSettings', settings: { timer: 45 } }, ctx()), /ドラフト中/);
  applyAction(room, 'h', { type: 'pause' }, ctx());
  assert.equal(room.status, 'paused');
  assert.throws(() => applyAction(room, 'h', { type: 'select', stepIndex: 0, agentId: 'jett' }, ctx()), /一時停止/);
  applyAction(room, 'h', { type: 'resume' }, ctx());
  assert.ok(room.draft.deadline > t);
  applyAction(room, 'h', { type: 'abort' }, ctx());
  assert.equal(room.status, 'lobby');
});
