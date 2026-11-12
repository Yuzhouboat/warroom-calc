// War Room battle engine. Rules source: 作战室规则 2025 (pp. 14-16, 34-35).
// Works in the browser (window.WarRoom) and in Node (module.exports).
(function (root) {
  'use strict';

  // 12-sided die faces: 1 white, 1 black, 1 red, 2 green, 3 blue, 4 yellow.
  const FACES = ['W', 'K', 'R', 'G', 'G', 'B', 'B', 'B', 'Y', 'Y', 'Y', 'Y'];
  // Order in which a batch's hits are resolved.
  const COLOR_ORDER = ['Y', 'B', 'G', 'R'];

  // cost = production cost in [oil, steel, other] (dots on the order sheet, rulebook p.22).
  // domain: air units can only be hit in the air phase; land/sea units only in the land/sea phase.
  // hp: hits to destroy. White dice may only hit a unit that is down to its last hit (hp 1).
  const TYPES = {
    infantry:   { name: 'Infantry',    color: 'Y', hp: 2, cost: [0, 0, 2], domain: 'land' },
    artillery:  { name: 'Artillery',   color: 'B', hp: 2, cost: [0, 2, 1], domain: 'land' },
    armor:      { name: 'Armor',       color: 'G', hp: 3, cost: [1, 2, 1], domain: 'land' },
    fighter:    { name: 'Fighter',     color: 'G', hp: 2, cost: [2, 1, 1], domain: 'air' },
    bomber:     { name: 'Bomber',      color: 'R', hp: 2, cost: [2, 2, 1], domain: 'air' },
    submarine:  { name: 'Submarine',   color: 'Y', hp: 2, cost: [1, 2, 1], domain: 'sea', dive: true },
    cruiser:    { name: 'Cruiser',     color: 'B', hp: 2, cost: [2, 3, 2], domain: 'sea' },
    carrier:    { name: 'Carrier',     color: 'G', hp: 3, cost: [4, 3, 3], domain: 'sea' },
    battleship: { name: 'Battleship',  color: 'R', hp: 3, cost: [3, 4, 3], domain: 'sea' },
  };

  // Stances: [air dice, land/sea dice] per unit. Order follows the battle board rows (top to bottom).
  const STANCES = {
    land: {
      infantry:  [{ air: 0, ls: 1 }, { air: 0, ls: 2, hp: 1 }],   // stance 2 has no damage cell: one hit destroys it
      artillery: [{ air: 2, ls: 1 }, { air: 0, ls: 2 }],
      armor:     [{ air: 1, ls: 2 }, { air: 0, ls: 4, hp: 2 }],   // only the 1/2 row has the extra light-damage cell
      fighter:   [{ air: 3, ls: 0 }, { air: 0, ls: 3 }],
      bomber:    [{ air: 1, ls: 0, note: 'strategic raid' }, { air: 1, ls: 4 }],
    },
    sea: {
      submarine:  [{ air: 0, ls: 2 }],
      cruiser:    [{ air: 2, ls: 2 }, { air: 1, ls: 3 }],
      carrier:    [{ air: 2, ls: 1 }, { air: 1, ls: 2 }],
      battleship: [{ air: 2, ls: 3 }, { air: 1, ls: 4 }],
      fighter:    [{ air: 3, ls: 0 }, { air: 0, ls: 3 }],
      bomber:     [{ air: 1, ls: 3 }],
    },
  };

  // Random source. simulate() swaps in a seeded generator when cfg.seed is given, so different
  // layouts can be compared on identical dice (common random numbers).
  let rand = Math.random;
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const BATCH = 10, DICE_CAP = 30, PORT_BONUS = 2;

  function buildUnits(mode, side) {
    const units = [];
    for (const type of Object.keys(STANCES[mode])) {
      const counts = (side.units && side.units[type]) || [];
      STANCES[mode][type].forEach((st, si) => {
        const n = counts[si] | 0;
        for (let i = 0; i < n; i++) {
          units.push({ type, def: TYPES[type], stance: st, hp: st.hp || TYPES[type].hp, maxHp: st.hp || TYPES[type].hp, alive: true, escaped: false });
        }
      });
    }
    return units;
  }

  const isAir = (u) => u.def.domain === 'air';
  const isLS = (u) => !isAir(u);
  const fireValue = (u, phase) => (phase === 'air' ? u.stance.air : u.stance.ls);
  const targetable = (u, phase) =>
    u.alive && !u.escaped && (phase === 'air' ? isAir(u) : isLS(u));

  function diceCount(units, phase, portBonus) {
    let n = 0;
    for (const u of units) {
      if (!u.alive) continue;
      n += fireValue(u, phase);
    }
    if (portBonus && phase === 'ls' && units.some((u) => u.alive && isLS(u))) n += PORT_BONUS;
    return Math.min(n, DICE_CAP);
  }

  // Score of putting one hit on u: fraction of its remaining firepower removed.
  function score(u, phase) {
    const v = fireValue(u, phase) + 0.001 * (phase === 'air' ? u.stance.ls : u.stance.air);
    // Air phase: shooting down a plane that also fights in the land/sea phase removes dice from that
    // phase too, so those planes are always targeted before planes that only fight in the air.
    const tier = phase === 'air' && u.stance.ls > 0 ? 1000 : 0;
    return tier + (v + 0.01) / u.hp;
  }

  function hit(u) {
    u.hp -= 1;
    if (u.hp <= 0) u.alive = false;
  }

  function best(cands, phase) {
    let b = null, bs = -1;
    for (const u of cands) {
      const s = score(u, phase);
      if (s > bs) { bs = s; b = u; }
    }
    return b;
  }

  // Resolve one batch of dice rolled against `enemy` units.
  // A white die can only finish a damaged unit (one hit left, more than one hit at full health, not a sub).
  const whiteTarget = (u) => u.alive && u.hp === 1 && u.maxHp > 1 && !u.def.dive;

  // Resolve one batch of dice rolled against `enemy` units.
  function resolveBatch(rolled, enemy, phase, blackWhiteLive) {
    let black = 0, white = 0;
    const col = { Y: 0, B: 0, G: 0, R: 0 };
    for (const f of rolled) {
      if (f === 'K') black++;
      else if (f === 'W') white++;
      else col[f]++;
    }
    const pool = enemy.filter((u) => targetable(u, phase));
    const w = blackWhiteLive ? white : 0;
    // Coloured hits: damaged units of the same row first, otherwise best-scoring row. Among the
    // choices, the one that lets the most white dice find a damaged target comes first.
    for (const c of COLOR_ORDER) {
      for (let i = 0; i < col[c]; i++) {
        const cands = pool.filter((u) => u.alive && u.def.color === c);
        if (!cands.length) break;
        applyRowRule(cands, phase, pool, w);
      }
    }
    if (blackWhiteLive) {
      for (let i = 0; i < black; i++) {
        const cands = pool.filter((u) => u.alive);
        if (!cands.length) break;
        applyRowRule(cands, phase, pool, w);
      }
      for (let i = 0; i < white; i++) {
        const cands = pool.filter(whiteTarget);
        if (!cands.length) break;
        hit(best(cands, phase));
      }
    }
    // Damaged submarines that survived flee after the enemy batch.
    for (const u of enemy) if (u.alive && u.def.dive && u.hp < u.maxHp) u.escaped = true;
  }

  // Within a row (type+stance) damaged units must be hit first; pick the best row.
  // Priority 1: use as many of this batch's white dice as possible (`w` of them) afterwards.
  // Priority 2: the usual firepower-per-hit-point score (see score()).
  function applyRowRule(cands, phase, pool, w) {
    const rows = new Map();
    for (const u of cands) {
      const k = u.type + ':' + u.stance.air + '/' + u.stance.ls;
      const cur = rows.get(k);
      if (!cur || u.hp < cur.hp) rows.set(k, u);
    }
    const choices = [...rows.values()];
    if (w > 0) {
      const eligible = pool.filter(whiteTarget).length;
      const used = (u) => {                       // white dice usable after this hit lands on u
        const after = eligible - (whiteTarget(u) ? 1 : 0) + (u.hp === 2 && u.maxHp > 1 && !u.def.dive ? 1 : 0);
        return Math.min(w, after);
      };
      const top = Math.max(...choices.map(used));
      hit(best(choices.filter((u) => used(u) === top), phase));
      return;
    }
    hit(best(choices, phase));
  }

  function typeCount(units) {
    const s = new Set();
    for (const u of units) if (u.alive && isLS(u)) s.add(u.type);
    return s.size;
  }

  function runPhase(phase, sides, first, portBonus, mode) {
    const order = [first, 1 - first];
    const n = [diceCount(sides[0], phase, portBonus[0]), diceCount(sides[1], phase, portBonus[1])];
    let live = [true, true];
    if (phase === 'ls') {
      const t0 = typeCount(sides[0]), t1 = typeCount(sides[1]);
      live = [t0 >= t1, t1 >= t0]; // side with fewer unit types: black/white are misses
    }
    const left = n.slice();
    while (left[0] > 0 || left[1] > 0) {
      for (const s of order) {
        if (left[s] <= 0) continue;
        const k = Math.min(BATCH, left[s]);
        left[s] -= k;
        const rolled = [];
        for (let i = 0; i < k; i++) rolled.push(FACES[(rand() * 12) | 0]);
        resolveBatch(rolled, sides[1 - s], phase, live[s]);
      }
    }
  }

  function battleRound(sides, cfg) {
    const port = cfg.mode === 'sea' ? [!!cfg.sides[0].port, !!cfg.sides[1].port] : [false, false];
    const first = cfg.first | 0;
    if (sides[0].some((u) => u.alive && isAir(u)) || sides[1].some((u) => u.alive && isAir(u))) {
      runPhase('air', sides, first, port, cfg.mode);
    }
    if (sides[0].some((u) => u.alive && isLS(u)) || sides[1].some((u) => u.alive && isLS(u))) {
      runPhase('ls', sides, first, port, cfg.mode);
    }
  }

  // Between rounds: light damage heals for free, fled submarines return; optionally repair all damage.
  function resetForNextRound(sides, repairAll) {
    for (const side of sides) {
      for (const u of side) {
        if (!u.alive) continue;
        u.escaped = false;
        if (repairAll) u.hp = u.maxHp;
        else if (u.maxHp === 3 && u.hp === 2) u.hp = 3;
      }
    }
  }

  const MAX_ROUNDS = 25;

  function simulateOnce(cfg) {
    const sides = [buildUnits(cfg.mode, cfg.sides[0]), buildUnits(cfg.mode, cfg.sides[1])];
    const rounds = cfg.fightToEnd ? MAX_ROUNDS : 1;
    for (let r = 0; r < rounds; r++) {
      battleRound(sides, cfg);
      if (r < rounds - 1) {
        const alive = sides.map((s) => s.some((u) => u.alive));
        if (!alive[0] || !alive[1]) break;
        resetForNextRound(sides, !!cfg.repairAll);
      }
    }
    return sides;
  }

  function simulate(cfg, runs) {
    runs = runs || 20000;
    const out = {
      runs,
      p: { side0Wins: 0, side1Wins: 0, mutual: 0, stalemate: 0 },
      survivors: [{}, {}],
      damaged: [{}, {}],
      lost: [{}, {}],
      control: [0, 0],
      lead: { side0: 0, tie: 0, side1: 0 },   // who ends with more land/sea units left (by number of units)
      // dist[s].ls[k] / .air[k] = P(side s ends with exactly k land/sea units / air units alive), k = 0..starting count
      dist: [0, 1].map((s) => {
        const b = buildUnits(cfg.mode, cfg.sides[s]), air = b.filter(isAir).length;
        return { ls: new Array(b.length - air + 1).fill(0), air: new Array(air + 1).fill(0) };
      }),
    };
    const prevRand = rand;
    if (cfg.seed != null) rand = mulberry32(cfg.seed);
    for (let r = 0; r < runs; r++) {
      const sides = simulateOnce(cfg);
      const alive = sides.map((s) => s.filter((u) => u.alive));
      const a0 = alive[0].length > 0, a1 = alive[1].length > 0;
      if (a0 && !a1) out.p.side0Wins++;
      else if (!a0 && a1) out.p.side1Wins++;
      else if (!a0 && !a1) out.p.mutual++;
      else out.p.stalemate++;
      // Control of a territory (land battles only, rulebook p.19): it changes hands only if exactly one
      // side still has a land unit. Air units can neither capture nor defend; sea battles capture nothing.
      if (cfg.mode === 'land') {
        const hasLand = (arr) => arr.some((u) => u.def.domain === 'land');
        for (let s = 0; s < 2; s++) if (hasLand(alive[s]) && !hasLand(alive[1 - s])) out.control[s]++;
      }
      // Land/sea units left: number of surviving non-air units (air units are not counted).
      const lsCount = (arr) => arr.filter((u) => u.def.domain !== 'air').length;
      const v0 = lsCount(alive[0]), v1 = lsCount(alive[1]);
      if (v0 > v1) out.lead.side0++; else if (v1 > v0) out.lead.side1++; else out.lead.tie++;
      for (let s = 0; s < 2; s++) {
        const nAir = alive[s].length - lsCount(alive[s]), nLS = lsCount(alive[s]);
        out.dist[s].ls[nLS]++; out.dist[s].air[nAir]++;
        for (const u of sides[s]) if (!u.alive) out.lost[s][u.type] = (out.lost[s][u.type] || 0) + 1;
        for (const u of alive[s]) {
          out.survivors[s][u.type] = (out.survivors[s][u.type] || 0) + 1;
          // "damaged" = needs repair (hp 1); the light-damage cell of 3-hp units needs none.
          if (u.hp === 1 && u.maxHp > 1) out.damaged[s][u.type] = (out.damaged[s][u.type] || 0) + 1;
        }
      }
    }
    rand = prevRand;
    for (const k of Object.keys(out.p)) out.p[k] /= runs;
    out.control[0] /= runs; out.control[1] /= runs;
    for (const k of Object.keys(out.lead)) out.lead[k] /= runs;
    for (let s = 0; s < 2; s++) {
      for (const d of [out.dist[s].ls, out.dist[s].air]) for (let k = 0; k < d.length; k++) d[k] /= runs;
      for (const t of Object.keys(out.survivors[s])) out.survivors[s][t] /= runs;
      for (const t of Object.keys(out.damaged[s])) out.damaged[s][t] /= runs;
      for (const t of Object.keys(out.lost[s])) out.lost[s][t] /= runs;
    }
    return out;
  }

  // Production cost expressed in yellow ("other") resources, using the rulebook's trade rates
  // (p.22: 2 oil = 3 steel = 5 other), so 1 oil = 2.5 yellow and 1 steel = 5/3 yellow.
  const YELLOW_PER = [5 / 2, 5 / 3, 1];                                    // [oil, steel, other]
  const costOf = (type) => TYPES[type].cost.reduce((a, n, i) => a + n * YELLOW_PER[i], 0);
  const api = { FACES, TYPES, STANCES, simulate, simulateOnce, buildUnits, diceCount, costOf, YELLOW_PER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WarRoom = api;
})(typeof window !== 'undefined' ? window : globalThis);
