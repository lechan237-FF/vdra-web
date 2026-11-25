// HTTP server: static files, REST API, Server-Sent Events for real-time sync.
// Zero external dependencies (Node >= 22.13).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Store } from './db.js';
import { AgentStore } from './agents.js';
import { MapStore, SERIES_POOL } from './maps.js';
import { publicMethods, COUNT_SETTINGS, MAX_AGENT_GLOBAL_BANS } from './methods.js';
import {
  ActionError,
  applyAction,
  addPlayer,
  autoResolve,
  buildResult,
  createRoom,
  migrateRoom,
  transferHostIfOffline,
  viewFor,
  MAX_PLAYERS,
  SERIES,
  DEFAULT_TEAM_NAMES,
  BETWEEN_MS,
} from './engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // idle rooms are removed after 24h
const OFFLINE_GRACE_MS = 4000; // short disconnects (reload, network blip) don't flip "offline"
const HEARTBEAT_MS = 20000;
const TIMER_GRACE_MS = 300; // network latency allowance after the deadline

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randId = (n, chars = ID_CHARS) => {
  const bytes = crypto.randomBytes(n);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
};
const newToken = () => crypto.randomBytes(24).toString('base64url');
const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

export async function createApp({
  port = 3000,
  host = '0.0.0.0',
  dataDir = path.join(ROOT, 'data'),
  dbFile,
  offline = false,
  log = console,
  now: clock = () => Date.now(),
  limits = { ipPerSec: 300, playerPerSec: 30, createPerMin: 20 },
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new Store(dbFile || path.join(dataDir, 'vdra.db'));
  const agents = new AgentStore(dataDir, { offline, log });
  const maps = new MapStore(dataDir, { offline, log });
  await Promise.all([agents.init(), maps.init()]);
  const ctxBase = () => ({ now: clock(), agentIds: agents.ids, mapIds: maps.ids });

  /** @type {Map<string, {room:any, tokens:Record<string,string>, clients:Set<any>, conn:Map<string,number>, offlineTimers:Map<string,any>, timer:any, recent:Map<string,any>}>} */
  const rooms = new Map();

  const makeEntry = (room, tokens) => ({
    room,
    tokens,
    clients: new Set(),
    conn: new Map(),
    offlineTimers: new Map(),
    timer: null,
    recent: new Map(),
    offlineSince: new Map(),
  });

  // ------------------------------------------------------------ restore
  for (const { room, tokens } of store.loadRooms()) {
    migrateRoom(room); // rooms saved by the previous version
    for (const p of Object.values(room.players)) p.online = false;
    const entry = makeEntry(room, tokens);
    for (const pid of Object.keys(room.players)) entry.offlineSince.set(pid, clock());
    rooms.set(room.id, entry);
    schedule(entry); // overdue deadlines resolve immediately
    // give everyone a moment to reconnect, then make sure the host is someone online
    setTimeout(() => checkHost(entry), OFFLINE_GRACE_MS + 2000).unref?.();
  }
  if (rooms.size) log.info?.(`[rooms] restored ${rooms.size} room(s) from database`);

  // ------------------------------------------------------------ helpers
  function persist(entry) {
    try {
      store.saveRoom(entry.room, entry.tokens);
    } catch (e) {
      log.error?.('[db] save failed', e);
    }
  }

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Each client receives the view of its own team: hidden (blind) selections of the
  // other team never leave the server.
  function broadcast(entry) {
    const now = clock();
    const cache = {};
    for (const c of entry.clients) {
      const team = entry.room.players[c.pid]?.team ?? 'S';
      cache[team] ||= `event: state\ndata: ${JSON.stringify(viewFor(entry.room, team === 'S' ? null : team, now))}\n\n`;
      c.res.write(cache[team]);
    }
  }

  function checkHost(entry) {
    if (!rooms.has(entry.room.id)) return;
    const hid = entry.room.hostId;
    const h = entry.room.players[hid];
    if (h && h.online) return;
    if (clock() - (entry.offlineSince.get(hid) ?? 0) < OFFLINE_GRACE_MS) return;
    if (transferHostIfOffline(entry.room, clock())) {
      persist(entry);
      broadcast(entry);
    }
  }

  function deleteRoom(entry) {
    clearTimeout(entry.timer);
    for (const c of [...entry.clients]) {
      send(c.res, 'left', { deleted: true });
      c.res.end();
    }
    entry.clients.clear();
    rooms.delete(entry.room.id);
    store.deleteRoom(entry.room.id);
  }

  function finalizeIfFinished(entry) {
    const room = entry.room;
    if (room.status !== 'finished' || room.resultId || !room.match) return;
    const id = randId(10);
    const result = buildResult(room, { id, now: clock() });
    store.saveResult(result);
    room.resultId = id;
    room.history = [id, ...(room.history || [])].slice(0, 50);
  }

  function schedule(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    const { room } = entry;
    if (room.status !== 'drafting' || !room.match?.deadline) return;
    const deadline = room.match.deadline;
    const delay = Math.max(0, deadline - clock() + TIMER_GRACE_MS);
    entry.timer = setTimeout(() => {
      if (!rooms.has(room.id)) return;
      if (room.status !== 'drafting' || room.match?.deadline !== deadline) return schedule(entry);
      try {
        autoResolve(room, ctxBase());
      } catch (e) {
        log.error?.('[timer] autoResolve failed', e);
      }
      finalizeIfFinished(entry);
      persist(entry);
      broadcast(entry);
      schedule(entry);
    }, delay);
    entry.timer.unref?.();
  }

  function setOnline(entry, pid, online) {
    const p = entry.room.players[pid];
    if (!p || p.online === online) return;
    p.online = online;
    if (!online) entry.offlineSince.set(pid, clock());
    // The host role moves as soon as the host is disconnected (after the short reload grace).
    if (!online && entry.room.hostId === pid && transferHostIfOffline(entry.room, clock())) persist(entry);
    broadcast(entry);
  }

  function auth(entry, pid, token) {
    return !!pid && entry.tokens[pid] && safeEq(entry.tokens[pid], token);
  }

  // ------------------------------------------------------------ rate limit (per IP)
  const buckets = new Map();
  function rateOk(ip, key, limit, windowMs) {
    const k = `${ip}|${key}`;
    const t = clock();
    let b = buckets.get(k);
    if (!b || t - b.start > windowMs) b = { start: t, n: 0 };
    b.n++;
    buckets.set(k, b);
    return b.n <= limit;
  }

  // ------------------------------------------------------------ cleanup
  const cleanup = setInterval(() => {
    const before = clock() - ROOM_TTL_MS;
    for (const [id, entry] of rooms) {
      if (entry.room.updatedAt < before && entry.clients.size === 0) {
        clearTimeout(entry.timer);
        rooms.delete(id);
        store.deleteRoom(id);
      }
    }
    for (const id of store.staleRoomIds(before)) if (!rooms.has(id)) store.deleteRoom(id);
    const bt = clock();
    for (const [k, b] of buckets) if (bt - b.start > 120000) buckets.delete(k);
  }, 10 * 60 * 1000);
  cleanup.unref?.();

  // ------------------------------------------------------------ HTTP
  const json = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(s),
    });
    res.end(s);
  };
  const err = (res, status, code, message) => json(res, status, { error: code, message });

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) {
          reject(new ActionError('TOO_LARGE', 'リクエストが大きすぎます'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new ActionError('BAD_JSON', '不正なリクエストです'));
        }
      });
      req.on('error', reject);
    });

  function serveStatic(req, res, pathname) {
    let rel = pathname;
    const isPage = rel === '/' || /^\/(room|r)\/[A-Za-z0-9]+\/?$/.test(rel);
    if (isPage) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return err(res, 403, 'FORBIDDEN', 'Forbidden');
    fs.stat(file, (e, st) => {
      if (e || !st.isFile()) return err(res, 404, 'NOT_FOUND', 'Not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  function openEvents(req, res, entry, pid) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const client = { res, pid };
    entry.clients.add(client);
    entry.conn.set(pid, (entry.conn.get(pid) || 0) + 1);
    clearTimeout(entry.offlineTimers.get(pid));
    const p = entry.room.players[pid];
    if (p && !p.online) p.online = true;
    checkHost(entry); // a host that stayed offline is replaced by someone who is here
    broadcast(entry); // also delivers the initial state to this client

    const hb = setInterval(() => res.write(`: hb ${clock()}\n\n`), HEARTBEAT_MS);
    hb.unref?.();
    const close = () => {
      clearInterval(hb);
      if (!entry.clients.delete(client)) return;
      const n = (entry.conn.get(pid) || 1) - 1;
      entry.conn.set(pid, n);
      if (n <= 0) {
        entry.offlineTimers.set(
          pid,
          setTimeout(() => {
            if ((entry.conn.get(pid) || 0) <= 0) setOnline(entry, pid, false);
          }, OFFLINE_GRACE_MS)
        );
      }
    };
    req.on('close', close);
    res.on('error', close);
  }

  function kickClients(entry, pid) {
    for (const c of [...entry.clients]) {
      if (c.pid === pid) {
        send(c.res, 'left', {});
        c.res.end();
        entry.clients.delete(c);
      }
    }
    entry.conn.delete(pid);
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const ip = req.socket.remoteAddress || '?';
    const m = req.method;

    // Generous per-IP limit (players behind one router share an IP); a tighter per-player limit is applied to actions.
    if (m === 'POST' && !rateOk(ip, 'post', limits.ipPerSec, 1000)) return err(res, 429, 'RATE', '操作が多すぎます。少し待ってください');

    if (parts[1] === 'health') return json(res, 200, { ok: true, rooms: rooms.size, agents: agents.ids.length, maps: maps.ids.length });
    if (parts[1] === 'maps' && m === 'GET') return json(res, 200, maps.publicData());
    if (parts[1] === 'agents' && m === 'GET') return json(res, 200, agents.publicData());
    if (parts[1] === 'methods' && m === 'GET')
      return json(res, 200, {
        methods: publicMethods(),
        countSettings: COUNT_SETTINGS,
        series: SERIES,
        pool: SERIES_POOL,
        defaultTeamNames: DEFAULT_TEAM_NAMES,
        maxAgentGlobalBans: MAX_AGENT_GLOBAL_BANS,
        betweenMs: BETWEEN_MS,
      });

    if (parts[1] === 'results' && parts[2] && m === 'GET') {
      const r = store.getResult(parts[2]);
      return r ? json(res, 200, r) : err(res, 404, 'NOT_FOUND', '結果が見つかりません');
    }

    if (parts[1] !== 'rooms') return err(res, 404, 'NOT_FOUND', 'Not found');

    // POST /api/rooms  -> create
    if (parts.length === 2 && m === 'POST') {
      if (!rateOk(ip, 'create', limits.createPerMin, 60000)) return err(res, 429, 'RATE', 'ルーム作成が多すぎます');
      const body = await readBody(req);
      let id;
      do id = randId(6);
      while (rooms.has(id));
      const pid = randId(12);
      const room = createRoom({ id, hostId: pid, hostName: body.name, now: clock() });
      const entry = makeEntry(room, { [pid]: newToken() });
      rooms.set(id, entry);
      persist(entry);
      return json(res, 200, { roomId: id, pid, token: entry.tokens[pid] });
    }

    const roomId = String(parts[2] || '').toUpperCase();
    const entry = rooms.get(roomId);
    if (!entry) return err(res, 404, 'NO_ROOM', 'ルームが見つかりません');
    const room = entry.room;

    // GET /api/rooms/:id -> summary for the join screen
    if (parts.length === 3 && m === 'GET') {
      return json(res, 200, {
        id: room.id,
        status: room.status,
        players: Object.keys(room.players).length,
        max: MAX_PLAYERS,
        host: room.players[room.hostId]?.name ?? null,
      });
    }

    // POST /api/rooms/:id/join
    if (parts[3] === 'join' && m === 'POST') {
      const body = await readBody(req);
      if (body.pid && auth(entry, body.pid, body.token) && room.players[body.pid]) {
        return json(res, 200, { roomId, pid: body.pid, token: body.token, rejoined: true });
      }
      const pid = randId(12);
      addPlayer(room, { id: pid, name: body.name, now: clock() });
      entry.tokens[pid] = newToken();
      persist(entry);
      broadcast(entry);
      return json(res, 200, { roomId, pid, token: entry.tokens[pid] });
    }

    // GET /api/rooms/:id/events  (SSE)
    if (parts[3] === 'events' && m === 'GET') {
      const pid = url.searchParams.get('pid');
      const token = url.searchParams.get('token');
      if (!auth(entry, pid, token) || !room.players[pid]) return err(res, 401, 'AUTH', '参加情報が無効です');
      return openEvents(req, res, entry, pid);
    }

    // GET /api/rooms/:id/results
    if (parts[3] === 'results' && m === 'GET') {
      return json(res, 200, { results: store.roomResults(roomId) });
    }

    // POST /api/rooms/:id/action
    if (parts[3] === 'action' && m === 'POST') {
      const body = await readBody(req);
      const { pid, token, action } = body;
      if (!auth(entry, pid, token)) return err(res, 401, 'AUTH', '参加情報が無効です');
      if (!rateOk(pid, 'action', limits.playerPerSec, 1000)) return err(res, 429, 'RATE', '操作が多すぎます。少し待ってください');
      // Idempotency: retried requests (e.g. after a network blip) return the first answer.
      const aid = typeof body.actionId === 'string' ? body.actionId.slice(0, 64) : null;
      if (aid && entry.recent.has(`${pid}:${aid}`)) return json(res, 200, entry.recent.get(`${pid}:${aid}`));

      // Node runs this synchronously: actions on one room are naturally serialized,
      // so two simultaneous clicks can never both apply to the same step.
      const r = applyAction(room, pid, action, ctxBase());
      if (r.deleteRoom) {
        deleteRoom(entry);
        return json(res, 200, { ok: true, deleted: true });
      }
      if (r.changed) {
        if (!r.light) {
          finalizeIfFinished(entry);
          persist(entry);
          schedule(entry);
        }
        if (r.removed) {
          // kicked or left: credentials are revoked and their streams closed
          delete entry.tokens[r.removed];
          entry.offlineSince.delete(r.removed);
          kickClients(entry, r.removed);
          persist(entry);
        }
        broadcast(entry);
      }
      const answer = { ok: true, version: room.version };
      if (aid) {
        entry.recent.set(`${pid}:${aid}`, answer);
        if (entry.recent.size > 300) entry.recent.delete(entry.recent.keys().next().value);
      }
      return json(res, 200, answer);
    }

    return err(res, 404, 'NOT_FOUND', 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return err(res, 400, 'BAD_URL', 'Bad URL');
    }
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return err(res, 405, 'METHOD', 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof ActionError) {
        const status = e.code === 'TOO_LARGE' ? 413 : 409;
        return err(res, status, e.code, e.message);
      }
      log.error?.('[http] error', e);
      if (!res.headersSent) err(res, 500, 'SERVER', 'サーバーエラーが発生しました');
    }
  });
  server.keepAliveTimeout = 65000;

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;

  async function close() {
    clearInterval(cleanup);
    for (const entry of rooms.values()) {
      clearTimeout(entry.timer);
      for (const t of entry.offlineTimers.values()) clearTimeout(t);
      for (const c of entry.clients) c.res.end();
      persist(entry);
    }
    clearInterval(agents.timer);
    clearInterval(maps.timer);
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    store.close();
  }

  const reschedule = (id) => rooms.has(id) && schedule(rooms.get(id));
  return { server, port: actualPort, rooms, store, agents, maps, close, reschedule };
}
