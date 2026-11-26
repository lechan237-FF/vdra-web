// Integration tests: real HTTP server, multiple SSE clients, hidden-info isolation,
// concurrency, leave/host transfer, restart recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { agentError, curGame } from '../src/engine.js';

const quiet = { info() {}, warn() {}, error: console.error };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vdra-'));
const LIMITS = { ipPerSec: 100000, playerPerSec: 100000, createPerMin: 1000 };
const boot = (dir) => createApp({ port: 0, host: '127.0.0.1', dataDir: dir, offline: true, log: quiet, limits: LIMITS });

class Client {
  constructor(base, roomId, pid, token) {
    Object.assign(this, { base, roomId, pid, token });
    this.state = null;
    this.raw = []; // every raw SSE payload received (for leak checks)
    this.waiters = [];
    this.ac = new AbortController();
    this.left = false;
  }
  async connect() {
    const res = await fetch(`${this.base}/api/rooms/${this.roomId}/events?pid=${this.pid}&token=${encodeURIComponent(this.token)}`, { signal: this.ac.signal });
    assert.equal(res.status, 200);
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (ev === 'state') {
              this.raw.push(data);
              this.state = JSON.parse(data);
              this.waiters = this.waiters.filter((w) => !w(this.state));
            } else if (ev === 'left') this.left = true;
          }
        }
      } catch {}
    })();
    await this.until((s) => !!s);
    return this;
  }
  until(pred, ms = 4000) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for state')), ms);
      this.waiters.push((s) => (pred(s) ? (clearTimeout(t), resolve(s), true) : false));
    });
  }
  async act(action, actionId) {
    if (action?.type === 'start' && this.peers) {
      for (const c of this.peers) await c.raw_act({ type: 'setReady', ready: true }); // captains get READY, others ignored
    }
    return this.raw_act(action, actionId);
  }
  async raw_act(action, actionId) {
    const res = await fetch(`${this.base}/api/rooms/${this.roomId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: this.pid, token: this.token, action, actionId }),
    });
    return { status: res.status, body: await res.json() };
  }
  close() {
    this.ac.abort();
  }
}

const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

async function makeRoom(base, n = 10) {
  const created = (await post(`${base}/api/rooms`, { name: 'Host' })).body;
  const clients = [await new Client(base, created.roomId, created.pid, created.token).connect()];
  for (let i = 1; i < n; i++) {
    const j = (await post(`${base}/api/rooms/${created.roomId}/join`, { name: `Player${i}` })).body;
    clients.push(await new Client(base, created.roomId, j.pid, j.token).connect());
  }
  for (const [i, c] of clients.entries()) await c.act({ type: 'setTeam', team: i % 2 ? 'B' : 'A' });
  await clients[0].until((s) => s.order.A.length + s.order.B.length === n);
  for (const c of clients) c.peers = clients;
  return { roomId: created.roomId, clients };
}

function stepOf(s) {
  const m = s.match;
  if (m.phase === 'map') {
    const st = m.mapDraft.steps[m.mapDraft.stepIndex];
    return { ...st, kind: st.type === 'side' ? 'side' : 'map', key: `map:${m.mapDraft.stepIndex}` };
  }
  if (m.phase === 'between') return { kind: 'between' };
  const g = m.games[m.gameIndex];
  const st = g.steps[g.stepIndex];
  return { ...st, key: `g${g.index}:${g.stepIndex}` };
}

// drive a whole match through the HTTP API, each move made by the right client
async function driveMatch(host, byPid, agentIds) {
  let guard = 0;
  let maxVersion = 0; // highest version acknowledged by the server so far
  while (host.state.status === 'drafting' && guard++ < 400) {
    const s = host.state;
    const m = s.match;
    const st = stepOf(s);
    const v = s.version;
    if (st.kind === 'between') {
      const r = await host.act({ type: 'nextGame' });
      maxVersion = Math.max(maxVersion, r.body.version ?? 0);
    } else if (st.kind === 'map') {
      const id = m.mapDraft.pool.find((x) => !m.mapDraft.actions.some((a) => a.mapId === x && a.type !== 'side'));
      const r = await byPid[m.captains[st.team]].act({ type: 'select', key: st.key, mapId: id });
      maxVersion = Math.max(maxVersion, r.body.version ?? 0);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } else if (st.kind === 'side') {
      const r = await byPid[m.captains[st.team]].act({ type: 'select', key: st.key, side: 'def' });
      maxVersion = Math.max(maxVersion, r.body.version ?? 0);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } else if (st.kind === 'seq') {
      const g = curGame(m);
      const id = agentIds.find((a) => !agentError(m, g, st.team, st.type, a));
      const who = st.type === 'pick' ? m.pickSlots[st.team][st.slot] : m.captains[st.team];
      const r = await byPid[who].act({ type: 'select', key: st.key, agentId: id });
      maxVersion = Math.max(maxVersion, r.body.version ?? 0);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } else {
      // simultaneous: each slot by its own player, using ONLY that player's view
      let latest = Math.max(v, maxVersion);
      for (const team of ['A', 'B']) {
        for (let slot = 0; slot < st.count; slot++) {
          const who = st.type === 'pick' ? m.pickSlots[team][slot] : m.captains[team];
          const c = byPid[who];
          await c.until((x) => x.version >= latest);
          const cm = c.state.match;
          const g = cm.games[cm.gameIndex];
          if (c.state.status !== 'drafting' || !g.pending || g.pending.step !== st.i) break;
          if (g.pending[team].done || g.pending[team].sel[slot]) continue;
          const own = g.pending[team].sel.filter(Boolean).map((x) => x.agentId);
          const id = agentIds.find((a) => !agentError(cm, g, team, st.type, a, { ownPending: own }));
          const r = await c.act({ type: 'select', key: st.key, team, slot, agentId: id });
          assert.equal(r.status, 200, JSON.stringify({ body: r.body, key: st.key, team, slot, phase: cm.phase, gi: cm.gameIndex, status: c.state.status }));
          latest = maxVersion = Math.max(maxVersion, r.body.version);
        }
      }
    }
    await host.until((x) => x.version >= Math.max(v + 1, maxVersion) || x.status !== 'drafting');
  }
  assert.equal(host.state.status, 'finished');
}

test('10 clients: every method (agent-only, Fearless Bo3, one Bo5 map series) stays in sync', async () => {
  const dir = tmp();
  const app = await boot(dir);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const meta = await (await fetch(`${base}/api/methods`)).json();
    assert.equal(meta.methods.length, 8);
    const { agents } = await (await fetch(`${base}/api/agents`)).json();
    const { maps } = await (await fetch(`${base}/api/maps`)).json();
    const ids = agents.map((a) => a.id);
    const { clients } = await makeRoom(base, 10);
    const host = clients[0];
    const byPid = Object.fromEntries(clients.map((c) => [c.pid, c]));
    await host.act({ type: 'updateSettings', settings: { hostOverride: false, timer: 0 } });
    const ban5 = maps.slice(0, maps.length - meta.pool).map((m) => m.id);
    const only = process.env.ONLY;
    let runs = [
      ...meta.methods.filter((m) => !m.seriesOnly).map((m) => ({ mode: 'agent', method: m.id, order: m.no % 2 ? 'snake' : 'standard' })),
      { mode: 'map', series: 'bo3', method: 'fearless', mapGlobalBans: ban5 },
      { mode: 'map', series: 'bo5', method: 'protect_ban', order: 'snake', mapGlobalBans: ban5 },
    ];
    if (only) runs = runs.filter((r) => r.method === only);
    for (const settings of runs) {
      const u = await host.act({ type: 'updateSettings', settings });
      assert.equal(u.status, 200, JSON.stringify(u.body));
      const r = await host.act({ type: 'start' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await host.until((s) => s.status === 'drafting');
      await Promise.all(clients.map((c) => c.until((s) => s.status === 'drafting')));
      await driveMatch(host, byPid, ids);
      const v = host.state.version;
      await Promise.all(clients.map((c) => c.until((x) => x.version === v)));
      for (const c of clients) assert.deepEqual(c.state.match.games.map((g) => g.actions), host.state.match.games.map((g) => g.actions));
      const result = await (await fetch(`${base}/api/results/${host.state.resultId}`)).json();
      assert.equal(result.method, settings.method);
      assert.equal(result.games.length, settings.series === 'bo5' ? 5 : settings.series === 'bo3' ? 3 : 1);
      for (const g of result.games) for (const t of ['A', 'B']) assert.equal(g.teams[t].picks.length, 5);
      await host.act({ type: 'backToLobby' });
      await host.until((s) => s.status === 'lobby');
    }
    clients.forEach((c) => c.close());
  } finally {
    await app.close();
  }
});

test('blind: the other team never receives hidden selections over the wire', async () => {
  const dir = tmp();
  const app = await boot(dir);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { roomId, clients } = await makeRoom(base, 4);
    const spec = await new Client(base, roomId, ...Object.values((await post(`${base}/api/rooms/${roomId}/join`, { name: 'Watcher' })).body).slice(1, 3)).connect();
    const [host, b1, a2, b3] = clients;
    await host.act({ type: 'updateSettings', settings: { method: 'blind_enemy_ban', timer: 0 } });
    await host.act({ type: 'start' });
    await host.until((s) => s.status === 'drafting');
    const key = 'g0:0';
    // Team A bans 4 unusual agents; B / spectator must not see them until reveal
    const secret = ['vyse', 'tejo', 'waylay', 'veto'];
    for (const id of secret) assert.equal((await host.act({ type: 'select', key, team: 'A', agentId: id })).status, 200);
    await a2.until((s) => s.match.games[0].pending.A.done);
    await b1.until((s) => s.match.games[0].pending.A.done);
    await spec.until((s) => s.match?.games[0].pending?.A.done);
    for (const c of [b1, b3, spec]) for (const raw of c.raw) for (const id of secret) assert.ok(!raw.includes(`"${id}"`), `leak of ${id}`);
    assert.ok(a2.raw.some((r) => r.includes('"vyse"')), 'teammate sees own team selection');
    // B cannot select for A, even with a forged request
    assert.equal((await b1.act({ type: 'select', key, team: 'A', agentId: 'jett' })).status, 409);
    for (const id of ['jett', 'raze', 'omen', 'sova']) await b1.act({ type: 'select', key, team: 'B', agentId: id });
    const s = await b1.until((x) => x.match.games[0].stepIndex === 1);
    assert.deepEqual(s.match.games[0].actions.filter((a) => a.team === 'A').map((a) => a.agentId), secret);
    [...clients, spec].forEach((c) => c.close());
  } finally {
    await app.close();
  }
});

test('simultaneous clicks: only one selection applies per step; retries are idempotent', async () => {
  const dir = tmp();
  const app = await boot(dir);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { clients } = await makeRoom(base, 4);
    const host = clients[0];
    await host.act({ type: 'updateSettings', settings: { method: 'ban', timer: 0, hostOverride: true } });
    await host.act({ type: 'start' });
    await host.until((s) => s.status === 'drafting');
    const reqs = [];
    for (let i = 0; i < 20; i++) for (const c of clients) reqs.push(c.act({ type: 'select', key: 'g0:0', agentId: ['jett', 'raze', 'omen', 'sova'][i % 4] }));
    const results = await Promise.all(reqs);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    await host.until((s) => s.match.games[0].stepIndex === 1);
    const a1 = await host.act({ type: 'select', key: 'g0:1', agentId: 'viper' }, 'retry-1');
    const a2 = await host.act({ type: 'select', key: 'g0:1', agentId: 'viper' }, 'retry-1');
    assert.equal(a1.status, 200);
    assert.deepEqual(a1.body, a2.body);
    await host.until((x) => x.match.games[0].stepIndex === 2);
    assert.equal(host.state.match.games[0].actions.length, 2);
    clients.forEach((c) => c.close());
  } finally {
    await app.close();
  }
});

test('leave & host: host leaving hands over live, disconnect moves host, last leave deletes the room', async () => {
  const dir = tmp();
  const app = await boot(dir);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { roomId, clients } = await makeRoom(base, 3);
    const [host, p1, p2] = clients;
    // host disconnects -> host role moves to p1 (earliest joined online)
    host.close();
    await p1.until((s) => s.hostId === p1.pid, 8000);
    // p1 (host now) leaves -> p2 becomes host, p1's stream is closed
    const r = await p1.act({ type: 'leave' });
    assert.equal(r.status, 200);
    await p2.until((s) => !s.players[p1.pid]);
    assert.ok(p2.state.hostId === p2.pid || p2.state.hostId === host.pid);
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(p1.left, true);
    assert.equal((await p1.act({ type: 'rename', name: 'x' })).status, 401);
    // remaining players leave -> room deleted
    const hostRe = await post(`${base}/api/rooms/${roomId}/join`, { pid: host.pid, token: host.token, name: '-' });
    assert.equal(hostRe.body.rejoined, true);
    await new Client(base, roomId, host.pid, host.token).act({ type: 'leave' });
    const last = await p2.act({ type: 'leave' });
    assert.equal(last.body.deleted, true);
    assert.equal((await fetch(`${base}/api/rooms/${roomId}`)).status, 404);
    clients.forEach((c) => c.close());
  } finally {
    await app.close();
  }
});

test('timer expiry auto-resolves; restart restores a map series in progress', async () => {
  const dir = tmp();
  let app = await boot(dir);
  let base = `http://127.0.0.1:${app.port}`;
  const { roomId, clients } = await makeRoom(base, 2);
  const host = clients[0];
  const { maps } = await (await fetch(`${base}/api/maps`)).json();
  await host.act({ type: 'updateSettings', settings: { mode: 'map', series: 'bo3', method: 'blind_ban', timer: 15, hostOverride: true, mapGlobalBans: maps.slice(0, maps.length - 7).map((m) => m.id) } });
  await host.act({ type: 'start' });
  await host.until((s) => s.status === 'drafting');
  app.rooms.get(roomId).room.match.deadline = Date.now() + 150;
  app.reschedule(roomId);
  const s0 = await host.until((s) => s.match.mapDraft.actions.length >= 1, 3000);
  assert.equal(s0.match.mapDraft.actions[0].auto, true);
  const v = host.state.version;
  clients.forEach((c) => c.close());
  await app.close();
  app = await boot(dir);
  base = `http://127.0.0.1:${app.port}`;
  const h2 = await new Client(base, roomId, host.pid, host.token).connect();
  assert.equal(h2.state.status, 'drafting');
  assert.equal(h2.state.match.phase, 'map');
  assert.ok(h2.state.version >= v);
  const st = stepOf(h2.state);
  const body = st.kind === 'side' ? { side: 'atk' } : { mapId: h2.state.match.mapDraft.pool.find((x) => !h2.state.match.mapDraft.actions.some((a) => a.mapId === x)) };
  const r = await h2.act({ type: 'select', key: st.key, ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  h2.close();
  await app.close();
});

test('auth, permissions and bad input', async () => {
  const dir = tmp();
  const app = await boot(dir);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { roomId, clients } = await makeRoom(base, 3);
    const [host, p1, p2] = clients;
    assert.equal((await post(`${base}/api/rooms/${roomId}/action`, { pid: p1.pid, token: 'nope', action: { type: 'rename', name: 'x' } })).status, 401);
    assert.equal((await p1.act({ type: 'start' })).status, 409);
    assert.equal((await p2.act({ type: 'setTeamName', team: 'A', name: 'X' })).status, 409); // not captain of A
    assert.equal((await p1.act({ type: 'setTeamName', team: 'B', name: 'Iron' })).status, 200); // B captain
    assert.equal((await post(`${base}/api/rooms/${roomId}/join`, { name: '   ' })).status, 409);
    assert.equal((await fetch(`${base}/api/rooms/ZZZZZZ`)).status, 404);
    await host.act({ type: 'kick', target: p1.pid });
    await host.until((s) => !s.players[p1.pid]);
    assert.notEqual((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 200);
    clients.forEach((c) => c.close());
  } finally {
    await app.close();
  }
});
