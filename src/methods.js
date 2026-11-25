// Agent draft methods, defined as DATA (no per-method code paths).
//
// Each method declares:
//   phases  : ordered list of { type: 'protect'|'ban'|'pick', count: <setting key or number>, simultaneous, hidden }
//   rules   : how selections interact
//     banTarget      'both'  -> a ban blocks both teams          | 'enemy' -> blocks only the opponent
//     banCross       'unique'-> the same agent cannot be banned by both teams | 'allow'
//     protectEffect  'noEnemyBan' | 'noEnemyBanPick'  (Head Protect also blocks enemy picks)
//     pickCross      'unique'-> both teams cannot pick the same agent | 'mirror' -> allowed
//   fearless       : picks of previous maps are unavailable to the same team
//   seriesOnly     : only selectable with Map Draft (Bo3/Bo5)
//   usesOrder      : Standard / Snake applies to its sequential phases
//   settings       : which count settings are shown, with range and default
//
// Internal notation from the spec: Protect (), Ban {}, Pick [].

export const PICKS_PER_TEAM = 5;

export const COUNT_SETTINGS = {
  banCount: { label: 'Ban数(各チーム)', min: 1, max: 3, def: 2 },
  protectCount: { label: 'Protect数(各チーム)', min: 1, max: 2, def: 1 },
  blindBanCount: { label: 'Ban数(各チーム)', min: 2, max: 4, def: 2 },
  blindEnemyBanCount: { label: 'Ban数(各チーム)', min: 2, max: 4, def: 4 },
};

const seqPick = { type: 'pick', count: PICKS_PER_TEAM, simultaneous: false, hidden: false };
const blindPick = { type: 'pick', count: PICKS_PER_TEAM, simultaneous: true, hidden: true };

export const METHODS = [
  {
    id: 'normal', no: 1, name: 'Normal Draft', ja: 'ノーマル',
    desc: 'Protect・BanなしのPickのみ。チーム間・チーム内とも同じエージェントは不可。',
    phases: [seqPick],
    rules: { banTarget: 'both', banCross: 'unique', protectEffect: 'noEnemyBan', pickCross: 'unique' },
    usesOrder: true, settings: [],
  },
  {
    id: 'ban', no: 2, name: 'Ban Draft', ja: 'バン',
    desc: 'Banの後にPick。Banしたエージェントは両チームPick不可。',
    phases: [{ type: 'ban', count: 'banCount', simultaneous: false, hidden: false }, seqPick],
    rules: { banTarget: 'both', banCross: 'unique', protectEffect: 'noEnemyBan', pickCross: 'unique' },
    usesOrder: true, settings: ['banCount'],
  },
  {
    id: 'enemy_ban', no: 3, name: 'Enemy Ban Draft', ja: 'エネミーバン',
    desc: '自チームのBanは敵チームにのみ適用。自分がBanしたエージェントは自分はPick可能。',
    phases: [{ type: 'ban', count: 'banCount', simultaneous: false, hidden: false }, seqPick],
    rules: { banTarget: 'enemy', banCross: 'unique', protectEffect: 'noEnemyBan', pickCross: 'unique' },
    usesOrder: true, settings: ['banCount'],
  },
  {
    id: 'protect_ban', no: 4, name: 'Protect Ban Draft', ja: 'プロテクトバン',
    desc: 'Protect → Ban → Pick。Protectしたエージェントは敵チームがBanできない。',
    phases: [
      { type: 'protect', count: 'protectCount', simultaneous: false, hidden: false },
      { type: 'ban', count: 'banCount', simultaneous: false, hidden: false },
      seqPick,
    ],
    rules: { banTarget: 'both', banCross: 'unique', protectEffect: 'noEnemyBan', pickCross: 'unique' },
    usesOrder: true, settings: ['protectCount', 'banCount'],
  },
  {
    id: 'head_protect', no: 5, name: 'Head Protect Ban Draft', ja: 'ヘッドプロテクト',
    desc: 'Protectしたエージェントは敵チームがBanもPickもできない。',
    phases: [
      { type: 'protect', count: 'protectCount', simultaneous: false, hidden: false },
      { type: 'ban', count: 'banCount', simultaneous: false, hidden: false },
      seqPick,
    ],
    rules: { banTarget: 'both', banCross: 'unique', protectEffect: 'noEnemyBanPick', pickCross: 'unique' },
    usesOrder: true, settings: ['protectCount', 'banCount'],
  },
  {
    id: 'blind_ban', no: 6, name: 'Blind Ban Pick', ja: 'ブラインドバンピック',
    desc: 'Banは公開で交互、Pickは両チーム同時に非公開。相手と同じエージェントのPickは可能。',
    phases: [{ type: 'ban', count: 'blindBanCount', simultaneous: false, hidden: false }, blindPick],
    rules: { banTarget: 'both', banCross: 'unique', protectEffect: 'noEnemyBan', pickCross: 'mirror' },
    usesOrder: true, settings: ['blindBanCount'],
  },
  {
    id: 'blind_enemy_ban', no: 7, name: 'Blind Enemy Ban Pick', ja: 'ブラインドエネミーバン',
    desc: 'Ban・Pickとも両チーム同時に非公開。Banは敵チームのみに適用。相手との重複・ミラーは可能。',
    phases: [{ type: 'ban', count: 'blindEnemyBanCount', simultaneous: true, hidden: true }, blindPick],
    rules: { banTarget: 'enemy', banCross: 'allow', protectEffect: 'noEnemyBan', pickCross: 'mirror' },
    usesOrder: false, settings: ['blindEnemyBanCount'],
  },
  {
    id: 'fearless', no: 8, name: 'Fearless Blind Pick', ja: 'フィアレス',
    desc: 'Bo3/Bo5専用。各マップ同時非公開Pick。前のマップで自チームが使ったエージェントは以降使用不可。',
    phases: [blindPick],
    rules: { banTarget: 'both', banCross: 'unique', protectEffect: 'noEnemyBan', pickCross: 'mirror' },
    fearless: true, seriesOnly: true, usesOrder: false, settings: [],
  },
];

export const METHOD_MAP = Object.fromEntries(METHODS.map((m) => [m.id, m]));

export const phaseCount = (phase, settings) =>
  typeof phase.count === 'number' ? phase.count : Number(settings[phase.count] ?? COUNT_SETTINGS[phase.count].def);

// Order of a sequential phase: 2n single selections.
//   standard: F S F S ...      snake: F S S F F S S F ...
export function phaseOrder(order, first, n) {
  const second = first === 'A' ? 'B' : 'A';
  return Array.from({ length: n * 2 }, (_, k) => {
    if (order === 'snake') return k % 4 === 0 || k % 4 === 3 ? first : second;
    return k % 2 === 0 ? first : second;
  });
}

// Expand a method into steps for one game.
//   sequential step:   { i, kind:'seq', type, team, phase, slot? }
//   simultaneous step: { i, kind:'sim', type, count, phase, hidden }
export function buildAgentSteps(method, settings, first = 'A') {
  const steps = [];
  method.phases.forEach((ph, phase) => {
    const n = phaseCount(ph, settings);
    if (ph.simultaneous) {
      steps.push({ i: steps.length, kind: 'sim', type: ph.type, count: n, phase, hidden: !!ph.hidden });
      return;
    }
    const order = method.usesOrder ? settings.order : 'standard';
    const counter = { A: 0, B: 0 };
    for (const team of phaseOrder(order, first, n)) {
      const st = { i: steps.length, kind: 'seq', type: ph.type, team, phase, slot: counter[team]++ };
      steps.push(st);
    }
  });
  return steps;
}

// How many distinct agents one draft needs at worst, used to cap agent Global Bans.
export function agentsRequired(method, settings, games = 1) {
  const s = (k) => Number(settings[k] ?? COUNT_SETTINGS[k].def);
  switch (method.id) {
    case 'normal':
      return 10;
    case 'ban':
    case 'enemy_ban':
    case 'protect_ban':
    case 'head_protect':
      return 10 + 2 * s('banCount');
    case 'blind_ban':
      return 5 + 2 * s('blindBanCount');
    case 'blind_enemy_ban':
      return 5 + s('blindEnemyBanCount');
    case 'fearless':
      return 5 * games;
    default:
      return 10;
  }
}

export const MAX_AGENT_GLOBAL_BANS = 4; // expected maximum; the real cap is min(this, agents - required)

export function publicMethods() {
  return METHODS.map((m) => ({
    id: m.id, no: m.no, name: m.name, ja: m.ja, desc: m.desc,
    phases: m.phases.map((p) => ({ type: p.type, count: p.count, simultaneous: p.simultaneous, hidden: p.hidden })),
    rules: m.rules, fearless: !!m.fearless, seriesOnly: !!m.seriesOnly, usesOrder: m.usesOrder, settings: m.settings,
  }));
}
