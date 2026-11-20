// Integration tests: real HTTP server, multiple SSE clients, concurrency, restart recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { selectionError } from '../src/engine.js';

const quiet = { info() {}, warn() {}, error: console.error };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vdra-'));

class Client {
  constructor(base, roomId, pid, token) {
    Object.assign(this, { base, roomId, pid, token });
    this.state = null;
    this.events = 0;
    this.waiters = [];
    this.ac = new AbortController();
    this.kicked = false;
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
              this.state = JSON.parse(data);
              this.events++;
              this.waiters = this.waiters.filter((w) => !w(this.state));
            } else if (ev === 'kicked') this.kicked = true;
          }
        }
      } catch {}
    })();
    await this.until((s) => !!s);
    return this;
  }
  until(pred, ms = 3000) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for state')), ms);
      this.waiters.push((s) => (pred(s) ? (clearTimeout(t), resolve(s), true) : false));
    });
  }
  async act(action, actionId) {
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
  // teams: even index -> A, odd -> B
  await Promise.all(clients.map((c, i) => c.act({ type: 'setTeam', team: i % 2 ? 'B' : 'A' })));
  await clients[0].until((s) => s.order.A.length + s.order.B.length === n);
  return { roomId: created.roomId, clients };
}

function actorFor(state) {
  const d = state.draft;
  const step = d.steps[d.stepIndex];
  return step.type === 'pick' ? d.pickSlots[step.team][step.slot] : d.captains[step.team];
}

test('10 clients: full draft for all 8 systems, every client stays in sync', async () => {
  const dir = tmp();
  // this test fires hundreds of sequential requests from one IP, far faster than humans
  const limits = { ipPerSec: 100000, playerPerSec: 100000, createPerMin: 1000 };
  const app = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, offline: true, log: quiet, limits });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { systems } = await (await fetch(`${base}/api/systems`)).json();
    assert.equal(systems.length, 8);
    const { agents } = await (await fetch(`${base}/api/agents`)).json();
    const ids = agents.map((a) => a.id);
    const { clients } = await makeRoom(base, 10);
    const host = clients[0];
    const byPid = Object.fromEntries(clients.map((c) => [c.pid, c]));
    await host.act({ type: 'updateSettings', settings: { hostOverride: false, timer: 0 } });

    for (const sys of systems) {
      await host.act({ type: 'updateSettings', settings: { systemId: sys.id } });
      const r = await host.act({ type: 'start' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await host.until((s) => s.status === 'drafting');
      while (host.state.status === 'drafting') {
        const s = host.state;
        const step = s.draft.steps[s.draft.stepIndex];
        const agent = ids.find((a) => !selectionError(s.draft, step, a));
        const who = byPid[actorFor(s)];
        const res = await who.act({ type: 'select', stepIndex: step.i, agentId: agent });
        assert.equal(res.status, 200, `${sys.id} step ${step.i}: ${JSON.stringify(res.body)}`);
        await host.until((x) => x.version >= res.body.version);
      }
      assert.equal(host.state.status, 'finished');
      // every client converges on the same final version
      const v = host.state.version;
      await Promise.all(clients.map((c) => c.until((x) => x.version === v)));
      for (const c of clients) assert.deepEqual(c.state.draft.actions, host.state.draft.actions);
      const result = await (await fetch(`${base}/api/results/${host.state.resultId}`)).json();
      assert.equal(result.systemId, sys.id);
      assert.equal(result.teams.A.picks.length, 5);
      assert.equal(result.teams.B.picks.length, 5);
      await host.act({ type: 'backToLobby' });
      await host.until((s) => s.status === 'lobby');
    }
    const hist = await (await fetch(`${base}/api/rooms/${host.roomId}/results`)).json();
    assert.equal(hist.results.length, 8);
    clients.forEach((c) => c.close());
  } finally {
    await app.close();
  }
});

test('simultaneous clicks: only one selection is applied per step', async () => {
  const dir = tmp();
  const app = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, offline: true, log: quiet });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { clients } = await makeRoom(base, 4);
    const host = clients[0];
    await host.act({ type: 'updateSettings', settings: { systemId: 'ban_standard', timer: 0 } });
    await host.act({ type: 'start' });
    await host.until((s) => s.status === 'drafting');
    // Host (override) + captain A + B player all fire 20 requests at once on step 0
    const reqs = [];
    for (let i = 0; i < 20; i++) {
      for (const c of clients) reqs.push(c.act({ type: 'select', stepIndex: 0, agentId: ['jett', 'raze', 'omen', 'sova'][i % 4] }));
    }
    const results = await Promise.all(reqs);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    await host.until((s) => s.draft.stepIndex === 1);
    assert.equal(host.state.draft.actions.length, 1);
    // Same actionId retried -> idempotent (no error, no double apply)
    const s = host.state;
    const a1 = await host.act({ type: 'select', stepIndex: 1, agentId: 'viper' }, 'retry-1');
    const a2 = await host.act({ type: 'select', stepIndex: 1, agentId: 'viper' }, 'retry-1');
    assert.equal(a1.status, 200);
    assert.deepEqual(a1.body, a2.body);
    await host.until((x) => x.draft.stepIndex === 2);
    assert.equal(host.state.draft.actions.length, 2);
    assert.ok(s);
    clients.forEach((c) => c.close());
  } finally {
    await app.close();
  }
});

test('timer expiry auto-picks; disconnect + reconnect resumes; server restart restores the draft', async () => {
  const dir = tmp();
  let app = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, offline: true, log: quiet });
  let base = `http://127.0.0.1:${app.port}`;
  const { roomId, clients } = await makeRoom(base, 2);
  const host = clients[0];
  await host.act({ type: 'updateSettings', settings: { systemId: 'standard', timer: 15 } });
  await host.act({ type: 'start' });
  await host.until((s) => s.status === 'drafting');
  // Shorten the deadline (instead of waiting 15s) and re-arm the server timer
  app.rooms.get(roomId).room.draft.deadline = Date.now() + 200;
  app.reschedule(roomId);
  const s0 = await host.until((s) => s.draft.actions.length >= 1, 3000);
  assert.equal(s0.draft.actions[0].auto, true, 'timeout should auto-select');

  // Player 2 disconnects, then reconnects with the same credentials
  const p2 = clients[1];
  p2.close();
  await host.until((s) => s.players[p2.pid].online === false, 8000);
  const re = await post(`${base}/api/rooms/${roomId}/join`, { pid: p2.pid, token: p2.token, name: 'ignored' });
  assert.equal(re.body.rejoined, true);
  const p2b = await new Client(base, roomId, p2.pid, p2.token).connect();
  await host.until((s) => s.players[p2.pid].online === true);
  const stepNow = host.state.draft.stepIndex;
  const versionBefore = host.state.version;

  // Restart the server: state must come back from SQLite
  clients.forEach((c) => c.close());
  p2b.close();
  await app.close();
  app = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, offline: true, log: quiet });
  base = `http://127.0.0.1:${app.port}`;
  const h2 = await new Client(base, roomId, host.pid, host.token).connect();
  assert.equal(h2.state.status, 'drafting');
  assert.ok(h2.state.draft.stepIndex >= stepNow);
  assert.ok(h2.state.version >= versionBefore);
  const step = h2.state.draft.steps[h2.state.draft.stepIndex];
  const r = await h2.act({ type: 'select', stepIndex: step.i, agentId: 'killjoy' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  h2.close();
  await app.close();
});

test('auth, kick and bad input', async () => {
  const dir = tmp();
  const app = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, offline: true, log: quiet });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { roomId, clients } = await makeRoom(base, 3);
    const [host, p1] = clients;
    // wrong token
    const bad = await post(`${base}/api/rooms/${roomId}/action`, { pid: p1.pid, token: 'nope', action: { type: 'rename', name: 'x' } });
    assert.equal(bad.status, 401);
    // non-host cannot start
    assert.equal((await p1.act({ type: 'start' })).status, 409);
    // empty name rejected
    assert.equal((await post(`${base}/api/rooms/${roomId}/join`, { name: '   ' })).status, 409);
    // unknown room
    assert.equal((await fetch(`${base}/api/rooms/ZZZZZZ`)).status, 404);
    // kick
    await host.act({ type: 'kick', target: p1.pid });
    await host.until((s) => !s.players[p1.pid]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(p1.kicked, true);
    assert.equal((await p1.act({ type: 'rename', name: 'back' })).status, 401);
    // path traversal
    const tr = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.notEqual(tr.status, 200);
    clients.forEach((c) => c.close());
  } finally {
    await app.close();
  }
});
