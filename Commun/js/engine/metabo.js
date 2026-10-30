/* author : Hugo Joudrier-Faure */
/* PaceYourRide — modèle physiologique et métabolique couplé du cycliste (pas de 1 s), d'après le rapport « Modèle physiologique
 * du cycliste » (v1.1, `PaceYourRide/DocModelePhysioCycliste.html` ; voir aussi `PaceYourRide/documentation.html`). La signature de puissance (Pmax, W′, CP2 ≡ puissance critique,
 * CP1 ≈ premier seuil SV1) est modulée par une couche lente et par la commande centrale :
 *   - recrutement (principe de taille de Henneman) : la puissance aérobie se partage entre fibres I (jusqu'à CP1e), IIa et IIx ;
 *   - coût : un rendement par groupe de fibres (qui baisse avec leur fatigue), part anaérobie au-dessus de CP2e, métabolisme de base ;
 *   - substrats : cloche d'oxydation lipidique (MFO à FATmax), glucides par différence, pour chaque groupe de fibres ;
 *   - trois stocks de glycogène (fibres I, fibres II, foie), glycémie, néoglucogenèse, cerveau, absorption intestinale ;
 *   - W′ interne à deux compartiments (phosphocréatine, glycolyse) : acidité, coût en glycogène des efforts au-dessus de CP2e ;
 *   - thermorégulation à deux compartiments (noyau, peau) à la manière de Gagge : convection, rayonnement, soleil, sueur (ISO 7933) ;
 *   - eau et sodium : sueur, respiration, eau métabolique, boisson absorbée (1,2 L/h au plus), natrémie (Edelman) ;
 *   - VO₂ (constante 30 s) et fréquence cardiaque prédite (Swain) avec dérive thermique et de déshydratation ;
 *   - fatigue périphérique ΦI (τ 12 h) et ΦII (τ 20 min), altitude (Bassett, Townsend), caféine (un compartiment), sommeil,
 *     motivation, fatigue mentale.
 * Couplage avec le simulateur (sim.js) : il garde W′bal (Skiba) et la courbe de puissance record des durées courtes ; ce module lui
 * fournit les facteurs de capacité CP2e / CP2₀ (st.capK) et W′e / W′₀ (st.wK), calculés avec l'état du pas précédent.
 * Les coefficients marqués « calage » dans le rapport sont repris tels quels : des ordres de grandeur à ajuster sur données réelles. */
(function (PYR) {
  'use strict';

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const max0 = (x) => (x > 0 ? x : 0);
  const sig = (x) => 1 / (1 + Math.exp(-x));
  const softplus = (x, s) => (x / s > 30 ? x : s * Math.log1p(Math.exp(x / s)));
  const num = (v, d) => (Number.isFinite(v) ? v : d);

  const LAMBDA = 2426;      // J/g, chaleur latente d'évaporation de la sueur
  const CBODY = 3470;       // J/kg/K, chaleur spécifique moyenne du corps
  const E_FAT = 39.4e3;     // J/g lipides
  const E_CHO = 16.5e3;     // J/g glucides (moyenne glucose / glycogène)
  const GNG = 0.2 / 60, BRAIN = 0.08 / 60;   // g/s : néoglucogenèse, consommation du cerveau
  const H_REF = 250;        // m : altitude des records (aucune pénalité en dessous)
  const BONK_G = 0.1;       // fringale : glycogène musculaire sous 10 % de la capacité
  const HYPO = 3.5;         // mmol/L : glycémie basse (alerte)

  // Glycogène → capacité (forme de Michaelis avec plancher) ; W′ y est plus sensible (racine)
  const K_G = 0.08, G_FLOOR = 0.55;
  const fG = (g) => { const x = clamp(g, 0, 1); return G_FLOOR + (1 - G_FLOOR) * (x * (1 + K_G)) / (x + K_G); };
  const fGW = (g) => 0.5 + 0.5 * Math.sqrt(clamp(g, 0, 1));
  const G_REF = fG(0.9);    // remplissage « normal » au départ : la signature saisie est celle d'un athlète frais et nourri

  /** Pression de vapeur saturante (Tetens), kPa. */
  const psat = (T) => 0.6108 * Math.exp((17.27 * T) / (T + 237.3));

  // Altitude : Bassett et al. 1999 (% de la puissance aérobie du niveau de la mer, x en km) ; Townsend et al. 2017 (W′)
  const bassettAcc = (x) => (-1.12 * x * x - 1.90 * x + 99.9) / 100;
  const bassettNon = (x) => (0.178 * x * x * x - 1.43 * x * x - 4.07 * x + 100) / 100;
  const townsendW = (x) => (x <= 2.76 ? 1 : Math.max(0.5, 1 - 0.183 * (x - 2.76)));
  function fAlt(hm, acc) {
    const x = Math.max(0, hm / 1000);
    return (1 - acc) * Math.min(1, bassettNon(x) / bassettNon(0)) + acc * Math.min(1, bassettAcc(x) / bassettAcc(0));
  }

  /** Surface corporelle (m², Du Bois 1916). */
  const duBois = (m, hcm) => 0.007184 * Math.pow(m, 0.425) * Math.pow(hcm, 0.725);

  /** Cloche d'oxydation lipidique (fraction de MFO) : maximum à Pf (FATmax), ≈ 35 % de MFO à CP2. */
  function fatBell(P, Pf, CP2) {
    const w = P <= Pf ? Pf / 1.27 : Math.max(20, (CP2 - Pf) / 1.0246);
    const z = (P - Pf) / w;
    return Math.exp(-z * z);
  }

  /** Puissance d'aérobie partagée entre les fibres I, IIa et IIx (minimum adouci). */
  function recruit(P, CP1, CP2, out) {
    const PI = Math.max(0, P - softplus(P - CP1, 35));
    const R = Math.max(0, P - PI);
    const PIIx = Math.min(R, softplus(P - 1.05 * CP2, 20));
    out.PI = PI; out.PIIa = R - PIIx; out.PIIx = PIIx;
    return out;
  }

  /* ---------- carte athlète ---------- */

  /**
   * Paramètres individuels de la carte athlète (page Athlète) : clé de `rider.physio`, libellé, unité, bornes, pas, groupe,
   * aide. Un champ vide prend la valeur estimée par `defaults`.
   */
  const FIELDS = [
    { key: 'cp1', label: 'CP1 (premier seuil, ≈ SV1)', unit: 'W', min: 50, max: 500, step: 1, group: 'thresholds',
      help: 'Limite entre intensité modérée et lourde : au-dessus, les fibres rapides (II) sont recrutées et se fatiguent. Par défaut 75 % de la PC.' },
    { key: 'hrRest', label: 'FC de repos', unit: 'bpm', min: 30, max: 100, step: 1, group: 'base', help: 'Sert à prédire ta fréquence cardiaque (réserve cardiaque, Swain 1997).' },
    { key: 'hrMax', label: 'FC maximale', unit: 'bpm', min: 120, max: 230, step: 1, group: 'base', help: 'Par défaut 208 − 0,7 × âge (Tanaka 2001).' },
    { key: 'vo2max', label: 'VO₂max', unit: 'mL/min/kg', min: 25, max: 95, step: 0.5, group: 'base',
      help: 'Par défaut, estimée depuis ta puissance sur 5 min (Hawley et Noakes, 1992).' },
    { key: 'fI', label: 'Fibres lentes (type I)', unit: '%', min: 20, max: 90, step: 1, group: 'base',
      help: 'Beaucoup de fibres I : bon rendement, bonne durabilité ; beaucoup de fibres II : sprint et W′. Par défaut estimée d\'après le rapport Pmax / PC de ta courbe.' },
    { key: 'mfo', label: 'Oxydation maximale des lipides (MFO)', unit: 'g/min', min: 0.15, max: 1.2, step: 0.01, group: 'fuel',
      help: 'Débit maximal de lipides brûlés (0,2 à 1 g/min ; 0,46 en moyenne, Venables 2005). Par défaut d\'après ta VO₂max.' },
    { key: 'fatmax', label: 'FATmax', unit: '% de CP1', min: 60, max: 110, step: 1, group: 'fuel', help: 'Puissance où les lipides sont le plus oxydés.' },
    { key: 'glyMuscle', label: 'Glycogène musculaire', unit: 'g', min: 150, max: 800, step: 5, group: 'fuel', help: 'Glycogène des muscles qui pédalent (300 à 450 g chez un cycliste entraîné).' },
    { key: 'glyLiver', label: 'Glycogène du foie', unit: 'g', min: 40, max: 160, step: 1, group: 'fuel', help: 'Il maintient la glycémie (80 à 100 g).' },
    { key: 'glyFill', label: 'Réserves au départ', unit: '%', min: 30, max: 100, step: 1, group: 'fuel', help: '90 % après un repas riche en glucides la veille, moins après une étape ou un régime pauvre en glucides.' },
    { key: 'sweatMax', label: 'Sudation maximale', unit: 'L/h', min: 0.6, max: 3.5, step: 0.1, group: 'heat', help: 'Se mesure en se pesant avant et après une sortie chaude (en comptant ce qui a été bu).' },
    { key: 'sweatNa', label: 'Sodium de la sueur', unit: 'mmol/L', min: 10, max: 100, step: 1, group: 'heat', help: 'De 10 à 90 mmol/L selon les personnes (patch de sueur) : sueur salée, besoin de sodium.' },
    { key: 'tcrit', label: 'Température critique', unit: '°C', min: 39, max: 41, step: 0.1, group: 'heat', help: 'Température centrale où la commande centrale s\'effondre (≈ 40 °C).' },
    { key: 'heatAcc', label: 'Acclimatation à la chaleur', unit: '%', min: 0, max: 100, step: 5, group: 'heat', help: '100 % après 10 à 14 jours d\'exposition : plus de sueur, moins salée, moins de dérive cardiaque.' },
    { key: 'altAcc', label: 'Acclimatation à l’altitude', unit: '%', min: 0, max: 100, step: 5, group: 'heat', help: '100 % après plusieurs semaines en altitude : la puissance aérobie y baisse moins.' },
    { key: 'buffer', label: 'Pouvoir tampon (β)', unit: '×', min: 0.7, max: 1.4, step: 0.05, group: 'mind', help: 'Plus de 1 : plus de travail glycolytique avant l\'acidose (trait de puncheur, bêta-alanine, bicarbonate).' },
    { key: 'cafHalf', label: 'Demi-vie de la caféine', unit: 'h', min: 2, max: 12, step: 0.5, group: 'mind', help: 'De 2 à plus de 10 h selon la génétique (CYP1A2) : un gel caféiné du soir se paie sur la nuit.' },
  ];
  const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
  // les seuils (CP1) s'affichent avec la signature de puissance (CP2, W′, Pmax, FTP) de la page Athlète, hors de ces groupes
  const GROUPS = { base: 'Cœur, fibres', fuel: 'Lipides et glycogène', heat: 'Chaleur, eau et altitude', mind: 'Acidose et caféine' };

  const round = (x, d) => { const k = Math.pow(10, d || 0); return Math.round(x * k) / k; };

  /** VO₂max (mL/min/kg) d'après la puissance maximale sur 5 min p5 (W) et la masse (kg) : Hawley et Noakes 1992 (L/min). */
  const vo2maxFromP5 = (p5, mass) => (0.01141 * p5 + 0.435) * 1000 / mass;

  /**
   * Valeurs estimées de la carte (dans les unités des champs) pour un cycliste `rider` (poids, taille, âge, sexe, intestin) dont
   * l'athlète `athlete` (physio.buildAthlete : cp, w0, pmax, mmp) donne la signature.
   */
  function defaults(rider, athlete) {
    rider = rider || {};
    const mass = Number(rider.weight) > 0 ? Number(rider.weight) : 72;
    const age = Number(rider.age) > 0 ? Number(rider.age) : 35;
    const cp = athlete && athlete.cp > 0 ? athlete.cp : 250;
    const pmax = athlete && athlete.pmax > 0 ? athlete.pmax : 3.7 * cp;
    const p5 = athlete && athlete.mmp ? athlete.mmp(300) : cp * 1.2;
    const vo2 = vo2maxFromP5(p5, mass);
    return {
      cp1: Math.round(0.75 * cp),
      vo2max: round(vo2, 1),
      hrRest: 55,
      hrMax: Math.round(208 - 0.7 * age),
      fI: Math.round(100 * clamp(0.92 - 0.1 * pmax / cp, 0.3, 0.8)),
      mfo: round(0.6 * clamp(vo2 / 62, 0.6, 1.25) * (rider.sex === 'f' ? 0.85 : 1), 2),
      fatmax: 90,
      glyMuscle: Math.round(5.7 * mass / 5) * 5,
      glyLiver: 90,
      glyFill: 90,
      sweatMax: 1.6,
      sweatNa: 45,
      tcrit: 40,
      heatAcc: 0,
      altAcc: 0,
      buffer: 1,
      cafHalf: 5,
    };
  }

  /** Valeur saisie d'un champ (bornée), ou null si le champ est vide ou invalide. */
  function userValue(physio, key) {
    const v = physio ? physio[key] : undefined;
    if (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) return null;
    const f = FIELD[key];
    return clamp(Number(v), f.min, f.max);
  }

  /**
   * Carte athlète complète, dans les unités du modèle, d'après le cycliste (champs `rider.physio`, vides = estimés) et sa signature
   * (`athlete` de physio.buildAthlete). `src[key]` vaut 'saisie' ou 'estimée'.
   */
  function card(rider, athlete) {
    rider = rider || {};
    const d = defaults(rider, athlete);
    const v = {}, src = {};
    for (const f of FIELDS) {
      const u = userValue(rider.physio, f.key);
      v[f.key] = u === null ? d[f.key] : u;
      src[f.key] = u === null ? 'estimée' : 'saisie';
    }
    const mass = Number(rider.weight) > 0 ? Number(rider.weight) : 72;
    const height = Number(rider.height) > 0 ? Number(rider.height) : 178;
    const cp = athlete && athlete.cp > 0 ? athlete.cp : 250;
    const fI = v.fI / 100;
    const gut = PYR.fuel ? PYR.fuel.caps(rider.gut).mix : 90;
    const c = {
      mass, height, sex: rider.sex === 'f' ? 'f' : 'm', age: Number(rider.age) > 0 ? Number(rider.age) : 35,
      Pmax: athlete && athlete.pmax > 0 ? athlete.pmax : 3.7 * cp,
      Wp: athlete && athlete.w0 > 0 ? athlete.w0 / 1000 : 20,
      CP2: cp, CP1: Math.min(0.95 * cp, v.cp1),
      fI, VO2max: v.vo2max * mass / 1000, HRrest: v.hrRest, HRmax: Math.max(v.hrMax, v.hrRest + 40),
      MFO: v.mfo, kFat: v.fatmax / 100,
      GIcap: v.glyMuscle * fI, GIIcap: v.glyMuscle * (1 - fI), GLcap: v.glyLiver, gluFill: v.glyFill / 100,
      SRmax: v.sweatMax, NaSweat: v.sweatNa, Tcrit: v.tcrit, heatAcc: v.heatAcc / 100, altAcc: v.altAcc / 100,
      beta: v.buffer, cafHalf: v.cafHalf,
      gutMax: gut / 60,                 // g/min : absorption maximale (digestion interne, sans fuel.js)
      // calage du rapport
      epsI: 0.245, epsII: 0.215, B: 1.5, alpha: 0.7, Ap: 0.3, cafEmax: 0.045, cafEC50: 2.5,
      values: v, src,
    };
    return finish(c);
  }

  /** Grandeurs dérivées de la carte (surface corporelle, capacités thermiques, eau totale…). */
  function finish(c) {
    c.area = duBois(c.mass, c.height);
    c.Vd = 0.2 * c.mass;                       // L : volume de distribution du glucose
    c.Ccore = 0.85 * c.mass * CBODY; c.Cskin = 0.15 * c.mass * CBODY;
    c.TBW0 = 0.6 * c.mass;                     // L : eau totale
    c.VO2rest = 0.0042 * c.mass;               // L/min
    c.pcrFrac = 0.35 / (0.35 + 0.65 * c.beta); // part PCr du W′ interne (un tampon plus fort agrandit la part glycolytique)
    return c;
  }

  /**
   * Carte à l'échelle d'un athlète modifié (forme du jour, marge, niveau d'un coureur virtuel) : CP2 et CP1 × kcp, W′ et Pmax × kw.
   */
  function scaleCard(c, kcp, kw) {
    return Object.assign({}, c, { CP2: c.CP2 * kcp, CP1: c.CP1 * kcp, Wp: c.Wp * kw, Pmax: c.Pmax * kw });
  }

  /** Capacité de glycogène (g) : fibres I + fibres II + foie. */
  const glycogenCap = (c) => c.GIcap + c.GIIcap + c.GLcap;

  /* ---------- état ---------- */

  /**
   * État de départ. opts : {phiI (fatigue résiduelle des fibres I), awakeH (heures d'éveil au départ), nightShort (nuit courte),
   * motivation (−1 à 1), mental (fatigue mentale, 0 à 1), fill (remplissage du glycogène, sinon celui de la carte)}.
   */
  function create(c, opts) {
    opts = opts || {};
    const fill = Number.isFinite(opts.fill) ? clamp(opts.fill, 0, 1) : c.gluFill;
    const s = {
      t: 0, Tc: 37.0, Tsk: 33.5,
      GI: c.GIcap * fill, GII: c.GIIcap * fill, GL: c.GLcap * fill,
      Glu: 5.0 * 0.18 * c.Vd,                  // g de glucose dans le sang (5 mmol/L)
      stomach: 0, gut: 0, fstom: 0, fstomNa: 0,  // digestion interne (g), eau dans l'estomac (mL) et son sodium (mmol)
      water: 0, NaLoss: 0, NaIn: 0,            // déficit en eau (g), sodium perdu et absorbé (mmol)
      PhiI: clamp(Number(opts.phiI) || 0, 0, 0.9), PhiII: 0, VO2: c.VO2rest,
      WpPCr: c.pcrFrac * c.Wp, WpGly: (1 - c.pcrFrac) * c.Wp,
      cafGut: 0, cafC: 0, absPrev: 0, mSpl: 1,
      mind: {
        awakeH: Number(opts.awakeH) || 0, nightShort: !!opts.nightShort,
        motivation: clamp(Number(opts.motivation) || 0, -1, 1), mental: clamp(Number(opts.mental) || 0, 0, 1),
      },
      // bilans
      choTot: 0, fatTot: 0, exoTot: 0, sweatTot: 0, drinkTot: 0, kJ: 0, minGlu: 99, maxTc: 0, maxDehy: 0, minNa: 999,
      f: {}, fT: -1, m: {}, o: null, env: null,
      kf: null,                                // recalage par la FC mesurée (observeHR), créé à la première mesure
    };
    factors(c, s, null);
    return s;
  }

  const DEF_ENV = { Ta: 20, RH: 50, sun: 0, h: 0, v: 8, vAir: 8, shelter: 0, remain: Infinity };

  /**
   * Facteurs de la couche lente et de la perception, calculés avec l'état courant (écrits dans s.f, rendus) :
   * signature effective (CP2e, CP1e, W′e, Pmaxe) et facteurs de capacité pour le simulateur (cpK, wK).
   */
  function factors(c, s, env) {
    env = env || s.env || DEF_ENV;
    const f = s.f;
    const gI = s.GI / c.GIcap, gII = s.GII / c.GIIcap, gL = s.GL / c.GLcap;
    const glu = s.Glu / (0.18 * c.Vd);
    const dehy = s.water / (c.mass * 1000) * 100;
    const a = c.heatAcc;
    const Ta = num(env.Ta, 20), h = num(env.h, 0);
    const mT = 1 - (0.05 * max0(s.Tc - 38.3) + 0.015 * max0(s.Tsk - 34)) * (1 - 0.3 * a);
    const mHyd = 1 - 0.025 * max0(dehy - 1.5) * (1 + 0.05 * max0(Ta - 25));
    const mAlt = Math.min(1, fAlt(h, c.altAcc) / fAlt(H_REF, c.altAcc));
    const mAltW = townsendW(h / 1000);
    const caf = c.cafEmax * s.cafC / (s.cafC + c.cafEC50);
    const VA_T = 1 - 0.25 * sig((s.Tc - (c.Tcrit + 0.3 * a)) / 0.15);
    const VA_glu = 1 - 0.2 * sig((3.3 - glu) / 0.25);
    const md = s.mind;
    const VA_sleep = md.nightShort ? 1 - 0.004 * (md.awakeH + s.t / 3600) : 1;
    const VA_mot = 1 + 0.02 * md.motivation + (num(env.remain, Infinity) < 2000 && md.motivation >= 0 ? 0.015 : 0);
    const VA_men = 1 - 0.02 * md.mental;
    const VA = clamp(VA_T * VA_glu * (1 + caf) * VA_sleep * VA_mot * VA_men, 0.6, 1.08);
    const gMix = c.fI * fG(gI) + (1 - c.fI) * fG(gII);
    const gly = Math.min(1, gMix / G_REF);
    const envF = mT * mHyd * mAlt;
    const cpK = gly * (1 - 0.25 * (s.PhiI + s.PhiII)) * envF * VA;
    const CP2e = c.CP2 * cpK;
    const CP1e = Math.min(0.95 * CP2e, c.CP1 * Math.min(1, fG(gI) / G_REF) * (1 - s.PhiI) * envF * VA);
    const wK = Math.min(1, fGW(gII) / fGW(Math.max(c.gluFill, 0.9))) * (1 - s.PhiII) * mAltW;
    const pmaxK = (1 - 0.5 * s.PhiII) * VA;
    f.gI = gI; f.gII = gII; f.gL = gL; f.glu = glu; f.dehy = dehy;
    f.mT = mT; f.mHyd = mHyd; f.mAlt = mAlt; f.mAltW = mAltW; f.envF = envF;
    f.caf = caf; f.VA = VA; f.VA_T = VA_T; f.VA_glu = VA_glu; f.VA_other = VA / Math.max(1e-6, VA_T * VA_glu);
    f.gMix = gMix; f.gly = gly; f.phi = 1 - 0.25 * (s.PhiI + s.PhiII);
    f.cpK = cpK; f.wK = wK; f.pmaxK = pmaxK;
    f.CP2e = CP2e; f.CP1e = CP1e; f.WpE = c.Wp * wK; f.PmaxE = c.Pmax * pmaxK;
    s.fT = s.t;
    return f;
  }

  /**
   * Métabolisme à la puissance P avec l'état courant et ses facteurs f (sans modifier l'état) : recrutement, dépense, chaleur,
   * lipides et glucides par groupe de fibres, part du glucose sanguin, glycogène musculaire utilisé. Écrit dans `out`.
   */
  function metab(c, s, f, P, out) {
    out = out || {};
    const Paero = P < f.CP2e ? P : f.CP2e, Pan = P - Paero;
    recruit(Paero, f.CP1e, f.CP2e, out);
    const PII = out.PIIa + out.PIIx;
    const eI = c.epsI * (1 - 0.08 * s.PhiI), eII = c.epsII * (1 - 0.08 * s.PhiII);
    const PmetI = c.B * c.mass + out.PI / eI, PmetII = PII / eII;
    const PmetA = PmetI + PmetII, Pmet = PmetA + Pan / 0.25;
    // lipides : cloche autour de FATmax, modulée par le glycogène, l'insuline, la durée et la chaleur
    const Pf = c.kFat * c.CP1 * f.envF * f.VA, CP2fat = c.CP2 * f.envF * f.VA;
    const gbar = c.fI * clamp(f.gI, 0, 1) + (1 - c.fI) * clamp(f.gII, 0, 1);
    const mIns = 1 - 0.2 * clamp(s.absPrev * 60 / 1.2, 0, 1);
    const mDur = 1 + 0.25 * (1 - Math.exp(-s.t / 2700));
    const mHeat = 1 - 0.1 * max0(s.Tc - 38.5);
    const fatG = c.MFO * fatBell(Paero, Pf, CP2fat) * (1 + 0.4 * (1 - gbar)) * mIns * mDur * Math.max(0.5, mHeat);   // g/min
    const Efat = Math.min(fatG * E_FAT / 60, 0.9 * PmetA);
    const fatI = Math.min(Efat, 0.95 * PmetI), fatII = Math.min(Efat - fatI, 0.5 * PmetII);
    const choI = (PmetI - fatI) / E_CHO, choII = (PmetII - fatII) / E_CHO;   // g/s
    // part couverte par le glucose sanguin (plus forte quand le glycogène baisse ou que des glucides sont absorbés)
    const glu = f.glu;
    const g3 = glu * glu * glu;
    const gluFac = (g3 * (125 + 64)) / (125 * (g3 + 64));
    const ins = 1 + 0.8 * clamp(s.absPrev * 60 / 1.2, 0, 1);
    const phiI = clamp((0.15 + 0.4 * (1 - clamp(f.gI, 0, 1))) * gluFac * ins, 0, 0.9);
    const phiII = clamp((0.05 + 0.25 * (1 - clamp(f.gII, 0, 1))) * gluFac * ins, 0, 0.8);
    const RdDes = phiI * choI + phiII * choII;
    const Rd = Math.min(RdDes, (2.0 / 60) * gluFac);
    const sc = RdDes > 0 ? Rd / RdDes : 1;
    out.P = P; out.Paero = Paero; out.Pan = Pan; out.PII = PII;
    out.Pmet = Pmet; out.PmetA = PmetA; out.heat = Pmet - P;
    out.fatG = (fatI + fatII) / E_FAT * 60; out.Efat = fatI + fatII;
    out.choI = choI; out.choII = choII; out.Rd = Rd; out.gluFac = gluFac;
    out.dGI = (1 - phiI * sc) * choI; out.dGII = (1 - phiII * sc) * choII;
    return out;
  }

  /** Débit d'eau et de sodium avalés (boisson) : ils passent par l'estomac avant d'être absorbés. mL d'eau, mmol/L de sodium. */
  function drink(s, mL, naMmolL) {
    if (!(mL > 0)) return;
    s.fstom += mL;
    s.fstomNa += mL / 1000 * (Number(naMmolL) || 0);
  }

  /** Caféine avalée (mg), absorbée ensuite (k_a ≈ 3 h⁻¹). */
  function caffeine(s, mg) { if (mg > 0) s.cafGut += mg; }

  const TH0 = {}, TH1 = {}, TH2 = {};   // bilans thermiques du pas et des deux sondes de la jacobienne (kfPredict)

  /**
   * Bilan thermique d'une seconde (noyau et peau, à la manière de Gagge) pour une température du noyau Tc et de la peau Tsk, avec le
   * métabolisme m du pas : écrit dans out dTc, dTsk (°C sur la seconde), SR (g/s de sueur) et les échanges (W) Eres, Conv, Rad, Sol, Ev.
   * Qx : chaleur en plus dans le noyau (W), estimée par le recalage sur la FC (0 sans lui).
   */
  function thermo(c, s, f, m, env, Tc, Tsk, Qx, out) {
    const a = c.heatAcc;
    const shelter = clamp(num(env.shelter, 0), 0, 1);
    const vAir = Math.max(0.5, num(env.vAir, num(env.v, 8)) * (1 - 0.3 * shelter));
    const hc = 8.3 * Math.pow(vAir, 0.6);
    const Ta = num(env.Ta, 20), RH = clamp(num(env.RH, 50), 0, 100);
    const Pa = (RH / 100) * psat(Ta);
    const Cres = 0.0014 * m.Pmet * (34 - Ta), Eres = 0.0173 * m.Pmet * (5.87 - Pa);
    const Tset = 36.9 + 2.0 * clamp(s.VO2 / c.VO2max, 0, 1);   // Saltin et Hermansen 1966
    const SkBF = Math.min(90, ((6.3 + 200 * max0(Tc - (Tset - 0.5))) / (1 + 0.5 * max0(34 - Tsk))) * (1 - 0.03 * max0(f.dehy)));
    const Kcs = (5.28 + 1.163 * SkBF) * c.area * (Tc - Tsk);
    const Conv = hc * c.area * (Tsk - Ta);
    const Rad = 4.7 * 0.7 * c.area * (Tsk - Ta);
    const Sol = c.alpha * c.Ap * max0(num(env.sun, 0));
    const Emax = Math.max(0, 16.5 * hc * c.area * 0.85 * (psat(Tsk) - Pa));
    const kc = 300 * (1 + 0.3 * a), Ton = Tset - 0.8 - 0.3 * a;
    const SRcap = (c.SRmax * (1 + 0.35 * a) * (1 - 0.05 * max0(f.dehy - 2))) / 3.6;   // g/s
    const SR = Math.min(Math.max(0, SRcap), (c.area * kc * max0(Tc - Ton) * Math.exp(max0(Tsk - 34) / 10.7)) / 3600);
    const Epot = LAMBDA * SR, w = Emax > 0 ? Epot / Emax : 9;
    const Ev = Math.min(Emax, Epot * (1 - Math.min(1, w) * Math.min(1, w) / 2));
    out.dTc = (m.heat + Qx - Kcs - Cres - Eres) / c.Ccore;
    out.dTsk = (Kcs - Conv - Rad + Sol - Ev) / c.Cskin;
    out.SR = SR; out.Eres = Eres; out.Conv = Conv; out.Rad = Rad; out.Sol = Sol; out.Ev = Ev;
    return out;
  }

  /** Natrémie (mmol/L) : sodium de départ − perdu + absorbé, dans l'eau totale qui reste (Edelman). */
  function natremia(c, s) {
    return (140 * c.TBW0 - s.NaLoss + s.NaIn) / Math.max(1, c.TBW0 - s.water / 1000);
  }

  /**
   * Fréquence cardiaque prédite (bpm) de l'état courant : la réserve cardiaque suit la réserve de VO₂ (Swain 1997), plus la dérive
   * thermique (8 bpm/°C au-dessus de 37,5 °C) et de déshydratation (3 bpm/%). Avec le recalage par la FC, les FC de repos et maximale
   * de la carte sont corrigées de leurs biais estimés. raw : sans les bornes FC de repos – FC max (ce que compare le filtre).
   */
  function predictHR(c, s, raw) {
    const k = s.kf;
    const rest = c.HRrest + (k ? k.x[0] : 0), max = c.HRmax + (k ? k.x[1] : 0);
    const fr = clamp((s.VO2 - c.VO2rest) / (c.VO2max - c.VO2rest), 0, 1);
    const dehy = s.water / (c.mass * 1000) * 100;
    const HR = rest + (max - rest) * fr + (8 * max0(s.Tc - 37.5) + 3 * max0(dehy)) * (1 - 0.3 * c.heatAcc);
    return raw ? HR : clamp(HR, rest, Math.max(rest + 40, max));
  }

  /**
   * Une seconde. P : puissance produite (W). env : {Ta (°C), RH (%), sun (W/m² au sol), h (altitude, m), v (vitesse, m/s),
   * vAir (vitesse de l'air sur le cycliste, m/s), shelter (part de traînée évitée à l'abri, 0–1), remain (m avant l'arrivée)}.
   * inp : {abs (g/s de glucides absorbés par l'intestin : digestion de fuel.js) | cho (g/s avalés : digestion interne),
   * fluid (mL/s bus), drinkNa (mmol/L)}.
   */
  function step(c, s, P, env, inp) {
    env = env || DEF_ENV;
    inp = inp || {};
    s.env = env;
    P = P > 0 ? P : 0;
    const f = s.fT === s.t ? s.f : factors(c, s, env);
    const m = metab(c, s, f, P, s.m);
    const a = c.heatAcc;

    // --- W′ interne (PCr, glycolyse) : vidange au-dessus de CP2e, recharge en dessous (constantes de Skiba 2012)
    const WpE = c.Wp * f.wK, pcrMax = c.pcrFrac * WpE, glyMax = (1 - c.pcrFrac) * WpE;
    if (s.WpPCr > pcrMax) s.WpPCr = pcrMax;
    if (s.WpGly > glyMax) s.WpGly = glyMax;
    let glyAn = 0;
    if (P > f.CP2e) {
      const drain = (P - f.CP2e) / 1000;
      const wP = 2 * s.WpPCr, wG = s.WpGly, tot = wP + wG + 1e-9;
      const dP = Math.min(s.WpPCr, drain * wP / tot), dG = Math.min(s.WpGly, drain - dP);
      s.WpPCr -= dP; s.WpGly -= dG;
      glyAn = dG * 1.33;                      // g de glycogène II par kJ glycolytique (lactate recyclé pour moitié)
    } else {
      const tauS = 546 * Math.exp(-0.01 * (f.CP2e - P)) + 316;
      const tauP = 0.1 * tauS / Math.max(0.5, f.mAlt);
      const tauG = 1.2 * tauS * (2 - fG(f.gII));
      s.WpPCr += (pcrMax - s.WpPCr) / tauP;
      s.WpGly += (glyMax - s.WpGly) / tauG;
    }
    const sGl = glyMax > 0 ? s.WpGly / glyMax : 0;

    // --- glycogène musculaire
    s.GI = Math.max(0, s.GI - m.dGI);
    s.GII = Math.max(0, s.GII - m.dGII - glyAn);

    // --- intestin : absorption (fuel.js, ou digestion interne : estomac τ 15 min, intestin τ 5 min), réduite à haute intensité et à la chaleur
    const mSpl = clamp(1 - 0.5 * clamp((P / Math.max(1, f.CP2e) - 0.75) / 0.4, 0, 1) - 0.25 * clamp(s.Tc - 38.5, 0, 1.5) / 1.5, 0.3, 1);
    s.mSpl = mSpl;
    let abs;
    if (Number.isFinite(inp.abs)) abs = Math.max(0, inp.abs);
    else {
      s.stomach += Math.max(0, Number(inp.cho) || 0);
      const ge = s.stomach / 900;
      s.stomach -= ge; s.gut += ge;
      abs = Math.min(s.gut / 300, (c.gutMax / 60) * mSpl);
      s.gut -= abs;
    }
    s.absPrev = abs;

    // --- foie et glycémie
    const glu = f.glu;
    const gL = clamp(f.gL, 0, 1);
    const fL = (gL * 1.1) / (gL + 0.1);
    const L = clamp(m.Rd + BRAIN - abs - GNG + 0.02 * (5 - glu), 0, (1.2 / 60) * fL);
    const store = glu > 6 ? Math.min(0.3 / 60, 0.003 * (glu - 6)) : 0;
    s.Glu = Math.max(0.5, s.Glu + abs + L + GNG - m.Rd - BRAIN - store);
    s.GL = clamp(s.GL + store - L, 0, c.GLcap);
    const Ra = abs + L + GNG, exo = Ra > 0 ? m.Rd * abs / Ra : 0;

    // --- thermorégulation (noyau, peau) ; avec le recalage par la FC, la chaleur en plus qu'il a estimée et la covariance du filtre
    const th = thermo(c, s, f, m, env, s.Tc, s.Tsk, s.kf ? s.kf.x[2] : 0, TH0);
    if (s.kf) kfPredict(c, s, f, m, env, th);
    const SR = th.SR, Eres = th.Eres, Sol = th.Sol, Ev = th.Ev, Conv = th.Conv, Rad = th.Rad;
    s.Tc += th.dTc;
    s.Tsk += th.dTsk;
    if (s.Tsk < 20) s.Tsk = 20;

    // --- eau et sodium
    drink(s, Math.max(0, Number(inp.fluid) || 0), inp.drinkNa);
    const fl = Math.min(s.fstom / 600, (1.2 / 3.6) * mSpl);   // mL/s : vidange de l'estomac, absorption ≤ 1,2 L/h
    const flNa = s.fstom > 1e-9 ? s.fstomNa * fl / s.fstom : 0;
    s.fstom -= fl; s.fstomNa = Math.max(0, s.fstomNa - flNa);
    const metW = 0.6 * (m.choI + m.choII) + 1.07 * (m.Efat / E_FAT);
    s.water += SR + Eres / LAMBDA - fl - metW;
    s.NaLoss += (SR / 1000) * c.NaSweat * (1 - 0.2 * a);
    s.NaIn += flNa;
    const Na = natremia(c, s);

    // --- VO₂ et fréquence cardiaque
    const choFrac = m.PmetA > 0 ? 1 - m.Efat / m.PmetA : 1;
    const VO2ss = (m.PmetA * 60) / ((19.6 + 1.5 * choFrac) * 1000);
    s.VO2 += (VO2ss - s.VO2) / 30;
    const HR = predictHR(c, s);

    // --- fatigue périphérique
    const loadI = m.PI / Math.max(1, c.CP1);
    s.PhiI = clamp(s.PhiI + (0.03 / 3600) * loadI * loadI * (1 - s.PhiI) - s.PhiI / (12 * 3600), 0, 0.95);
    const loadII = m.PII / Math.max(1, c.CP2 - c.CP1) + 3 * m.Pan / Math.max(1, c.Pmax - c.CP2) + 0.5 * (1 - sGl);
    s.PhiII = clamp(s.PhiII + (0.6 / 3600) * loadII * (1 - s.PhiII) - s.PhiII / 1200, 0, 0.95);

    // --- caféine (un compartiment)
    const absC = (3 / 3600) * s.cafGut;
    s.cafGut -= absC;
    s.cafC = Math.max(0, s.cafC + absC / (0.6 * c.mass) - (Math.LN2 / (c.cafHalf * 3600)) * s.cafC);

    // --- bilans
    const cho = m.choI + m.choII + glyAn;
    s.choTot += cho; s.fatTot += m.Efat / E_FAT; s.exoTot += exo;
    s.sweatTot += SR; s.drinkTot += fl; s.kJ += P / 1000;
    if (glu < s.minGlu) s.minGlu = glu;
    if (s.Tc > s.maxTc) s.maxTc = s.Tc;
    if (f.dehy > s.maxDehy) s.maxDehy = f.dehy;
    if (Na < s.minNa) s.minNa = Na;
    const o = s.o || (s.o = {});
    o.P = P; o.CP2e = f.CP2e; o.CP1e = f.CP1e; o.WpE = f.WpE; o.PmaxE = f.PmaxE; o.cpK = f.cpK; o.wK = f.wK; o.VA = f.VA;
    o.mT = f.mT; o.mHyd = f.mHyd; o.mAlt = f.mAlt; o.gly = f.gly; o.phi = f.phi; o.VA_T = f.VA_T; o.VA_glu = f.VA_glu; o.VA_other = f.VA_other;
    o.gI = clamp(s.GI / c.GIcap, 0, 1); o.gII = clamp(s.GII / c.GIIcap, 0, 1); o.gL = clamp(s.GL / c.GLcap, 0, 1);
    o.glu = s.Glu / (0.18 * c.Vd); o.Tc = s.Tc; o.Tsk = s.Tsk; o.dehy = s.water / (c.mass * 1000) * 100; o.Na = Na;
    o.HR = HR; o.VO2 = s.VO2; o.fat = m.fatG * 60; o.cho = cho * 3600; o.exo = exo * 3600; o.abs = abs * 3600;
    o.SR = SR * 3.6; o.mSpl = mSpl; o.GE = m.Pmet > 0 ? P / m.Pmet : 0; o.Pmet = m.Pmet; o.heat = m.heat;
    o.pI = m.PI; o.pIIa = m.PIIa; o.pIIx = m.PIIx; o.Pan = m.Pan; o.ph = 7.05 - 0.5 * (1 - sGl);
    o.PhiI = s.PhiI; o.PhiII = s.PhiII; o.caf = s.cafC; o.fluidStomach = s.fstom;
    o.sun = Sol; o.evap = Ev; o.conv = Conv; o.rad = Rad;

    s.t++;
    factors(c, s, env);   // facteurs de la seconde suivante (le simulateur les lit avant son pas)
    return o;
  }

  /* ---------- recalage par la fréquence cardiaque mesurée (filtre de Kalman étendu, section 13 du rapport) ---------- */

  /*
   * À la manière de Buller et al. (2013), qui estiment la température centrale à partir de la seule FC, l'écart entre la FC mesurée
   * (ceinture) et la FC prédite (predictHR) recale les états cachés. Le vecteur d'état du filtre est
   *   x = [ΔFC repos, ΔFC max (bpm), Q (W), Tc (°C), D (% du poids)]
   * - ΔFC repos et ΔFC max : biais des FC de la carte, souvent estimées (FC max de Tanaka : ± 10 bpm). Ils se recalent d'abord, avant
   *   que le noyau ne dépasse 37,5 °C (la FC n'y dépend pas de Tc), puis à chaque changement d'intensité (pentes 1 − r et r, r la
   *   réserve de VO₂) : un écart constant de FC est absorbé par eux et ne pousse pas la température ;
   * - Q : chaleur en plus dans le noyau que le modèle ne voit pas (soleil, bitume, vent plus faible, rendement plus bas), ajoutée au bilan
   *   thermique de chaque seconde. Un écart de FC qui grandit à puissance égale s'explique par elle : elle garde la correction de Tc,
   *   que la sueur et le débit sanguin cutané du modèle effaceraient sinon en quelques minutes ;
   * - Tc, D : les états du modèle eux-mêmes (s.Tc, s.water), propagés par step. La peau n'est pas recalée (la FC ne la voit pas) :
   *   elle suit le noyau en deux minutes environ.
   * Prédiction : le modèle propage les états ; la covariance P suit la jacobienne F du bilan thermique, calculée par différences
   * finies à chaque seconde (noyau, peau et sueur), la peau, plus rapide, étant ramenée à son état quasi stationnaire. Correction : une
   * mesure scalaire (la FC), gain K = P·Hᵀ / (H·P·Hᵀ + R). Les pentes de la dérive dans H sont adoucies au coude (sigmoïde de largeur
   * 0,1 °C pour Tc, 0,25 % pour D) pour que Tc reste observable juste sous 37,5 °C.
   * La FC réelle suit les changements d'intensité avec retard (30 à 60 s de plus que le VO₂) : pendant ces transitoires l'écart ne dit
   * rien des états cachés, et lu comme un biais il « comprimerait » la plage FC repos – FC max. La variance de mesure y est donc
   * augmentée du carré de l'écart entre la FC prédite et sa moyenne glissante sur 2 min (le retard attendu) : le filtre apprend
   * surtout des paliers.
   * ΦII n'est pas recalée : elle n'agit sur la FC qu'au travers du VO₂ (rendement des fibres II), faiblement sous CP1.
   */
  const KF = {
    sd0: [6, 10, 100, 0.2, 0.3],       // écarts types au départ : FC de repos et max estimées, chaleur (W), noyau (°C), eau (%)
    sdIn: [3, 4],                      // FC de repos et max saisies dans la carte athlète
    // bruit d'état (variance par seconde) : FC repos et max 1 bpm par heure ; chaleur 100 W en 10 min (soleil, ombre, vent) ;
    // noyau 0,05 °C par minute ; eau 0,15 % par heure (débit de sueur incertain)
    q: [1 / 3600, 1 / 3600, 10000 / 600, 0.0025 / 60, 0.0225 / 3600],
    // bpm² : bruit de mesure (5 bpm, capteur et erreur du modèle) × 25 s, la corrélation des écarts d'une seconde à l'autre
    // (cinétique de la FC, plus lente que celle du VO₂) : 25 mesures successives n'en valent qu'une indépendante
    R: 25 * 25,
    Rest: 4,                           // puissance estimée (sans capteur) : mesure 4 fois moins sûre
    lagTau: 120, Rlag: 100,            // transitoires : R + Rlag × (FC prédite − sa moyenne sur lagTau s)²
    lo: [-25, -40, -300, 35.5, -3], hi: [25, 40, 500, 42, 15],   // bornes des états recalés
  };
  const NX = 5;
  const KF_F = new Float64Array(NX * NX), KF_T = new Float64Array(NX * NX);

  /** Filtre au premier battement mesuré : biais nuls, covariance a priori (l'eau, incertaine depuis le départ, l'est d'autant plus). */
  function kfCreate(c, s) {
    const src = c.src || {};
    const sd = KF.sd0.slice();
    if (src.hrRest === 'saisie') sd[0] = KF.sdIn[0];
    if (src.hrMax === 'saisie') sd[1] = KF.sdIn[1];
    const P = new Float64Array(NX * NX);
    for (let i = 0; i < NX; i++) P[i * NX + i] = sd[i] * sd[i];
    P[4 * NX + 4] += KF.q[4] * s.t;
    return { x: [0, 0, 0], P, n: 0, t0: s.t, tObs: -1e9, hp: 0, res: 0, last: null };
  }

  /**
   * Prédiction de la covariance sur une seconde : P ← F·P·Fᵀ + Q. F : jacobienne du bilan thermique th du pas, par deux sondes
   * (Tc + ε, Tsk + ε) ; la peau, rapide, est ramenée à l'équilibre (δTsk = −(∂Ṫsk/∂Tc)/(∂Ṫsk/∂Tsk)·δTc) quand elle est stable.
   */
  function kfPredict(c, s, f, m, env, th) {
    const k = s.kf, P = k.P, F = KF_F, T = KF_T, eps = 0.02, Qx = k.x[2];
    const a = thermo(c, s, f, m, env, s.Tc + eps, s.Tsk, Qx, TH1), b = thermo(c, s, f, m, env, s.Tc, s.Tsk + eps, Qx, TH2);
    const SS = (b.dTsk - th.dTsk) / eps, r = SS < -1e-4 ? -((a.dTsk - th.dTsk) / eps) / SS : 0;
    const TT = (a.dTc - th.dTc) / eps + r * (b.dTc - th.dTc) / eps;
    const DT = ((a.SR - th.SR) / eps + r * (b.SR - th.SR) / eps) / (c.mass * 10);
    F.fill(0);
    for (let i = 0; i < NX; i++) F[i * NX + i] = 1;
    F[3 * NX + 2] = 1 / c.Ccore;                 // Tc ← Q
    F[3 * NX + 3] = 1 + Math.min(0, TT);         // Tc ← Tc : le noyau revient vers l'équilibre du modèle
    F[4 * NX + 3] = DT;                          // D ← Tc : sueur
    // T = F·P, puis P = T·Fᵀ + Q
    for (let i = 0; i < NX; i++) for (let j = 0; j < NX; j++) {
      let v = 0;
      for (let l = 0; l < NX; l++) v += F[i * NX + l] * P[l * NX + j];
      T[i * NX + j] = v;
    }
    for (let i = 0; i < NX; i++) for (let j = 0; j < NX; j++) {
      let v = 0;
      for (let l = 0; l < NX; l++) v += T[i * NX + l] * F[j * NX + l];
      P[i * NX + j] = v + (i === j ? KF.q[i] : 0);
    }
  }

  /**
   * Recale l'état s sur une fréquence cardiaque mesurée hr (bpm) à la fin de la seconde qui vient d'être calculée par step. Le filtre
   * naît à la première mesure (s.kf). opts : {estimated (la puissance de la seconde est estimée : mesure moins sûre)}. Renvoie
   * {y (écart mesurée − prédite, bpm), sd (écart type attendu), HR (FC prédite après correction)} ou null si la mesure est aberrante.
   */
  function observeHR(c, s, hr, opts) {
    hr = Number(hr);
    if (!(hr >= 30 && hr <= 240)) return null;
    const k = s.kf || (s.kf = kfCreate(c, s));
    const P = k.P;
    const fr = clamp((s.VO2 - c.VO2rest) / (c.VO2max - c.VO2rest), 0, 1);
    const dehy = s.water / (c.mass * 1000) * 100, ka = 1 - 0.3 * c.heatAcc;
    const H = [1 - fr, fr, 0, 8 * ka * sig((s.Tc - 37.5) / 0.1), 3 * ka * sig(dehy / 0.25)];
    const pred = predictHR(c, s, true), y = hr - pred;
    // FC prédite moyennée sur 2 min (repart de la prédiction après une coupure de la ceinture) : l'écart mesure le transitoire
    k.hp = s.t - k.tObs > 30 ? pred : k.hp + (pred - k.hp) / KF.lagTau;
    k.tObs = s.t;
    const lag = pred - k.hp;
    const R = KF.R * (opts && opts.estimated ? KF.Rest : 1) + KF.Rlag * lag * lag;
    const PH = new Array(NX);
    let S = R;
    for (let i = 0; i < NX; i++) {
      let v = 0;
      for (let j = 0; j < NX; j++) v += P[i * NX + j] * H[j];
      PH[i] = v; S += H[i] * v;
    }
    // correction des états : x ← x + K·y, K = P·Hᵀ / S
    const dx = PH.map((v) => (v / S) * y);
    for (let i = 0; i < 3; i++) k.x[i] = clamp(k.x[i] + dx[i], KF.lo[i], KF.hi[i]);
    const g = c.mass * 10;                     // g d'eau par % du poids
    s.Tc = clamp(s.Tc + dx[3], KF.lo[3], KF.hi[3]);
    s.water = clamp(s.water + dx[4] * g, KF.lo[4] * g, KF.hi[4] * g);
    // covariance : P ← P − K·(H·P) = P − PH·PHᵀ / S (symétrique)
    for (let i = 0; i < NX; i++) for (let j = 0; j < NX; j++) P[i * NX + j] -= PH[i] * PH[j] / S;
    k.n++; k.res += (y - k.res) / 60;
    // l'état a changé : facteurs de la seconde suivante et valeurs affichées
    factors(c, s, s.env);
    const HR = predictHR(c, s), o = s.o;
    if (o) {
      o.HR = HR; o.Tc = s.Tc; o.dehy = s.water / (c.mass * 1000) * 100; o.Na = natremia(c, s);
      if (o.Na < s.minNa) s.minNa = o.Na;
    }
    if (s.Tc > s.maxTc) s.maxTc = s.Tc;
    if (s.f.dehy > s.maxDehy) s.maxDehy = s.f.dehy;
    k.last = { y, sd: Math.sqrt(S), HR };
    return k.last;
  }

  /**
   * Ce que le recalage par la FC a appris (null tant qu'aucune FC n'a été mesurée) : n (secondes de mesure), FC de repos et maximale
   * recalées (bpm) et leurs biais, chaleur en plus Q (W), écart moyen de la dernière minute entre FC mesurée et prédite (bpm), écarts
   * types des biais, de Q, de Tc (°C) et de l'eau (% du poids).
   */
  function hrFit(c, s) {
    const k = s.kf;
    if (!k) return null;
    const sd = (i) => Math.sqrt(Math.max(0, k.P[i * NX + i]));
    return {
      n: k.n, dRest: k.x[0], dMax: k.x[1], HRrest: c.HRrest + k.x[0], HRmax: c.HRmax + k.x[1], Q: k.x[2],
      res: k.res, sdRest: sd(0), sdMax: sd(1), sdQ: sd(2), sdTc: sd(3), sdD: sd(4),
    };
  }

  /** Glycogène total (g) : fibres I + fibres II + foie. */
  const glycogen = (s) => s.GI + s.GII + s.GL;

  /**
   * Temps (s) avant la fringale à la puissance P si rien ne change : glycogène musculaire sous 10 % de la capacité, ou foie vide
   * (la glycémie ne tient plus). supply : glucides que l'intestin peut encore absorber (g/s). Infinity si rien ne s'épuise.
   */
  function timeToBonk(c, s, P, supply) {
    const f = s.f, m = metab(c, s, f, P, {});
    const stock = s.GI + s.GII - BONK_G * (c.GIcap + c.GIIcap);
    if (stock <= 0) return 0;
    const use = m.dGI + m.dGII + (P > f.CP2e ? (P - f.CP2e) / 1000 * 0.65 * 1.33 : 0);
    const t1 = use > 1e-7 ? stock / use : Infinity;
    const need = m.Rd + BRAIN - Math.max(0, supply || 0) - GNG;
    const t2 = need > 1e-7 ? max0(s.GL - 0.05 * c.GLcap) / need : Infinity;
    return Math.min(t1, t2);
  }

  /**
   * Ce qu'il faut afficher : dernières valeurs du pas (s.o) et alertes. gut : glucides en attente dans l'estomac et l'intestin (g),
   * sinon ceux de la digestion interne.
   */
  function status(c, s, gut) {
    const o = s.o || {};
    const f = s.f;
    const glu = s.Glu / (0.18 * c.Vd);
    const dehy = s.water / (c.mass * 1000) * 100;
    const gutG = Number.isFinite(gut) ? gut : s.stomach + s.gut;
    const musc = (s.GI + s.GII) / (c.GIcap + c.GIIcap);
    return {
      t: s.t, cpK: f.cpK, wK: f.wK, CP2e: f.CP2e, CP1e: f.CP1e, WpE: f.WpE, PmaxE: f.PmaxE, VA: f.VA,
      mT: f.mT, mHyd: f.mHyd, mAlt: f.mAlt, gly: f.gly, phi: f.phi, VA_T: f.VA_T, VA_glu: f.VA_glu, VA_other: f.VA_other,
      gI: clamp(s.GI / c.GIcap, 0, 1), gII: clamp(s.GII / c.GIIcap, 0, 1), gL: clamp(s.GL / c.GLcap, 0, 1), muscle: clamp(musc, 0, 1),
      GI: s.GI, GII: s.GII, GL: s.GL, energy: glycogen(s) / glycogenCap(c),
      glu, Tc: s.Tc, Tsk: s.Tsk, dehy, Na: o.Na || 140, HR: o.HR || c.HRrest, VO2: s.VO2,
      fat: o.fat || 0, cho: o.cho || 0, exo: o.exo || 0, SR: o.SR || 0, GE: o.GE || 0, ph: o.ph || 7.05, mSpl: s.mSpl,
      pI: o.pI || 0, pIIa: o.pIIa || 0, pIIx: o.pIIx || 0, PhiI: s.PhiI, PhiII: s.PhiII, caf: s.cafC, gut: gutG, fluidStomach: s.fstom,
      choTot: s.choTot, fatTot: s.fatTot, exoTot: s.exoTot, sweatL: s.sweatTot / 1000, drinkL: s.drinkTot / 1000, kJ: s.kJ,
      minGlu: s.minGlu < 99 ? s.minGlu : glu, maxTc: Math.max(s.maxTc, s.Tc), maxDehy: s.maxDehy, minNa: s.minNa < 999 ? s.minNa : 140,
      // alertes
      bonk: musc < BONK_G || glu < 3.0,
      hypo: glu < HYPO,
      hot: s.Tc >= 39.5,
      critical: s.Tc >= c.Tcrit - 0.3,
      dehydrated: dehy > 2,
      hypoNa: (o.Na || 140) < 135,
      gutFull: gutG > 60,
      hrFit: hrFit(c, s),                           // recalage par la FC mesurée (null sans ceinture)
    };
  }

  /* ---------- environnement ---------- */

  /**
   * Rayonnement solaire au sol (W/m²) : élévation du soleil (lat, lng en degrés, epoch UTC en s), ciel clair de Haurwitz (1945), puis
   * nébulosité estimée faute de mesure : pluie → ciel couvert, sinon ciel en partie nuageux.
   */
  function solar(lat, lng, epochSec, rain) {
    return solarClear(lat, lng, epochSec) * cloudK(rain);
  }
  const cloudK = (rain) => (rain >= 0.2 ? 0.25 : 0.75);
  const SUN_DEFAULT = 300;   // W/m² sans météo (heure inconnue) : un ciel voilé de journée

  /** Ciel clair (W/m²) à l'heure epochSec, au point (lat, lng). */
  function solarClear(lat, lng, epochSec) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(epochSec)) return 0;
    const rad = Math.PI / 180;
    const d = epochSec / 86400 + 2440587.5 - 2451545.0;            // jours depuis J2000
    const g = (357.529 + 0.98560028 * d) * rad;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const e = (23.439 - 0.00000036 * d) * rad;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
    const ha = (gmst * 15 + lng) * rad - ra;
    const sinEl = Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha);
    if (sinEl <= 0.01) return 0;
    return 1098 * sinEl * Math.exp(-0.057 / sinEl);
  }

  const sunCache = new WeakMap();   // parcours → ciel clair de la minute en cours (au départ du parcours)
  function sunOf(course, t) {
    const w = course && course.weather;
    if (!w || !Number.isFinite(w.start) || !course.lat) return null;
    const k = Math.floor(t / 60);
    let c = sunCache.get(course);
    if (!c) { c = { k: NaN, v: 0 }; sunCache.set(course, c); }
    if (c.k !== k) { c.k = k; c.v = solarClear(course.lat[0], course.lng[0], w.start + k * 60); }
    return c.v;
  }

  /**
   * Environnement d'un pas d'après les conditions du simulateur (sim.conditions) : température et humidité (météo, sinon la température
   * du parcours et 50 %), altitude du tracé, vent relatif (vitesse + vent de face, vent de côté), abri (shelter : part de la traînée
   * évitée, 0–1), soleil (élévation à l'heure de course avec la météo, sinon une valeur moyenne), distance restante. out est réutilisé.
   */
  function envOf(course, cond, st, shelter, out) {
    const e = out || {};
    const C = course, i = cond.i | 0;
    e.Ta = Number.isFinite(cond.T) ? cond.T : num(C.temperature, 20);
    e.RH = Number.isFinite(cond.rh) ? cond.rh : 50;
    e.h = C.ele ? 0.5 * (C.ele[i] + C.ele[Math.min(C.n, i + 1)]) : 0;
    const v = st.v > 0 ? st.v : 0, va = v + (cond.wh || 0), wc = cond.wc || 0;
    e.v = v;
    e.vAir = Math.sqrt(va * va + wc * wc);
    e.shelter = clamp(shelter || 0, 0, 1);
    e.remain = Math.max(0, C.length - st.s);
    const clear = sunOf(C, st.t);
    e.sun = clear === null ? SUN_DEFAULT : clear * cloudK(cond.rain || 0);
    return e;
  }

  /** Vitesse sur le plat (m/s) à la puissance P : P·η = (Crr·m·g + ½ρ·CdA·v²)·v (sans vent). */
  function flatSpeed(P, mass, cda, crr, rho, eta) {
    const m = mass > 0 ? mass : 80, k = 0.5 * (rho || 1.2) * (cda || 0.32), r = (crr || 0.004) * m * 9.81, Pw = Math.max(0, P) * (eta || 0.976);
    let v = 8;
    for (let i = 0; i < 30; i++) {
      const F = r * v + k * v * v * v - Pw, dF = r + 3 * k * v * v;
      v = Math.max(0.5, v - F / dF);
    }
    return v;
  }

  /* ---------- simulations pour la page Athlète ---------- */

  /**
   * Oxydation des substrats, recrutement et rendement d'un athlète frais (20 °C, à jeun d'effort) pour des puissances P (W) :
   * [{P, fat (g/h), cho (g/h), pI, pIIa, pIIx (W), GE, Pmet (W), HR (bpm, état stable)}].
   */
  function substrateCurve(c, powers) {
    const s = create(c);
    const f = factors(c, s, DEF_ENV);
    return powers.map((P) => {
      const m = metab(c, s, f, P, {});
      const VO2 = (m.PmetA * 60) / ((19.6 + 1.5 * (m.PmetA > 0 ? 1 - m.Efat / m.PmetA : 1)) * 1000);
      return {
        P, fat: m.fatG * 60, cho: (m.choI + m.choII) * 3600 + (m.Pan > 0 ? m.Pan / 0.25 / E_CHO * 3600 : 0),
        pI: m.PI, pIIa: m.PIIa, pIIx: m.PIIx, GE: m.Pmet > 0 ? P / m.Pmet : 0, Pmet: m.Pmet, VO2,
        HR: clamp(c.HRrest + (c.HRmax - c.HRrest) * (VO2 - c.VO2rest) / (c.VO2max - c.VO2rest), c.HRrest, c.HRmax),
      };
    });
  }

  /**
   * Sortie simulée seconde par seconde : opts {dur (s), P (W, ou fonction t → W), v (m/s, ou fonction t → m/s), env {Ta, RH, sun, h},
   * choGh (g/h de glucides), fluidMLh (mL/h), drinkNa (mmol/L), cafMg, cafAt (s), rec (s entre deux points enregistrés), state (opts de
   * create)}. Renvoie {series: {t, P, CP2e, CP1e, WpE, gI, gII, gL, glu, Tc, Tsk, dehy, HR, fat, cho, exo, Na, VA} (Float32Array),
   * last (status final), bonkT (s, première fringale, ou null)}.
   */
  function simulate(c, opts) {
    opts = opts || {};
    const dur = Math.max(60, Math.round(Number(opts.dur) || 3600));
    const rec = Math.max(1, Math.round(Number(opts.rec) || Math.ceil(dur / 1500)));
    const n = Math.floor(dur / rec) + 1;
    const keys = ['t', 'P', 'CP2e', 'CP1e', 'WpE', 'gI', 'gII', 'gL', 'glu', 'Tc', 'Tsk', 'dehy', 'HR', 'fat', 'cho', 'exo', 'Na', 'VA'];
    const S = {};
    for (const k of keys) S[k] = new Float32Array(n);
    const s = create(c, opts.state);
    const env = Object.assign({}, DEF_ENV, opts.env || {});
    const cho = (Number(opts.choGh) || 0) / 3600, fluid = (Number(opts.fluidMLh) || 0) / 3600;
    let bonkT = null, j = 0;
    const put = (o) => {
      if (j >= n) return;
      S.t[j] = s.t; S.P[j] = o ? o.P : 0; S.CP2e[j] = s.f.CP2e; S.CP1e[j] = s.f.CP1e; S.WpE[j] = s.f.WpE;
      S.gI[j] = s.GI / c.GIcap; S.gII[j] = s.GII / c.GIIcap; S.gL[j] = s.GL / c.GLcap; S.glu[j] = s.Glu / (0.18 * c.Vd);
      S.Tc[j] = s.Tc; S.Tsk[j] = s.Tsk; S.dehy[j] = s.water / (c.mass * 1000) * 100; S.HR[j] = o ? o.HR : c.HRrest;
      S.fat[j] = o ? o.fat : 0; S.cho[j] = o ? o.cho : 0; S.exo[j] = o ? o.exo : 0; S.Na[j] = o ? o.Na : 140; S.VA[j] = s.f.VA;
      j++;
    };
    put(null);
    for (let t = 0; t < dur; t++) {
      if (opts.cafMg > 0 && t === Math.round(Number(opts.cafAt) || 0)) caffeine(s, opts.cafMg);
      const P = typeof opts.P === 'function' ? opts.P(t, s) : Number(opts.P) || 0;
      env.v = typeof opts.v === 'function' ? opts.v(t, P) : num(Number(opts.v), env.v);
      env.vAir = env.v;
      env.remain = Infinity;
      const o = step(c, s, P, env, { cho, fluid, drinkNa: opts.drinkNa });
      if (bonkT === null && (s.GI + s.GII < BONK_G * (c.GIcap + c.GIIcap) || o.glu < 3.0)) bonkT = s.t;
      if (s.t % rec === 0) put(o);
    }
    for (const k of keys) S[k] = S[k].subarray(0, j);
    return { series: S, n: j, rec, last: status(c, s), bonkT, state: s };
  }

  PYR.metabo = {
    FIELDS, FIELD, GROUPS, BONK_G, HYPO, G_REF,
    fG, fGW, psat, fAlt, bassettAcc, bassettNon, townsendW, duBois, fatBell, recruit,
    defaults, vo2maxFromP5, card, scaleCard, glycogenCap, glycogen, create, factors, metab, step, drink, caffeine, timeToBonk, status,
    thermo, predictHR, observeHR, hrFit, KF,
    solar, solarClear, envOf, SUN_DEFAULT, flatSpeed, substrateCurve, simulate, DEF_ENV,
  };
})(globalThis.PYR = globalThis.PYR || {});
