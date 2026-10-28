/* author : Hugo Joudrier-Faure */
/* PaceYourRide — énergie et hydratation en course.
 *   - Glycogène : réserve ≈ 6,5 g/kg de glucides ; la consommation croît avec la puissance et avec
 *     la part des glucides dans l'énergie (≈ 50 % en endurance, 90 % au seuil).
 *   - Digestion : ce qu'on mange ou boit passe d'abord par l'estomac, avec un délai selon l'aliment
 *     (boisson : rapide ; gel : un peu de délai ; barre : digestion puis vidange lentes), puis par
 *     l'intestin, où l'absorption suit deux voies indépendantes, chacune avec son plafond :
 *       · glucose (transporteur SGLT1) : ≈ 60 g/h ;
 *       · fructose (transporteur GLUT5) : ≈ 30 g/h.
 *     Du glucose seul plafonne donc à 60 g/h ; un mélange glucose + fructose (gels et boissons « double
 *     source », 2 : 1) monte à ≈ 90 g/h. Un intestin entraîné à tolérer les glucides en course ajoute
 *     jusqu'à +10 g/h de glucose et +20 g/h de fructose (≈ 120 g/h au total).
 *     Références : Jeukendrup (2014, Sports Med) ; Currell et Jeukendrup (2008, MSSE) ; Rowlands et al. (2015).
 *   - Sueur : 0,3 à 1,5 L/h selon la puissance et la température.
 *   - Fringale sous 20 % de glycogène (jusqu'à −30 % de capacité à vide) ; déshydratation
 *     au-delà de 1,5 % du poids du corps (−2,5 % de capacité par % supplémentaire).
 * Modèle physiologique (metabo.js, `kit.physio` = carte athlète) : ce module garde les poches, les bidons et la digestion, et le
 * corps devient celui du modèle couplé — glycogène des fibres I et II et du foie, glycémie, sueur selon la thermorégulation, eau
 * absorbée par l'intestin, sodium, caféine. La capacité (factor, wFactor) est alors la signature effective du modèle. */
(function (PYR) {
  'use strict';

  const KJ_PER_G = 17;          // énergie des glucides (kJ/g)
  const EFFICIENCY = 0.21;      // rendement brut du pédalage
  const SIP = 0.15;             // L par gorgée
  const EAT_COOLDOWN = 20, DRINK_COOLDOWN = 8; // s
  const POCKETS = { gel: 6, bar: 4 };    // ce que les poches peuvent contenir (par catégorie : tous les gels, toutes les barres)
  const MUSETTE = { gel: 3, bar: 2 };    // contenu d'une musette de ravitaillement (en plus des bidons pleins) : gels et barres de base
  const BOTTLE = 0.5;                    // L par bidon

  // Contenants emportés : jusqu'à 3 bidons de 0,5 L et un camelback (poche à eau dans le dos) de 1,5 L ; chacun a son contenu (voir MIXES).
  // L'ordre est celui des emplacements du matériel (SLOTS) et des bidons de `status().containers`.
  const CONTAINERS = {
    bottle: { label: 'Bidon', cap: BOTTLE },
    camelback: { label: 'Camelback', cap: 1.5 },
  };
  const SLOTS = ['bottle', 'bottle', 'bottle', 'camelback'];

  // Aliments : glucides (g), part de fructose, délai avant que l'estomac commence à se vider (s, digestion)
  // et demi-vie de la vidange (s). `cat` : gel ou barre (les poches se remplissent par catégorie).
  const FOODS = {
    gel: { label: 'gel', name: 'Gel double source', cat: 'gel', carbs: 25, fructose: 1 / 3, lag: 60, half: 480 },    // gel double source (2 : 1)
    gelglu: { label: 'gel glucose', name: 'Gel glucose seul', cat: 'gel', carbs: 25, fructose: 0, lag: 60, half: 480 }, // glucose seul : plafonne à 60 g/h
    gelplus: { label: 'gel haute dose', name: 'Gel haute dose', cat: 'gel', carbs: 40, fructose: 1 / 3, lag: 90, half: 600 }, // plus de glucides, plus lent
    bar: { label: 'barre', name: 'Barre', cat: 'bar', carbs: 40, fructose: 0.15, lag: 300, half: 720 },              // barre : surtout du glucose
    barmini: { label: 'mini-barre', name: 'Mini-barre', cat: 'bar', carbs: 20, fructose: 0.15, lag: 240, half: 600 },
    // gel caféiné : 100 mg de caféine (≈ 1,4 mg/kg à 70 kg) ; elle n'agit qu'avec le modèle physiologique (effort perçu plus faible)
    gelcaf: { label: 'gel caféiné', name: 'Gel caféiné (100 mg)', cat: 'gel', carbs: 25, fructose: 1 / 3, lag: 60, half: 480, caf: 100 },
  };
  const FOOD_IDS = Object.keys(FOODS);
  const DRINK = { fructose: 1 / 3, half: 300 };                                // boisson double source (2 : 1)

  // Contenus des bidons : glucides (g/L), part de fructose, demi-vie de la vidange gastrique (s) et part de l'eau bue qui hydrate vraiment
  // (une boisson hypertonique, plus concentrée que le sang, appelle de l'eau dans l'intestin : elle hydrate moins). L'« énergétique »
  // (isotonique, 6 %) est la boisson d'origine du jeu : 60 g/L, double source, vidange à la demi-vie DRINK.half.
  // na : sodium (mmol/L), qui compte avec le modèle physiologique (natrémie).
  const MIXES = {
    water: { label: 'Eau', carbs: 0, fructose: 0, half: DRINK.half, hyd: 1, na: 0 },
    hypo: { label: 'Hypotonique', carbs: 25, fructose: 1 / 3, half: 240, hyd: 1, na: 15 },
    iso: { label: 'Énergétique (isotonique)', carbs: 60, fructose: DRINK.fructose, half: DRINK.half, hyd: 1, na: 20 },
    hyper: { label: 'Hypertonique', carbs: 100, fructose: 1 / 3, half: 480, hyd: 0.7, na: 20 },
  };

  // Plafonds d'absorption (g/h) : intestin non entraîné, et gain d'un intestin entraîné (0 → 1)
  const GLUCOSE_CAP = 60, FRUCTOSE_CAP = 30, GLUCOSE_GAIN = 10, FRUCTOSE_GAIN = 20;
  /** Entraînement de l'intestin : niveaux proposés (0 = non entraîné, 1 = très entraîné). */
  const GUT_LEVELS = [
    { value: 0, label: 'Non entraîné' },
    { value: 0.5, label: 'Habitué' },
    { value: 1, label: 'Très entraîné' },
  ];

  const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);
  /** Part de l'estomac vidée à chaque seconde pour une demi-vie donnée. */
  const emptyRate = (half) => 1 - Math.pow(0.5, 1 / half);
  const DRINK_RATE = emptyRate(DRINK.half);

  /** Plafonds d'absorption (g/h) d'un intestin d'entraînement train : {glucose, fructose, mix (les deux voies)}. */
  function caps(train) {
    const t = clamp01(Number(train) || 0);
    const glucose = GLUCOSE_CAP + GLUCOSE_GAIN * t, fructose = FRUCTOSE_CAP + FRUCTOSE_GAIN * t;
    return { glucose, fructose, mix: glucose + fructose };
  }

  /**
   * Matériel emporté, normalisé : { slots: [contenu | '' pour chaque emplacement de SLOTS], items: { aliment: nombre } }.
   * `slots` : « water », « hypo », « iso » ou « hyper » (vide : pas de contenant) ; `items` : au plus POCKETS par catégorie (gels, barres).
   * Par défaut : deux bidons d'énergétique, 3 gels et 2 barres (le matériel d'origine du jeu).
   */
  function normKit(raw) {
    raw = raw || {};
    const slots = SLOTS.map((_, i) => {
      if (!Array.isArray(raw.slots)) return i < 2 ? 'iso' : '';
      return MIXES[raw.slots[i]] ? raw.slots[i] : '';
    });
    const items = {};
    for (const k of FOOD_IDS) items[k] = 0;
    const src = raw.items || { gel: 3, bar: 2 };
    const room = { gel: POCKETS.gel, bar: POCKETS.bar };
    for (const k of FOOD_IDS) {
      const n = Math.max(0, Math.floor(Number(src[k]) || 0)), cat = FOODS[k].cat;
      items[k] = Math.min(n, room[cat]);
      room[cat] -= items[k];
    }
    return { slots, items };
  }

  /**
   * Réserves au départ. mass : poids du cycliste (kg) ; kit : {slots, items} (voir normKit) ou {bottles, gels, bars}, et gutTraining (0–1) ;
   * avec `physio` (carte athlète de metabo.card) et `physioOpts` (état de départ, metabo.create), le corps est celui du modèle physiologique.
   */
  function create(mass, kit) {
    kit = kit || {};
    const m = Number(mass) > 0 ? Number(mass) : 72;
    const G0 = 6.5 * m;
    // contenants : d'après les emplacements du matériel, sinon (anciens réglages) n bidons d'énergétique
    let cont;
    if (kit.slots) {
      cont = [];
      normKit(kit).slots.forEach((mix, i) => { if (mix) cont.push({ type: SLOTS[i], cap: CONTAINERS[SLOTS[i]].cap, mix }); });
    } else {
      cont = new Array(kit.bottles !== undefined ? kit.bottles : 2).fill(0).map(() => ({ type: 'bottle', cap: BOTTLE, mix: 'iso' }));
    }
    const items = {};
    for (const k of FOOD_IDS) items[k] = 0;
    if (kit.slots || kit.items) Object.assign(items, normKit(kit).items);
    else { items.gel = kit.gels !== undefined ? kit.gels : 3; items.bar = kit.bars !== undefined ? kit.bars : 2; }
    const f = {
      mass: m, G0, G: G0, deficit: 0, net: 0,
      train: clamp01(Number(kit.gutTraining) || 0),
      // glucides avalés, pas encore dans le sang : estomac (boisson, aliments en cours de digestion) puis intestin
      stom: { drink: { glu: 0, fru: 0 }, items: [] }, int: { glu: 0, fru: 0 }, gut: 0, absorbing: 0,
      cont, bottles: cont.map((c) => c.cap), // volume restant de chaque contenant (L), dans l'ordre de `cont`
      items,
      lastEat: -1e9, lastDrink: -1e9, burned: 0, eatenG: 0, drunkL: 0, drunkG: 0, cafMg: 0,
      phy: null,
    };
    // modèle physiologique : le glycogène est celui des trois stocks du modèle (fibres I, fibres II, foie)
    if (kit.physio && PYR.metabo) {
      const Mx = PYR.metabo;
      f.phy = { card: kit.physio, s: Mx.create(kit.physio, kit.physioOpts) };
      f.G0 = Mx.glycogenCap(kit.physio);
      f.G = Mx.glycogen(f.phy.s);
    }
    return f;
  }

  /** Nombre d'aliments d'une catégorie (« gel » ou « bar ») dans les poches. */
  const count = (f, cat) => FOOD_IDS.reduce((a, k) => a + (FOODS[k].cat === cat ? f.items[k] || 0 : 0), 0);
  /** Premier aliment de la catégorie encore en stock (null s'il n'y en a plus). */
  const pick = (f, cat) => FOOD_IDS.find((k) => FOODS[k].cat === cat && f.items[k] > 0) || null;

  /** Glucides consommés (g/s) à la puissance P, pour une puissance critique cp. */
  function carbRate(P, cp) {
    const r = cp > 0 ? Math.max(0, P) / cp : 0;
    const share = Math.min(0.95, Math.max(0.15, 0.15 + 0.75 * Math.pow(r, 1.5)));
    const metabolic = Math.max(0, P) / EFFICIENCY + 90; // W, métabolisme de base compris
    return metabolic * share / (KJ_PER_G * 1000);
  }

  /** Sueur (L/s) à la puissance P et à la température tempC. */
  function sweatRate(P, tempC) {
    const t = Number.isFinite(tempC) ? tempC : 20;
    return (0.3 + 0.5 * Math.max(0, P) / 300) * Math.max(0.4, 1 + (t - 15) / 20) / 3600;
  }

  /** Glucides (g) avalés et pas encore absorbés, dans l'estomac et dans l'intestin : {stomach, intestine, glucose, fructose}. */
  function pending(f) {
    let sg = f.stom.drink.glu, sf = f.stom.drink.fru;
    for (const it of f.stom.items) { sg += it.glu; sf += it.fru; }
    return { stomach: sg + sf, intestine: f.int.glu + f.int.fru, glucose: sg + f.int.glu, fructose: sf + f.int.fru };
  }

  /** Une seconde de digestion : l'estomac se vide dans l'intestin, qui absorbe par ses deux voies. Renvoie les g absorbés. */
  function digest(f) {
    const d = f.stom.drink;
    if (d.glu + d.fru > 0) {
      const a = d.glu * DRINK_RATE, b = d.fru * DRINK_RATE;
      d.glu = d.glu - a < 1e-6 ? 0 : d.glu - a; d.fru = d.fru - b < 1e-6 ? 0 : d.fru - b;
      f.int.glu += a; f.int.fru += b;
    }
    for (let i = f.stom.items.length - 1; i >= 0; i--) {
      const it = f.stom.items[i];
      if (it.lag > 0) { it.lag--; continue; }
      const a = it.glu * it.rate, b = it.fru * it.rate;
      it.glu -= a; it.fru -= b; f.int.glu += a; f.int.fru += b;
      if (it.glu + it.fru < 0.02) { f.int.glu += it.glu; f.int.fru += it.fru; f.stom.items.splice(i, 1); }
    }
    const c = caps(f.train);
    const spl = f.phy ? f.phy.s.mSpl : 1;   // modèle physiologique : moins de sang vers l'intestin à haute intensité et à la chaleur
    const aG = Math.min(f.int.glu, spl * c.glucose / 3600), aF = Math.min(f.int.fru, spl * c.fructose / 3600);
    f.int.glu -= aG; f.int.fru -= aF;
    return aG + aF;
  }

  /**
   * Une seconde de course. Avec le modèle physiologique, env décrit l'environnement de metabo.step (Ta, RH, sun, h, v, vAir, shelter,
   * remain) ; sans env, la température tempC seule.
   */
  function step(f, P, cp, tempC, env) {
    if (f.phy) { stepPhysio(f, P, env || { Ta: Number.isFinite(tempC) ? tempC : 20 }); return; }
    const burn = carbRate(P, cp);
    const abs = digest(f);
    f.absorbing = abs;
    const p = pending(f);
    f.gut = p.stomach + p.intestine;
    f.G = Math.min(f.G0, Math.max(0, f.G - burn + abs));
    f.net = abs - burn; // g/s : bilan de la seconde (apports absorbés − glucides brûlés)
    f.burned += burn;
    f.deficit += sweatRate(P, tempC);
  }

  /** Une seconde avec le modèle physiologique : digestion (ici), puis le corps (metabo.step) ; les réserves affichées en découlent. */
  function stepPhysio(f, P, env) {
    const Mx = PYR.metabo, s = f.phy.s, card = f.phy.card;
    const abs = digest(f);
    f.absorbing = abs;
    const p = pending(f);
    f.gut = p.stomach + p.intestine;
    const g0 = f.G, cho0 = s.choTot;
    Mx.step(card, s, P, env, { abs });
    f.G = Mx.glycogen(s);
    f.net = f.G - g0;                          // g/s : évolution des stocks de glycogène pendant la seconde
    f.burned += s.choTot - cho0;               // glucides oxydés (glycogène et glucose sanguin)
    f.deficit = s.water / 1000;                // L (négatif : plus d'eau bue que perdue)
  }

  /**
   * Recalage du modèle physiologique par la fréquence cardiaque mesurée hr (bpm), après le pas de la seconde (metabo.observeHR) ; l'eau
   * recalée est reportée sur le déficit. opts : {estimated (puissance estimée)}. Renvoie l'écart de la mesure, ou null sans le modèle.
   */
  function observeHR(f, hr, opts) {
    if (!f.phy) return null;
    const r = PYR.metabo.observeHR(f.phy.card, f.phy.s, hr, opts);
    f.deficit = f.phy.s.water / 1000;
    return r;
  }

  /** Perte d'eau en % du poids du corps. */
  function lossPct(f) { return Math.max(0, f.deficit) / f.mass * 100; }

  /** Facteur de capacité (1 = intact) : fringale × déshydratation ; avec le modèle physiologique, CP2 effective / CP2 fraîche. */
  function factor(f) {
    if (f.phy) return f.phy.s.f.cpK;
    const g = f.G / f.G0;
    const bonk = g < 0.2 ? 0.3 * Math.pow(1 - g / 0.2, 1.5) : 0;
    const dehyd = Math.min(0.2, Math.max(0, lossPct(f) - 1.5) * 0.025);
    return (1 - bonk) * (1 - dehyd);
  }

  /** Facteur propre au W′ (W′ effectif / W′ frais) : celui du modèle physiologique, sinon le facteur de capacité. */
  function wFactor(f) { return f.phy ? f.phy.s.f.wK : factor(f); }

  /**
   * Manger : kind = un aliment de FOODS (« gel », « gelglu », « gelplus », « bar », « barmini »), sinon le plus adapté (un gel quand la
   * réserve est basse, sinon une barre). Si l'aliment demandé manque, un autre de sa catégorie (puis de l'autre catégorie) le remplace,
   * sauf avec `strict` (choix précis du joueur dans ses poches). Renvoie le nom de l'aliment ou null.
   */
  function eat(f, t, kind, strict) {
    if (t - f.lastEat < EAT_COOLDOWN) return null;
    if (!kind) kind = (f.G / f.G0 < 0.35 && pick(f, 'gel')) || pick(f, 'bar') || pick(f, 'gel') || 'gel';
    if (!FOODS[kind]) return null;
    if (!(f.items[kind] > 0)) {
      if (strict) return null;
      kind = pick(f, FOODS[kind].cat) || pick(f, FOODS[kind].cat === 'gel' ? 'bar' : 'gel');
      if (!kind) return null;
    }
    f.items[kind]--;
    const food = FOODS[kind];
    f.stom.items.push({ glu: food.carbs * (1 - food.fructose), fru: food.carbs * food.fructose, lag: food.lag, rate: emptyRate(food.half) });
    f.gut += food.carbs;
    f.eatenG += food.carbs;
    if (food.caf) { f.cafMg += food.caf; if (f.phy) PYR.metabo.caffeine(f.phy.s, food.caf); }
    f.lastEat = t;
    return food.label;
  }

  /**
   * Boire une gorgée au contenant n° `idx` (bidon ou camelback, avec son contenu : eau, hypotonique, énergétique, hypertonique) ; sans
   * `idx`, au premier contenant qui n'est pas vide. Une boisson sucrée apporte ses glucides (vidange gastrique selon sa concentration),
   * une boisson hypertonique hydrate moins. Renvoie le volume bu (L) ou 0.
   */
  function drink(f, t, idx) {
    if (t - f.lastDrink < DRINK_COOLDOWN) return 0;
    const i = idx === undefined || idx === null ? f.bottles.findIndex((b) => b > 0.001) : idx;
    if (i < 0 || !(f.bottles[i] > 0.001)) return 0;
    const mix = MIXES[f.cont[i].mix] || MIXES.iso;
    const q = Math.min(SIP, f.bottles[i]);
    f.bottles[i] -= q;
    // modèle physiologique : l'eau passe par l'estomac puis l'intestin (1,2 L/h au plus), avec son sodium ; sinon elle hydrate aussitôt
    if (f.phy) PYR.metabo.drink(f.phy.s, q * 1000 * mix.hyd, mix.na);
    else f.deficit = Math.max(0, f.deficit - q * mix.hyd);
    const carbs = q * mix.carbs;
    if (carbs > 0) {
      const glu = carbs * (1 - mix.fructose), fru = carbs * mix.fructose;
      if (mix.half === DRINK.half) { f.stom.drink.glu += glu; f.stom.drink.fru += fru; } // vidange habituelle d'une boisson
      else f.stom.items.push({ glu, fru, lag: 0, rate: emptyRate(mix.half) });          // plus rapide (hypotonique) ou plus lente (hypertonique)
      f.gut += carbs;
      f.drunkG += carbs;
    }
    f.drunkL += q;
    f.lastDrink = t;
    return q;
  }

  /**
   * Musette de ravitaillement : contenants remplis (chacun avec son contenu), gels et barres de base ajoutés dans la limite des poches
   * (par catégorie). Renvoie ce qui a été ajouté {gels, bars, liters}.
   */
  function resupply(f) {
    const add = (cat) => Math.max(0, Math.min(MUSETTE[cat], POCKETS[cat] - count(f, cat)));
    const gels = add('gel'), bars = add('bar');
    f.items.gel += gels;
    f.items.bar += bars;
    let liters = 0;
    for (let i = 0; i < f.bottles.length; i++) { liters += f.cont[i].cap - f.bottles[i]; f.bottles[i] = f.cont[i].cap; }
    return { gels, bars, liters };
  }

  /** Reste-t-il peu de vivres (3 gels ou barres au plus, ou moins de 0,6 L à boire) ? */
  function runningLow(f) {
    const s = status(f);
    return s.gels + s.bars <= 3 || s.fluid < 0.6;
  }

  /** Coureurs virtuels : ils mangent et boivent quand il le faut. */
  function autoFeed(f, t) {
    if (f.G / f.G0 < 0.55 || (f.G / f.G0 < 0.8 && f.gut < 10 && t > 1800)) eat(f, t);
    // modèle physiologique : l'eau encore dans l'estomac compte déjà (elle sera absorbée)
    const waiting = f.phy ? f.phy.s.fstom / 1000 / f.mass * 100 : 0;
    if (lossPct(f) - waiting > 0.8) drink(f, t);
  }

  /** Débit d'absorption possible (g/s) avec ce qui est en attente : une voie sans glucides en attente ne compte pas. */
  function ceilingNow(f) {
    const p = pending(f), c = caps(f.train);
    return ((p.glucose > 0.05 ? c.glucose : 0) + (p.fructose > 0.05 ? c.fructose : 0)) / 3600;
  }

  /** Temps (s) avant la fringale à la puissance P (Infinity si les apports suffisent). */
  function timeToBonk(f, P, cp) {
    if (f.phy) return PYR.metabo.timeToBonk(f.phy.card, f.phy.s, P, f.gut > 0.5 ? ceilingNow(f) * f.phy.s.mSpl : 0);
    const margin = f.G - 0.2 * f.G0;
    if (margin <= 0) return 0;
    const burn = carbRate(P, cp);
    // tant qu'il reste des glucides en attente, ils sont absorbés jusqu'au plafond des voies concernées
    const supply = Math.min(ceilingNow(f), burn);
    const t1 = f.gut > 0 && supply > 0 ? f.gut / supply : 0;
    const net1 = burn - supply;
    if (net1 > 0 && margin <= net1 * t1) return margin / net1;
    return t1 + (margin - Math.max(0, net1) * t1) / burn;
  }

  function status(f) {
    const p = pending(f), c = caps(f.train);
    const phys = f.phy ? PYR.metabo.status(f.phy.card, f.phy.s, p.stomach + p.intestine) : null;
    const energy = f.G / f.G0;
    return {
      energy,
      // barre du glycogène : part des muscles et du foie dans la capacité totale (modèle physiologique seulement), puis part hachurée des glucides avalés
      split: phys ? { muscle: (phys.GI + phys.GII) / f.G0, liver: phys.GL / f.G0 } : null,
      gutFrac: Math.min(Math.max(f.gut / f.G0, 0), Math.max(0, 1 - energy)),
      // la même part, séparée en glucides dans l'intestin (en cours d'absorption) et dans l'estomac (pas encore digérés)
      gutParts: (() => {
        const tot = p.stomach + p.intestine, k = tot > 0 ? Math.min(Math.max(f.gut / f.G0, 0), Math.max(0, 1 - energy)) / tot : 0;
        return { intestine: p.intestine * k, stomach: p.stomach * k };
      })(),
      hydration: Math.max(0, 1 - lossPct(f) / 5),
      lossPct: lossPct(f),
      bonk: phys ? phys.bonk : f.G / f.G0 < 0.2,
      dehydrated: lossPct(f) > 2,
      phys,                                         // modèle physiologique : glycogène par stock, glycémie, températures, FC… (metabo.status)
      gut: f.gut,
      stomach: p.stomach, intestine: p.intestine,   // g avalés : dans l'estomac, dans l'intestin
      absorbing: f.absorbing * 3600,                // g/h absorbés en ce moment
      ceiling: ceilingNow(f) * 3600 || c.mix,       // g/h absorbables avec ce qui est en attente (les deux voies si rien n'attend)
      // évolution de la réserve par heure (fraction de la réserve) : négative tant qu'on brûle plus qu'on n'absorbe
      trend: f.net * 3600 / f.G0,
      gels: count(f, 'gel'), bars: count(f, 'bar'),     // tous les gels, toutes les barres
      fluid: f.bottles.reduce((a, b) => a + b, 0),
      stock: Object.assign({}, f.items),                // par aliment
      containers: f.cont.map((c, i) => ({ i, type: c.type, cap: c.cap, mix: c.mix, vol: f.bottles[i] })), // bidons et camelback : contenu et volume restant
    };
  }

  /** Minutes avant que la moitié d'un aliment ait quitté l'estomac (délai de digestion compris). */
  function halfMinutes(kind) {
    const food = kind === 'drink' ? { lag: 0, half: DRINK.half } : FOODS[kind];
    return (food.lag + food.half) / 60;
  }

  PYR.fuel = {
    FOODS, FOOD_IDS, DRINK, MIXES, CONTAINERS, SLOTS, GUT_LEVELS, POCKETS, MUSETTE, EAT_COOLDOWN, DRINK_COOLDOWN, SIP,
    caps, halfMinutes, pending, resupply, runningLow, normKit, count,
    create, carbRate, sweatRate, step, observeHR, lossPct, factor, wFactor, eat, drink, autoFeed, timeToBonk, status,
  };
})(globalThis.PYR = globalThis.PYR || {});
