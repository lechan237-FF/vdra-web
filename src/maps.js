// Map catalogue from valorant-api.com. Only standard bomb-plant maps are used
// (Team Deathmatch, Skirmish and The Range have no "A/B Sites" description and are excluded).
import fs from 'node:fs';
import path from 'node:path';
import { slug } from './agents.js';

const API = 'https://valorant-api.com/v1/maps';
const REFRESH_MS = 24 * 60 * 60 * 1000;
export const SERIES_POOL = 7; // maps left after the map Global Ban

const FALLBACK = ['Abyss', 'Ascent', 'Bind', 'Breeze', 'Corrode', 'Fracture', 'Haven', 'Icebox', 'Lotus', 'Pearl', 'Split', 'Sunset'];

const fallbackList = () => FALLBACK.map((n) => ({ id: slug(n), name: n, nameJa: n, images: null }));

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

export function isStandardMap(m) {
  return !!m && typeof m.tacticalDescription === 'string' && /sites/i.test(m.tacticalDescription);
}

export async function fetchMapsFromApi() {
  const [en, ja] = await Promise.all([fetchJson(`${API}?language=en-US`), fetchJson(`${API}?language=ja-JP`).catch(() => null)]);
  const jaById = new Map((ja?.data || []).map((m) => [m.uuid, m]));
  const seen = new Set();
  const list = (en.data || [])
    .filter(isStandardMap)
    .map((m) => ({
      id: slug(m.displayName),
      uuid: m.uuid,
      name: m.displayName,
      nameJa: jaById.get(m.uuid)?.displayName || m.displayName,
      sites: m.tacticalDescription,
      images: { list: m.listViewIcon, tall: m.listViewIconTall || m.listViewIcon, splash: m.splash, premier: m.premierBackgroundImage || null },
    }))
    .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (list.length < SERIES_POOL) throw new Error('map list too small');
  return { maps: list, source: 'api', fetchedAt: Date.now() };
}

export class MapStore {
  constructor(dataDir, { offline = false, log = console } = {}) {
    this.cacheFile = path.join(dataDir, 'maps-cache.json');
    this.offline = offline;
    this.log = log;
    this.data = null;
    this.ids = [];
  }
  set(d) {
    this.data = d;
    this.ids = d.maps.map((m) => m.id);
  }
  async init() {
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (c?.maps?.length) this.set({ ...c, source: 'cache' });
    } catch {}
    if (!this.data) this.set({ maps: fallbackList(), source: 'fallback', fetchedAt: 0 });
    if (!this.offline) {
      await this.refresh();
      this.timer = setInterval(() => this.refresh(), REFRESH_MS);
      this.timer.unref?.();
    }
  }
  async refresh() {
    try {
      const fresh = await fetchMapsFromApi();
      this.set(fresh);
      fs.writeFileSync(this.cacheFile, JSON.stringify(fresh));
      this.log.info?.(`[maps] loaded ${fresh.maps.length} maps from valorant-api.com`);
    } catch (e) {
      this.log.warn?.(`[maps] fetch failed (${e.message}); using ${this.data.source} list (${this.ids.length} maps)`);
    }
  }
  publicData() {
    return { maps: this.data.maps, pool: SERIES_POOL, source: this.data.source };
  }
}
