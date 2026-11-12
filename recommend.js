// Stance recommender for the War Room calculator.
// Given both armies, searches how the chosen side should split each unit type between its stances,
// assuming the other side keeps its current stances. Uses WarRoom.simulate with a fixed seed so every
// candidate faces identical dice (common random numbers), then re-tests the best few with more runs.
(function (root) {
  'use strict';
  const W = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.WarRoom;

  // control: most chance to take the territory (land only) | hold: most chance of NOT losing the territory
  // you already hold (land only) | balanced: best cost exchange |
  // unitDiff: biggest lead in land/sea units left (number of units, mine minus the opponent's; no air units).
  const OBJECTIVES = ['control', 'hold', 'balanced', 'unitDiff'];

  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

  // Production cost of the units in a { type: count } map (total resources: oil + steel + other).
  const costOfMap = (o) => Object.entries(o).reduce((a, [t, n]) => a + n * W.costOf(t), 0);
  // Only the units that fight in the land/sea phase (everything except air units).
  const lsCountOfMap = (o) => Object.entries(o).filter(([t]) => W.TYPES[t].domain !== 'air').reduce((a, [, n]) => a + n, 0);
  // Same, but only land units: those are what decide control of a territory.
  const landCostOfMap = (o) => costOfMap(Object.fromEntries(Object.entries(o).filter(([t]) => W.TYPES[t].domain === 'land')));

  // Metrics for `f` (the side being advised) from one simulate() result. Damaged units count as
  // survivors, so only units actually destroyed matter. Losses are measured in production cost
  // (yellow-resource equivalents); the plain unit counts are kept too.
  function metricsOf(out, f) {
    const e = 1 - f;
    return {
      control: out.control[f],
      hold: 1 - out.control[1 - f],                         // the enemy does not take the territory (control stays with / unchanged for me)
      ownLandCost: landCostOfMap(out.lost[f]),
      enemyLost: sum(out.lost[e]), ownLost: sum(out.lost[f]),
      enemyCost: costOfMap(out.lost[e]), ownCost: costOfMap(out.lost[f]),
      enemyLandCost: landCostOfMap(out.lost[e]),
      keptUnits: lsCountOfMap(out.survivors[f]),            // my land/sea units left (number of units)
      enemyKeptUnits: lsCountOfMap(out.survivors[e]),       // the opponent's
    };
  }
  const own = (m) => m.ownCost;
  const enemy = (m) => m.enemyCost;

  // Higher score = better. Small tie-breakers keep the landscape from being flat.
  // ctx.enemy / ctx.own = production cost of the enemy's / my land units at the start.
  function score(objective, m, ctx) {
    switch (objective) {
      case 'control':   return m.control + 0.05 * m.enemyLandCost / Math.max(1, ctx.enemy);
      case 'hold':      return m.hold - 0.05 * m.ownLandCost / Math.max(1, ctx.own);             // tie-break: lose as few land units as possible
      case 'unitDiff':  return (m.keptUnits - m.enemyKeptUnits) + 0.002 * enemy(m);
      case 'balanced':  return enemy(m) - own(m);
    }
  }

  // Upfront rules that fix a unit type's stance, so the searches only look at the layouts that can matter:
  //  1. Bombers are always on stance 2 (stance 1 is the strategic raid, which the calculator does not model).
  //  2. Dice only count if the other side has something they can hit. Air dice only hit air units, land/sea dice only
  //     hit land/sea units. If the other side has no air units the air dice are worthless; if it has no land/sea
  //     units the land/sea dice are. A stance that is no better on any useful kind of die and no better on hit
  //     points than another stance of the same unit (and worse on one) can never win, so the unit goes on the other.
  // Returns { type: [n1, n2] } with all units of such a type on the fixed stance.
  function forcedStances(mode, units, enemyHasAir, enemyHasLS) {
    const forced = {};
    for (const [t, sts] of Object.entries(W.STANCES[mode])) {
      if (sts.length !== 2) continue;
      const total = ((units[t] || [0, 0])[0] | 0) + ((units[t] || [0, 0])[1] | 0);
      if (!total) continue;
      if (t === 'bomber') { forced[t] = [0, total]; continue; }
      const hp = (st) => st.hp || W.TYPES[t].hp;
      const A = (st) => (enemyHasAir ? st.air : 0), L = (st) => (enemyHasLS ? st.ls : 0);
      const beats = (b, a) => A(b) >= A(a) && L(b) >= L(a) && hp(b) >= hp(a) && (A(b) > A(a) || L(b) > L(a) || hp(b) > hp(a));
      if (beats(sts[1], sts[0])) forced[t] = [0, total];
      else if (beats(sts[0], sts[1])) forced[t] = [total, 0];
    }
    return forced;
  }
  const countOf = (c) => ((c || [0, 0])[0] | 0) + ((c || [0, 0])[1] | 0);
  const hasAir = (units) => Object.entries(units).some(([t, c]) => W.TYPES[t].domain === 'air' && countOf(c) > 0);
  const hasLS = (units) => Object.entries(units).some(([t, c]) => W.TYPES[t].domain !== 'air' && countOf(c) > 0);

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function recommend(cfg, f, opts) {
    opts = opts || {};
    let screenRuns = opts.screenRuns || 500;
    const finalRuns = opts.finalRuns || 6000;
    const maxEvals = opts.maxEvals || 320, onProgress = opts.onProgress || (() => {});
    const types = Object.keys(W.STANCES[cfg.mode]);
    const forced = forcedStances(cfg.mode, cfg.sides[f].units, hasAir(cfg.sides[1 - f].units), hasLS(cfg.sides[1 - f].units));
    const totals = {}, vars = [];
    for (const t of types) {
      const c = (cfg.sides[f].units[t] || [0, 0]); totals[t] = c[0] + c[1];
      if (totals[t] > 0 && W.STANCES[cfg.mode][t].length > 1 && !forced[t]) vars.push(t);
    }
    const enemyUnits = Object.fromEntries(types.map((t) => [t, sum(cfg.sides[1 - f].units[t] || [0, 0])]));
    const ownUnits = Object.fromEntries(types.map((t) => [t, totals[t] || 0]));
    const ctx = { enemy: landCostOfMap(enemyUnits), own: landCostOfMap(ownUnits) };   // land-unit production costs
    // Control only exists in land battles (a sea battle captures nothing), so the goal is dropped at sea.
    // opts.holder = who currently holds the land (0, 1 or null = not specified). If I hold it, taking control is
    // meaningless, so only "keep control" is offered; if the enemy holds it, only "take control".
    const holder = opts.holder === 0 || opts.holder === 1 ? opts.holder : null;
    const objectives = cfg.mode === 'land'
      ? OBJECTIVES.filter((o) => !(o === 'control' && holder === f) && !(o === 'hold' && holder === 1 - f))
      : OBJECTIVES.filter((o) => o !== 'control' && o !== 'hold');
    if (!vars.length && !Object.keys(forced).length) return null;

    const toCfg = (vec, seed) => {
      const sides = [cfg.sides[0], cfg.sides[1]].map((sd) => ({ ...sd, units: { ...sd.units } }));
      for (const t of Object.keys(forced)) sides[f].units[t] = forced[t].slice();
      vars.forEach((t, i) => { sides[f].units[t] = [vec[i], totals[t] - vec[i]]; });
      return { mode: cfg.mode, first: 0, fightToEnd: false, sides, seed };
    };
    const key = (v) => v.join(',');
    const cache = new Map();             // screening results
    let evals = 0;
    const budgetLeft = () => evals < maxEvals;
    async function screen(vec) {
      const k = key(vec);
      if (cache.has(k)) return cache.get(k);
      evals++; onProgress(Math.min(0.8, evals / maxEvals * 0.8));
      await tick();
      const m = metricsOf(W.simulate(toCfg(vec, 1234567), screenRuns), f);
      const r = { vec: vec.slice(), m };
      cache.set(k, r); return r;
    }

    const cur = vars.map((t) => Math.min(totals[t], (cfg.sides[f].units[t] || [0, 0])[0]));
    const combos = vars.reduce((n, t) => n * (totals[t] + 1), 1);
    if (!opts.screenRuns && combos <= 150) screenRuns = 1200;     // few layouts: afford precise screening (differences can be tiny)
    if (combos <= 150) {                                   // small enough to try everything
      const rec = (i, v) => i === vars.length ? [v.slice()] :
        Array.from({ length: totals[vars[i]] + 1 }, (_, a) => rec(i + 1, [...v, a])).flat();
      for (const v of rec(0, [])) await screen(v);
    } else {
      const starts = [cur, vars.map((t) => totals[t]), vars.map(() => 0)];
      for (const obj of objectives) {
        for (const st of starts) {
          let best = await screen(st);
          while (budgetLeft()) {
            const cands = [];
            vars.forEach((t, i) => {
              for (const a of new Set([best.vec[i] - 1, best.vec[i] + 1, 0, totals[t]])) {
                if (a < 0 || a > totals[t] || a === best.vec[i]) continue;
                const v = best.vec.slice(); v[i] = a; cands.push(v);
              }
            });
            let improved = false;
            for (const v of cands) {
              if (!budgetLeft() && !cache.has(key(v))) continue;
              const r = await screen(v);
              if (score(obj, r.m, ctx) > score(obj, best.m, ctx) + 1e-9) { best = r; improved = true; }
            }
            if (!improved) break;
          }
        }
      }
    }

    // Re-test the best few candidates per objective with many more runs and a fresh seed.
    const finals = new Map();
    async function final(v) {
      const k = key(v);
      if (finals.has(k)) return finals.get(k);
      await tick();
      const m = metricsOf(W.simulate(toCfg(v, 7654321), finalRuns), f);
      finals.set(k, { vec: v.slice(), m }); return finals.get(k);
    }
    const all = [...cache.values()];
    const shortlist = new Map();
    for (const obj of objectives) {
      all.sort((a, b) => score(obj, b.m, ctx) - score(obj, a.m, ctx));
      all.slice(0, 5).forEach((r) => shortlist.set(key(r.vec), r.vec));
    }
    shortlist.set(key(cur), cur);
    let done = 0;
    for (const v of shortlist.values()) { await final(v); onProgress(0.8 + 0.2 * (++done / shortlist.size)); }

    const options = objectives.map((obj) => {
      let best = null;
      for (const r of finals.values()) if (!best || score(obj, r.m, ctx) > score(obj, best.m, ctx)) best = r;
      return { objective: obj, vec: best.vec, units: unitsOf(best.vec), metrics: best.m };
    });
    function unitsOf(v) {
      const u = {}; for (const t of Object.keys(forced)) u[t] = forced[t].slice();
      vars.forEach((t, i) => { u[t] = [v[i], totals[t] - v[i]]; }); return u;
    }
    const current = finals.get(key(cur));
    onProgress(1);
    return { side: f, evals, options, current: { units: unitsOf(cur), metrics: current.m }, finalRuns };
  }

  // "I set my stances first and the opponent sees them": a layout of mine is worth its score against the
  // opponent's best reply (the layout of theirs that scores worst for me on the same goal); I pick the layout
  // with the best such guarantee. Solved with an adversarial-set loop (cutting planes): keep a set O of enemy
  // layouts, pick my layout that is best against all of O, ask for the enemy's true best reply to that layout
  // over ITS WHOLE space, add it to O, repeat until no reply beats what O already contains. The expensive
  // reply search therefore runs only for the few layouts that ever look best, instead of for every layout.
  async function recommendFirst(cfg, f, opts) {
    opts = opts || {};
    let screenRuns = opts.screenRuns || 150;
    const finalRuns = opts.finalRuns || 4000;
    const maxEvals = opts.maxEvals || 60000, onProgress = opts.onProgress || (() => {});
    const EXACT = 300, MAX_ROUNDS = 40;                    // enumerate a side's layouts when it has at most this many
    const e = 1 - f;
    const types = Object.keys(W.STANCES[cfg.mode]);
    const space = (s) => {
      const forced = forcedStances(cfg.mode, cfg.sides[s].units, hasAir(cfg.sides[1 - s].units), hasLS(cfg.sides[1 - s].units));
      const totals = {}, vars = [];
      for (const t of types) {
        const c = (cfg.sides[s].units[t] || [0, 0]); totals[t] = c[0] + c[1];
        if (totals[t] > 0 && W.STANCES[cfg.mode][t].length > 1 && !forced[t]) vars.push(t);
      }
      const cur = vars.map((t) => Math.min(totals[t], (cfg.sides[s].units[t] || [0, 0])[0]));
      return { totals, vars, forced, cur, combos: vars.reduce((n, t) => n * (totals[t] + 1), 1) };
    };
    const me = space(f), op = space(e);
    if (!me.vars.length && !Object.keys(me.forced).length) return null;
    // Few layouts: screen precisely. Layouts can differ by a fraction of a point, far below the noise of a short run.
    if (!opts.screenRuns) { const pairsN = Math.min(me.combos, 300) * Math.min(op.combos, 300); screenRuns = pairsN <= 400 ? 1500 : pairsN <= 3000 ? 400 : 150; }
    const holder = opts.holder === 0 || opts.holder === 1 ? opts.holder : null;
    const objectives = cfg.mode === 'land'
      ? OBJECTIVES.filter((o) => !(o === 'control' && holder === f) && !(o === 'hold' && holder === e))
      : OBJECTIVES.filter((o) => o !== 'control' && o !== 'hold');
    const sumLand = (s) => landCostOfMap(Object.fromEntries(types.map((t) => [t, s.totals[t] || 0])));
    const ctx = { enemy: sumLand(op), own: sumLand(me) };

    const key = (v) => v.join(',');
    const unitsOf = (sp, v) => { const u = {}; for (const t of Object.keys(sp.forced)) u[t] = sp.forced[t].slice(); sp.vars.forEach((t, i) => { u[t] = [v[i], sp.totals[t] - v[i]]; }); return u; };
    const enumerate = (sp) => {
      const rec = (i, v) => i === sp.vars.length ? [v.slice()] :
        Array.from({ length: sp.totals[sp.vars[i]] + 1 }, (_, a) => rec(i + 1, [...v, a])).flat();
      return rec(0, []);
    };
    const neighbours = (sp, v) => {
      const out = [];
      sp.vars.forEach((t, i) => {
        for (const a of new Set([v[i] - 1, v[i] + 1, 0, sp.totals[t]])) {
          if (a < 0 || a > sp.totals[t] || a === v[i]) continue;
          const w = v.slice(); w[i] = a; out.push(w);
        }
      });
      return out;
    };
    const starts = (sp) => [sp.cur, sp.vars.map((t) => sp.totals[t]), sp.vars.map(() => 0)];
    const pairCfg = (vm, vo, seed) => {
      const sides = [cfg.sides[0], cfg.sides[1]].map((sd) => ({ ...sd, units: { ...sd.units } }));
      for (const t of Object.keys(me.forced)) sides[f].units[t] = me.forced[t].slice();
      for (const t of Object.keys(op.forced)) sides[e].units[t] = op.forced[t].slice();
      me.vars.forEach((t, i) => { sides[f].units[t] = [vm[i], me.totals[t] - vm[i]]; });
      op.vars.forEach((t, i) => { sides[e].units[t] = [vo[i], op.totals[t] - vo[i]]; });
      return { mode: cfg.mode, first: 0, fightToEnd: false, sides, seed };
    };

    let evals = 0, lastTick = Date.now();
    const maybeTick = async () => { if (Date.now() - lastTick > 40) { await tick(); lastTick = Date.now(); } };
    const pairs = new Map();                               // my layout | their layout -> metrics (screening dice)
    async function pair(vm, vo) {
      const k = key(vm) + '|' + key(vo);
      let r = pairs.get(k);
      if (!r) {
        evals++; await maybeTick();
        const out = W.simulate(pairCfg(vm, vo, 1234567), screenRuns);
        r = { vo: vo.slice(), m: metricsOf(out, f), e: metricsOf(out, e) };
        pairs.set(k, r);
      }
      return r;
    }
    const myAll = me.combos <= EXACT ? enumerate(me) : null;
    const opAll = op.combos <= EXACT ? enumerate(op) : null;

    // The enemy's best reply to vm on goal obj over its whole space: exhaustive when small, otherwise a hill
    // climb from several starts (their current layout, extremes and the replies already known to hurt).
    async function bestReply(vm, obj, known, scOverride) {
      const sc = scOverride || ((r) => score(obj, r.m, ctx));
      let best = null;
      const consider = (r) => { if (!best || sc(r) < sc(best)) best = r; };
      if (opAll) { for (const vo of opAll) consider(await pair(vm, vo)); return best; }
      for (const st of [...starts(op), ...known]) {
        let cur = await pair(vm, st); consider(cur);
        for (;;) {
          let improved = false;
          for (const vo of neighbours(op, cur.vo)) {
            const r = await pair(vm, vo); if (sc(r) < sc(cur) - 1e-9) { cur = r; improved = true; }
          }
          if (!improved) break;
        }
        consider(cur);
      }
      return best;
    }

    const found = new Map();                               // obj -> [{ vec, s }] candidates, best first
    for (let oi = 0; oi < objectives.length; oi++) {
      const obj = objectives[oi];
      const sc = (r) => score(obj, r.m, ctx);
      const O = new Map([[key(op.cur), op.cur]]);          // enemy layouts that have hurt so far
      // worst score of vm over O, newest (most damaging) replies first; gives up early (returns an upper
      // bound) once it falls below `cut`, since such a layout cannot reach the leaders anyway
      const guarantee = async (vm, cut) => {
        let w = Infinity;
        for (const vo of [...O.values()].reverse()) {
          w = Math.min(w, sc(await pair(vm, vo)));
          if (w < cut) break;
        }
        return w;
      };
      // my best layouts against everything in O (exhaustive when small, else hill climb with extra starts)
      const argmax = async (prev) => {
        const memo = new Map();
        let third = -Infinity;                              // value of the 5th best so far (the shortlist size)
        const val = async (v) => {
          const k = key(v);
          if (!memo.has(k)) {
            memo.set(k, { vec: v.slice(), s: await guarantee(v, third) });
            const top = [...memo.values()].map((x) => x.s).sort((a, b) => b - a);
            third = top.length >= 5 ? top[4] : -Infinity;
          }
          return memo.get(k);
        };
        if (myAll) { for (const v of myAll) await val(v); }
        else {
          for (const st of [...starts(me), ...prev]) {
            let cur = await val(st);
            for (;;) {
              let improved = false;
              for (const v of neighbours(me, cur.vec)) { const x = await val(v); if (x.s > cur.s + 1e-9) { cur = x; improved = true; } }
              if (!improved) break;
            }
          }
        }
        return [...memo.values()].sort((a, b) => b.s - a.s);
      };
      let ranked = [], prev = [];
      for (let it = 0; it < MAX_ROUNDS; it++) {
        ranked = await argmax(prev);
        prev = ranked.slice(0, 3).map((x) => x.vec);
        let grew = false;
        // every one of the leading layouts must survive its own true worst reply, not just the leader
        for (const x of ranked.slice(0, 3)) {
          const rep = await bestReply(x.vec, obj, [...O.values()]);
          if (sc(rep) < x.s - 1e-9 && !O.has(key(rep.vo))) { O.set(key(rep.vo), rep.vo); grew = true; break; }   // leader refuted: re-rank first
        }
        onProgress(Math.min(0.85, (oi + Math.min(1, (it + 1) / 12)) / objectives.length * 0.85 + 0));
        if (!grew || evals > maxEvals) break;
      }
      found.set(obj, ranked.slice(0, 5));
    }

    // Re-test each goal's leaders at full precision on fresh dice against their worst replies.
    const finalPairs = new Map();
    async function finalPair(vm, vo) {
      const k = key(vm) + '|' + key(vo);
      if (!finalPairs.has(k)) { await tick(); const out = W.simulate(pairCfg(vm, vo, 7654321), finalRuns); finalPairs.set(k, { vo: vo.slice(), m: metricsOf(out, f), e: metricsOf(out, e) }); }
      return finalPairs.get(k);
    }
    async function guaranteed(vm, obj) {                   // worst of the 5 worst known replies, at full precision
      const rows = [];
      for (const [k, r] of pairs) if (k.startsWith(key(vm) + '|')) rows.push(r);
      rows.sort((a, b) => score(obj, a.m, ctx) - score(obj, b.m, ctx));
      let worst = null;
      for (const t of rows.slice(0, 4)) {
        const r = await finalPair(vm, t.vo);
        if (!worst || score(obj, r.m, ctx) < score(obj, worst.m, ctx)) worst = r;
      }
      return worst;
    }
    // Opponent-move prediction: for a layout of mine, what the opponent would answer if THEIR goal were each of
    // their own goals (not necessarily the opposite of mine), and how that turns out for me.
    const ctxE = { enemy: ctx.own, own: ctx.enemy };
    const eObjectives = cfg.mode === 'land'
      ? OBJECTIVES.filter((o) => !(o === 'control' && holder === e) && !(o === 'hold' && holder === f))
      : OBJECTIVES.filter((o) => o !== 'control' && o !== 'hold');
    async function predict(vm) {
      const outP = [];
      for (const eo of eObjectives) {
        const rep = await bestReply(vm, null, [], (r) => -score(eo, r.e, ctxE));   // the reply that is best for them
        const fin = await finalPair(vm, rep.vo);
        outP.push({ objective: eo, reply: unitsOf(op, rep.vo), metrics: fin.m });
      }
      return outP;
    }
    const options = [];
    let done = 0;
    for (const obj of objectives) {
      let best = null;
      for (const x of found.get(obj)) {
        const w = await guaranteed(x.vec, obj); const s = score(obj, w.m, ctx);
        if (!best || s > best.s) best = { vec: x.vec, w, s };
      }
      options.push({
        objective: obj, vec: best.vec, units: unitsOf(me, best.vec), metrics: best.w.m,
        reply: unitsOf(op, best.w.vo),
        predictions: await predict(best.vec),
      });
      onProgress(0.85 + 0.15 * (++done / objectives.length));
    }
    onProgress(1);
    return { side: f, order: 'first', evals, options, finalRuns, enemyObjectives: eObjectives };
  }

  const api = { recommend, recommendFirst, OBJECTIVES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WarRoomRec = api;
})(typeof window !== 'undefined' ? window : globalThis);
