/* author : Hugo Joudrier-Faure */
/* PaceYourRide — plan d'alimentation et d'hydratation d'une sortie, et « coach » qui le suit en temps réel.
 *
 * Le plan (planNutrition) part de la stratégie de puissance : la consommation de glucides et la sueur y sont calculées avec les
 * modèles de fuel.js (glycogène, digestion, absorption par deux voies), puis on cherche le plus petit apport horaire de glucides qui
 * garde la réserve de glycogène au-dessus de 30 % jusqu'à l'arrivée, sans dépasser 90 % du plafond d'absorption de l'intestin.
 * Repères de départ (Jeukendrup 2014) : rien sous 45 min, ≈ 30 g/h vers 1 h, 50 g/h entre 1 h 15 et 2 h 15, 65 g/h jusqu'à 3 h, 80 g/h
 * au-delà ; plus si l'effort est intense, moins s'il est facile. Boisson : on remplace ≈ 65 % de la sueur.
 *
 * Le coach (createCoach) ne suit pas un horaire figé : il se cale sur ce que le cycliste a vraiment pris (« dans N min » après la dernière
 * prise), reporte un rappel pendant un gros effort, l'avance quand la réserve baisse ou que la déshydratation s'installe, et se tait
 * quand l'arrivée est trop proche pour que la prise serve. */
(function (PYR) {
  'use strict';

  const Fu = PYR.fuel;

  const MIN_FOOD_GAP = 720;      // s : jamais deux prises solides à moins de 12 min
  const MIN_DRINK_GAP = 480;     // s : jamais deux gorgées de rappel à moins de 8 min
  const G_FLOOR = 0.30;          // fraction de la réserve de glycogène à ne pas passer sous
  const NO_FOOD_LAST = 1200;     // s : pas de prise solide dans les 20 dernières minutes (trop tard pour servir)
  const GELS = ['gel', 'gelglu', 'gelplus', 'gelcaf'], BARS = ['bar', 'barmini'];

  /** Moyenne des puissances P[a..b[ (a, b en s). */
  function meanP(P, a, b) {
    a = Math.max(0, Math.floor(a)); b = Math.min(P.length, Math.ceil(b));
    if (b <= a) return P.length ? P[Math.min(P.length - 1, a)] : 0;
    let s = 0;
    for (let k = a; k < b; k++) s += P[k];
    return s / (b - a);
  }

  /** Premier contenant du matériel qui contient quelque chose : {idx, mix, carbs (g/L)} ou null. */
  function mainDrink(kit) {
    const k = Fu.normKit(kit);
    const filled = [];
    k.slots.forEach((mix, i) => { if (mix) filled.push({ idx: filled.length, mix, carbs: Fu.MIXES[mix].carbs }); });
    return filled.length ? filled[0] : null;
  }

  /** Stock restant par catégorie : { gel: [kind…], bar: [kind…] } avec les nombres. */
  function stockOf(kit) {
    const items = Fu.normKit(kit).items;
    return { items: Object.assign({}, items), gels: GELS.reduce((a, k) => a + items[k], 0), bars: BARS.reduce((a, k) => a + items[k], 0) };
  }

  /**
   * Choisit l'aliment d'une prise : une barre quand l'effort est facile (digestion lente, on a le temps de mâcher), sinon un gel ;
   * à défaut, ce qui reste. `stock` : nombre de chaque aliment, décrémenté. Renvoie null quand il n'y a plus rien.
   */
  function pickFood(stock, easy) {
    const first = (list) => list.find((k) => stock[k] > 0) || null;
    const gel = first(GELS), bar = first(BARS);
    const kind = easy ? bar || gel : gel || bar;
    if (kind) stock[kind]--;
    return kind;
  }

  /**
   * Plan d'alimentation. o : {P (puissance du plan par seconde, W), dur (s, durée prévue), mass (kg), cp, ftp (W), tempC (°C),
   * gut (0–1, entraînement de l'intestin), kit ({slots, items}, voir fuel.normKit), startG (part de glycogène au départ, 1)}.
   * Renvoie { mode, carbsPerH, fluidPerH (L/h), food: {everyS, firstS}, drink: {everyS, firstS, sip (L), mix},
   *           events: [{t, type: 'eat'|'drink', kind}], needs: {gels, bars, liters, carbs}, have: {...},
   *           sim: {minG, endG, lossPct, gutMax}, warnings: [texte] }.
   */
  function planNutrition(o) {
    const kit = Fu.normKit(o.kit);
    const P = o.P, dur = Math.max(60, Number(o.dur) || P.length);
    const n = Math.min(P.length, Math.ceil(dur));
    const mass = o.mass > 0 ? o.mass : 72, cp = o.cp > 0 ? o.cp : 250, ftp = o.ftp > 0 ? o.ftp : cp;
    const temp = Number.isFinite(o.tempC) ? o.tempC : 20;
    const hours = dur / 3600;
    const caps = Fu.caps(o.gut);
    const warnings = [];

    let burn = 0, sweat = 0, sumP = 0;
    for (let k = 0; k < n; k++) { burn += Fu.carbRate(P[k], cp); sweat += Fu.sweatRate(P[k], temp); sumP += P[k]; }
    const sweatH = n ? sweat / n * 3600 : 0.5;
    const ifm = n ? sumP / n / ftp : 0.7;

    // boisson : ≈ 65 % de la sueur, une gorgée de rappel toutes les 8 à 25 min
    const drinkMain = mainDrink(kit);
    const fluidH = hours < 0.5 ? 0.25 : Math.min(0.9, Math.max(0.35, 0.65 * sweatH));
    const sip = Fu.SIP;
    const drinkEvery = drinkMain ? Math.round(Math.min(1500, Math.max(MIN_DRINK_GAP, sip / fluidH * 3600))) : 0;
    const drinkFirst = Math.min(600, drinkEvery || 600);
    const drinkCarbH = drinkMain && drinkEvery ? sip * drinkMain.carbs / drinkEvery * 3600 : 0;

    // apport de glucides visé (g/h), borné par ce que l'intestin absorbe
    const stock0 = stockOf(kit);
    let fruShare = 0, carbTot = 0;
    for (const k of Fu.FOOD_IDS) { const c = stock0.items[k] * Fu.FOODS[k].carbs; fruShare += c * Fu.FOODS[k].fructose; carbTot += c; }
    if (drinkMain) { const c = Fu.MIXES[drinkMain.mix].carbs; fruShare += c * Fu.MIXES[drinkMain.mix].fructose; carbTot += c; }
    const dual = carbTot > 0 && fruShare / carbTot >= 0.12;
    const ceil = 0.9 * (dual ? caps.mix : caps.glucose);
    let base = hours < 0.75 ? 0 : hours < 1.25 ? 30 : hours < 2.25 ? 50 : hours < 3 ? 65 : 80;
    if (base > 0 && ifm > 0.85) base += 10;
    if (base > 0 && ifm < 0.55) base = Math.round(base * 0.7);
    base = Math.min(base, ceil);

    const build = (target) => {
      const foodH = Math.max(0, target - drinkCarbH);
      const events = [];
      const stock = Object.assign({}, stock0.items);
      let foodEvery = 0, foodFirst = 0, short = false;
      if (foodH >= 8 && stock0.gels + stock0.bars > 0) {
        const per = (stock0.gels * 25 + stock0.bars * 35) / (stock0.gels + stock0.bars);
        foodEvery = Math.round(Math.min(3600, Math.max(MIN_FOOD_GAP, per / foodH * 3600)));
        foodFirst = Math.min(foodEvery, hours < 1.25 ? 1200 : 900);
        for (let t = foodFirst; t < dur - NO_FOOD_LAST; t += foodEvery) {
          const easy = meanP(P, t - 60, t + 60) < 0.75 * ftp;
          const kind = pickFood(stock, easy);
          if (!kind) { short = true; break; }
          events.push({ t, type: 'eat', kind });
        }
      } else if (foodH >= 8) short = true;
      if (drinkEvery) for (let t = drinkFirst; t < dur; t += drinkEvery) events.push({ t, type: 'drink', kind: 'drink', slot: drinkMain.idx });
      events.sort((a, b) => a.t - b.t);
      return { events, foodEvery, foodFirst, short, stock };
    };

    // simulation de la sortie avec ces prises : réserve de glycogène minimale, déshydratation à l'arrivée
    const simulate = (events) => {
      const f = Fu.create(mass, { slots: kit.slots, items: kit.items, gutTraining: o.gut });
      f.G = f.G0 * (o.startG > 0 ? Math.min(1, o.startG) : 1);
      let minG = f.G / f.G0, gutMax = 0, i = 0;
      for (let t = 0; t < n; t++) {
        while (i < events.length && events[i].t <= t) {
          const e = events[i++];
          if (e.type === 'eat') { f.items[e.kind] = Math.max(1, f.items[e.kind]); Fu.eat(f, t, e.kind, true); } else Fu.drink(f, t, e.slot);
        }
        Fu.step(f, P[t], cp, temp);
        const g = f.G / f.G0;
        if (g < minG) minG = g;
        if (f.gut > gutMax) gutMax = f.gut;
      }
      return { minG, endG: f.G / f.G0, lossPct: Fu.lossPct(f), gutMax };
    };

    let target = base, plan = build(target), sim = simulate(plan.events);
    while (sim.minG < G_FLOOR && target + 10 <= ceil + 1e-9) {
      target += 10;
      plan = build(target);
      sim = simulate(plan.events);
    }
    if (sim.minG < G_FLOOR) warnings.push(`Même au plafond d'absorption, la réserve de glycogène descend à ${Math.round(sim.minG * 100)} % : allège l'effort ou prévois un ravitaillement.`);

    // matériel nécessaire / disponible
    const need = { gels: 0, bars: 0, liters: 0, carbs: 0 };
    for (const e of plan.events) {
      if (e.type === 'eat') { if (GELS.includes(e.kind)) need.gels++; else need.bars++; need.carbs += Fu.FOODS[e.kind].carbs; } else { need.liters += sip; need.carbs += sip * (drinkMain ? drinkMain.carbs : 0); }
    }
    const capacity = kit.slots.reduce((a, mix, i) => a + (mix ? Fu.CONTAINERS[Fu.SLOTS[i]].cap : 0), 0);
    // la boisson qu'on finit par boire n'est pas qu'une gorgée de rappel : le besoin total en liquide est fluidH × durée
    const fluidNeed = fluidH * hours;
    if (hours >= 0.5 && capacity < 0.85 * fluidNeed) warnings.push(`Environ ${fluidNeed.toFixed(1).replace('.', ',')} L à boire pour ${capacity.toFixed(1).replace('.', ',')} L emportés : prévois de remplir en route.`);
    if (plan.short) warnings.push('Pas assez de gels et de barres pour tenir l\'apport visé : ajoutes-en ou prévois un ravitaillement.');
    if (target >= ceil - 1e-9 && target > 0 && hours > 2.5 && !dual) warnings.push('Avec du glucose seul, l\'absorption plafonne vers 60 g/h : prends des gels « double source » (glucose + fructose) pour aller plus haut.');

    return {
      mode: target <= 0 ? 'none' : hours < 1.25 ? 'light' : 'full',
      carbsPerH: Math.round(target), fluidPerH: fluidH, burnPerH: n ? burn / n * 3600 : 0, sweatPerH: sweatH,
      food: { everyS: plan.foodEvery, firstS: plan.foodFirst },
      drink: { everyS: drinkEvery, firstS: drinkFirst, sip, slot: drinkMain ? drinkMain.idx : -1, mix: drinkMain ? drinkMain.mix : '' },
      events: plan.events, need, sim, warnings,
      have: { gels: stock0.gels, bars: stock0.bars, liters: capacity },
    };
  }

  /**
   * Coach de la sortie : tient la date de la dernière prise et dit, à chaque instant, ce qui est à prendre.
   * nut : résultat de planNutrition. Renvoie { eat, drink, taken(kind, t), state() }.
   *   update(t, c) avec c = { P3 (W, moyenne 3 s), cp, G (part de glycogène, 0–1), lossPct, remaining (s avant l'arrivée prévue),
   *   easy (vrai si l'effort à venir est facile), stock {gels, bars} } → { eat: {inS, kind, urgent, deferred} | null, drink: {...} | null }.
   * inS : secondes avant la prise (négatif : en retard) ; urgent : la réserve ou l'hydratation l'exige.
   */
  function createCoach(nut) {
    const st = { lastEat: null, lastDrink: null };
    const defer = (inS, c) => (inS <= 0 && c.P3 > 1.05 * c.cp ? { inS: 20, deferred: true } : { inS, deferred: false });
    return {
      get lastEat() { return st.lastEat; },
      get lastDrink() { return st.lastDrink; },
      taken(type, t) { if (type === 'eat') st.lastEat = t; else st.lastDrink = t; },
      restore(s) { st.lastEat = s && s.lastEat !== undefined ? s.lastEat : null; st.lastDrink = s && s.lastDrink !== undefined ? s.lastDrink : null; },
      update(t, c) {
        const out = { eat: null, drink: null };
        const d = nut.drink;
        if (d.everyS) {
          let due = (st.lastDrink === null ? d.firstS : st.lastDrink + d.everyS) - t;
          const urgent = c.lossPct > 1.5;
          if (urgent) due = Math.min(due, 0);
          const r = defer(due, c);
          out.drink = { inS: r.inS, deferred: r.deferred, urgent, kind: 'drink' };
        }
        const fd = nut.food;
        if (fd.everyS && c.remaining > NO_FOOD_LAST * 0.5) {
          let due = (st.lastEat === null ? fd.firstS : st.lastEat + fd.everyS) - t;
          // réserve basse : on ne se fie plus à l'horaire
          const low = c.G < 0.45 && (st.lastEat === null || t - st.lastEat > 420);
          if (low) due = Math.min(due, 0);
          const last = c.remaining < NO_FOOD_LAST && !low;   // arrivée proche : une prise de plus ne servira plus
          if (!last) {
            const r = defer(due, c);
            const total = c.stock.gels + c.stock.bars;
            const easy = c.easy && c.stock.bars > 0;
            out.eat = { inS: r.inS, deferred: r.deferred, urgent: low, kind: total <= 0 ? null : easy ? 'bar' : c.stock.gels > 0 ? 'gel' : 'bar', empty: total <= 0 };
          }
        }
        return out;
      },
    };
  }

  PYR.nutrition = { planNutrition, createCoach, pickFood, mainDrink, stockOf, GELS, BARS, MIN_FOOD_GAP, MIN_DRINK_GAP, G_FLOOR, NO_FOOD_LAST };
})(globalThis.PYR = globalThis.PYR || {});
