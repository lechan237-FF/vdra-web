// Agent catalogue. Fetched from valorant-api.com (community API, includes official artwork URLs),
// cached on disk, and refreshed every 24h. Falls back to the cache, then to a bundled list
// (names/roles only, no images) so the draft still works offline.

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const REFRESH_MS = 24 * 60 * 60 * 1000;

export const ROLES = [
  { id: 'duelist', en: 'Duelist', ja: 'デュエリスト' },
  { id: 'initiator', en: 'Initiator', ja: 'イニシエーター' },
  { id: 'controller', en: 'Controller', ja: 'コントローラー' },
  { id: 'sentinel', en: 'Sentinel', ja: 'センチネル' },
];

const FALLBACK = {
  duelist: ['Iso', 'Jett', 'Neon', 'Phoenix', 'Raze', 'Reyna', 'Waylay', 'Yoru'],
  initiator: ['Breach', 'Fade', 'Gekko', 'KAY/O', 'Skye', 'Sova', 'Tejo'],
  controller: ['Astra', 'Brimstone', 'Clove', 'Harbor', 'Omen', 'Viper'],
  sentinel: ['Chamber', 'Cypher', 'Deadlock', 'Killjoy', 'Sage', 'Veto', 'Vyse'],
};

export const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

function fallbackList() {
  const list = [];
  for (const [role, names] of Object.entries(FALLBACK)) {
    for (const n of names) list.push({ id: slug(n), name: n, nameJa: n, role, colors: null, images: null });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function roleIdFromApi(roleObj) {
  const n = slug(roleObj?.displayName || '');
  return ROLES.find((r) => r.id === n)?.id || 'duelist';
}

async function fetchJson(url, timeoutMs = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchAgentsFromApi() {
  const [en, ja] = await Promise.all([
    fetchJson(`${API}&language=en-US`),
    fetchJson(`${API}&language=ja-JP`).catch(() => null),
  ]);
  const jaById = new Map((ja?.data || []).map((a) => [a.uuid, a]));
  const roleIcons = {};
  const list = (en.data || [])
    .filter((a) => a.isPlayableCharacter !== false && a.role)
    .map((a) => {
      const role = roleIdFromApi(a.role);
      if (a.role?.displayIcon) roleIcons[role] = a.role.displayIcon;
      return {
        id: slug(a.displayName),
        uuid: a.uuid,
        name: a.displayName,
        nameJa: jaById.get(a.uuid)?.displayName || a.displayName,
        role,
        colors: a.backgroundGradientColors || null,
        images: {
          icon: a.displayIcon,
          small: a.displayIconSmall,
          portrait: a.fullPortrait || a.fullPortraitV2 || a.displayIcon,
          killfeed: a.killfeedPortrait || a.displayIconSmall,
          background: a.background,
        },
      };
    });
  // de-duplicate (the API occasionally returns duplicate entries)
  const seen = new Set();
  const uniq = list.filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
  if (uniq.length < 10) throw new Error('agent list too small');
  uniq.sort((a, b) => a.name.localeCompare(b.name));
  return { agents: uniq, roleIcons, source: 'api', fetchedAt: Date.now() };
}

export class AgentStore {
  constructor(dataDir, { offline = false, log = console } = {}) {
    this.cacheFile = path.join(dataDir, 'agents-cache.json');
    this.offline = offline;
    this.log = log;
    this.data = null;
    this.ids = [];
  }

  set(data) {
    this.data = data;
    this.ids = data.agents.map((a) => a.id);
  }

  async init() {
    try {
      const cached = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (cached?.agents?.length) this.set({ ...cached, source: 'cache' });
    } catch {}
    if (!this.data) this.set({ agents: fallbackList(), roleIcons: {}, source: 'fallback', fetchedAt: 0 });
    if (!this.offline) {
      await this.refresh();
      this.timer = setInterval(() => this.refresh(), REFRESH_MS);
      this.timer.unref?.();
    }
  }

  async refresh() {
    try {
      const fresh = await fetchAgentsFromApi();
      this.set(fresh);
      fs.writeFileSync(this.cacheFile, JSON.stringify(fresh));
      this.log.info?.(`[agents] loaded ${fresh.agents.length} agents from valorant-api.com`);
    } catch (e) {
      this.log.warn?.(`[agents] fetch failed (${e.message}); using ${this.data.source} list (${this.ids.length} agents)`);
    }
  }

  publicData() {
    return { agents: this.data.agents, roles: ROLES, roleIcons: this.data.roleIcons || {}, source: this.data.source };
  }
}
