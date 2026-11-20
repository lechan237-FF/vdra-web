// Draft System definitions (8 formats).
// Team "A" = ATTACKERS, Team "B" = DEFENDERS.
// Each step is one selection made by one team.
//   gban    : Global Ban  - unavailable to both teams for the whole draft
//   protect : Protect     - opponent cannot ban it (and, when mirror=false, cannot pick it)
//   ban     : Ban         - unavailable to both teams
//   pick    : Pick        - assigned to a player of the team
//
// mirror: true  -> both teams may pick the same agent (same team still cannot pick twice)
//         false -> an agent can be picked by only one team in the draft
// The host can override `mirror` per room in the lobby.

const seq = (type, teams) => [...teams].map((team) => ({ type, team }));

export const SYSTEMS = [
  {
    id: 'standard',
    no: 1,
    name: 'スタンダード',
    en: 'STANDARD',
    desc: 'ATK→DEFの交互Pick。Banなし。',
    mirror: true,
    steps: [...seq('pick', 'ABABABABAB')],
  },
  {
    id: 'snake',
    no: 2,
    name: 'スネーク',
    en: 'SNAKE',
    desc: 'A→B→B→A→A…の順でPick。Banなし。',
    mirror: true,
    steps: [...seq('pick', 'ABBAABBAAB')],
  },
  {
    id: 'ban_standard',
    no: 3,
    name: 'Ban＋スタンダード',
    en: 'BAN + STANDARD',
    desc: '各チーム2Ban(交互)の後、交互Pick。',
    mirror: false,
    steps: [...seq('ban', 'ABAB'), ...seq('pick', 'ABABABABAB')],
  },
  {
    id: 'ban_snake',
    no: 4,
    name: 'Ban＋スネーク',
    en: 'BAN + SNAKE',
    desc: '各チーム2Ban(交互)の後、スネーク順でPick。',
    mirror: false,
    steps: [...seq('ban', 'ABAB'), ...seq('pick', 'ABBAABBAAB')],
  },
  {
    id: 'tournament',
    no: 5,
    name: 'トーナメント',
    en: 'TOURNAMENT',
    desc: 'Ban×4 → Pick×6 → Ban×4 → Pick×4 の2段階。',
    mirror: false,
    steps: [
      ...seq('ban', 'ABAB'),
      ...seq('pick', 'ABBAAB'),
      ...seq('ban', 'BABA'),
      ...seq('pick', 'BAAB'),
    ],
  },
  {
    id: 'protect',
    no: 6,
    name: 'Protect＋Ban＋Pick',
    en: 'PROTECT + BAN + PICK',
    desc: '各チーム1Protect → 各2Ban → スネークPick。Protectしたエージェントは相手がBan/Pickできない。',
    mirror: false,
    steps: [...seq('protect', 'AB'), ...seq('ban', 'ABAB'), ...seq('pick', 'ABBAABBAAB')],
  },
  {
    id: 'gban_standard',
    no: 7,
    name: 'Global Ban＋スタンダード',
    en: 'GLOBAL BAN + STANDARD',
    desc: '各チーム2つのGlobal Banの後、交互Pick。',
    mirror: false,
    steps: [...seq('gban', 'ABAB'), ...seq('pick', 'ABABABABAB')],
  },
  {
    id: 'full',
    no: 8,
    name: 'フル',
    en: 'FULL DRAFT',
    desc: 'Global Ban → Protect → Ban → スネークPick の全フェーズ。',
    mirror: false,
    steps: [
      ...seq('gban', 'AB'),
      ...seq('protect', 'AB'),
      ...seq('ban', 'ABAB'),
      ...seq('pick', 'ABBAABBAAB'),
    ],
  },
];

export const SYSTEM_MAP = Object.fromEntries(SYSTEMS.map((s) => [s.id, s]));

export const STEP_LABEL = {
  gban: 'GLOBAL BAN',
  protect: 'PROTECT',
  ban: 'BAN',
  pick: 'PICK',
};

// Expand a system into numbered steps with phase grouping and per-team pick slot index.
export function buildSteps(system) {
  const steps = [];
  const pickCount = { A: 0, B: 0 };
  let phase = 0;
  const phaseCountByType = {};
  let prevType = null;
  system.steps.forEach((s, i) => {
    if (s.type !== prevType) {
      phase++;
      phaseCountByType[s.type] = (phaseCountByType[s.type] || 0) + 1;
      prevType = s.type;
    }
    const step = { i, type: s.type, team: s.team, phase, phaseNo: phaseCountByType[s.type] };
    if (s.type === 'pick') step.slot = pickCount[s.team]++;
    steps.push(step);
  });
  return steps;
}

export function publicSystems() {
  return SYSTEMS.map((s) => ({
    id: s.id,
    no: s.no,
    name: s.name,
    en: s.en,
    desc: s.desc,
    mirror: s.mirror,
    steps: buildSteps(s),
  }));
}
