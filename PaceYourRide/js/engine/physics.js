/* author : Hugo Joudrier-Faure */
/* PaceYourRide — modèle mécanique cycliste + vélo :
 * masse, aérodynamisme (CdA), roulement (Crr), transmission (rendement), densité de l'air. */
(function (PYR) {
  'use strict';

  const G = 9.80665;

  /** Positions : facteur appliqué à la surface frontale de référence (Bassett et al.). */
  const POSITIONS = [
    { id: 'upright', label: 'Position droite (VTT / ville)', factor: 1.35 },
    { id: 'tops', label: 'Buste relevé, mains en haut du cintre', factor: 1.25 },
    { id: 'hoods', label: 'Mains sur les cocottes, bras tendus', factor: 1.08 },
    { id: 'hoods_bent', label: 'Mains sur les cocottes, bras fléchis', factor: 0.98 },
    { id: 'drops', label: 'Mains en bas du cintre (drops)', factor: 0.92 },
    { id: 'forearms', label: 'Avant-bras à plat sur le cintre', factor: 0.85 },
    { id: 'tt', label: 'Prolongateurs (position contre-la-montre)', factor: 0.74 },
    { id: 'tt_pro', label: 'CLM optimisée (soufflerie)', factor: 0.66 },
  ];

  const HELMETS = [
    { id: 'road', label: 'Casque route standard', dcda: 0 },
    { id: 'city', label: 'Casque urbain', dcda: 0.008 },
    { id: 'aero', label: 'Casque aéro route', dcda: -0.006 },
    { id: 'tt', label: 'Casque contre-la-montre', dcda: -0.012 },
  ];

  const CLOTHING = [
    { id: 'loose', label: 'Ample (loisir, coupe-vent)', dcda: 0.02 },
    { id: 'fitted', label: 'Ajustée (maillot + cuissard)', dcda: 0 },
    { id: 'aero', label: 'Maillot aéro', dcda: -0.006 },
    { id: 'skinsuit', label: 'Combinaison (skinsuit)', dcda: -0.012 },
    { id: 'skinsuit_tt', label: 'Combinaison chrono (manches longues)', dcda: -0.016 },
  ];

  /** Lunettes : un visage nu accroche un peu plus l'air ; un écran panoramique prolonge le casque. */
  const GLASSES = [
    { id: 'none', label: 'Sans lunettes', dcda: 0.001 },
    { id: 'sport', label: 'Lunettes de sport', dcda: 0 },
    { id: 'shield', label: 'Écran panoramique', dcda: -0.002 },
  ];

  /** Chaussettes : les hautes à surface texturée retardent le décollement de l'air sur le mollet. */
  const SOCKS = [
    { id: 'short', label: 'Socquettes', dcda: 0.001 },
    { id: 'classic', label: 'Chaussettes mi-mollet', dcda: 0 },
    { id: 'aero', label: 'Chaussettes aéro (hautes, texturées)', dcda: -0.003 },
  ];

  /** Pilosité (essais en soufflerie) : les bras ne comptent pas sous des manches longues. */
  const SHAVE = [
    { id: 'none', label: 'Jambes et bras au naturel', dcda: 0 },
    { id: 'legs', label: 'Jambes rasées', dcda: -0.008 },
    { id: 'full', label: 'Jambes et bras épilés', dcda: -0.010 },
  ];

  const FRAMES = [
    { id: 'road', label: 'Route classique', dcda: 0 },
    { id: 'climber', label: 'Route grimpeur (tubes fins)', dcda: 0.002 },
    { id: 'aero', label: 'Route aéro', dcda: -0.010 },
    { id: 'tt', label: 'Contre-la-montre / triathlon', dcda: -0.015 },
    { id: 'gravel', label: 'Gravel', dcda: 0.008 },
    { id: 'mtb', label: 'VTT', dcda: 0.025 },
    { id: 'city', label: 'Ville / randonnée (porte-bagages…)', dcda: 0.035 },
  ];

  const WHEELS = [
    { id: 'box', label: 'Jante plate (≈ 18 mm, 32 rayons)', dcda: 0.003 },
    { id: 'low', label: 'Profil bas (20–30 mm)', dcda: 0 },
    { id: 'mid', label: 'Mi-hautes (40–50 mm)', dcda: -0.006 },
    { id: 'deep', label: 'Hautes (60–80 mm)', dcda: -0.010 },
    { id: 'disc', label: 'Lenticulaire AR + haute AV', dcda: -0.016 },
    { id: 'spoked', label: 'Rayons VTT / gravel', dcda: 0.004 },
  ];

  /**
   * Pneus : coefficient de roulement sur asphalte standard, risque relatif de crevaison
   * et liquide préventif (qui colmate une partie des perforations).
   */
  const TIRES = [
    { id: 'race', label: 'Course haut de gamme (latex)', crr: 0.0030, puncture: 1.6, sealant: false },
    { id: 'tubeless', label: 'Tubeless route + liquide préventif', crr: 0.0032, puncture: 0.9, sealant: true },
    { id: 'road', label: 'Route standard', crr: 0.0038, puncture: 1, sealant: false },
    { id: 'training', label: 'Entraînement / renforcé anti-crevaison', crr: 0.0048, puncture: 0.35, sealant: false },
    { id: 'gravel', label: 'Gravel (35–45 mm)', crr: 0.0055, puncture: 0.6, sealant: true },
    { id: 'mtb', label: 'VTT', crr: 0.0080, puncture: 0.5, sealant: true },
    { id: 'custom', label: 'Personnalisé', crr: null, puncture: 1, sealant: false },
  ];

  /** Chaussures : part de la puissance transmise (rigidité de la semelle), masse, aérodynamisme. */
  const SHOES = [
    { id: 'flat', label: 'Baskets et pédales plates', k: 0.97, mass: 0.45, dcda: 0 },
    { id: 'mtb', label: 'Chaussures VTT / gravel', k: 0.99, mass: 0.15, dcda: 0 },
    { id: 'road', label: 'Chaussures route', k: 1, mass: 0, dcda: 0 },
    { id: 'carbon', label: 'Route, semelle carbone', k: 1.005, mass: -0.15, dcda: 0 },
    { id: 'aero', label: 'Route carbone + couvre-chaussures aéro', k: 1.005, mass: -0.1, dcda: -0.004 },
  ];

  /** Rendement de la transmission (pertes chaîne / dérailleurs). */
  const DRIVETRAINS = [
    { id: 'waxed', label: 'Chaîne cirée, propre', eff: 0.985 },
    { id: 'clean', label: 'Chaîne lubrifiée, propre', eff: 0.975 },
    { id: 'average', label: 'Chaîne moyennement entretenue', eff: 0.965 },
    { id: 'dirty', label: 'Chaîne sale / usée', eff: 0.950 },
    { id: 'hub', label: 'Moyeu à vitesses intégrées', eff: 0.930 },
    { id: 'custom', label: 'Personnalisé', eff: null },
  ];

  /**
   * Revêtements : multiplicateur du Crr des pneus (friction de la route),
   * et risques relatifs de chute (crash) et de crevaison (punct) pour les incidents de course ;
   * w : largeur praticable typique (m) pour le peloton du mode jeu, null = largeur par défaut du parcours (route standard).
   */
  const SURFACES = [
    { id: 'smooth', label: 'Enrobé neuf, très lisse', f: 0.85, crash: 1, punct: 0.8, w: null },
    { id: 'asphalt', label: 'Asphalte standard', f: 1.0, crash: 1, punct: 1, w: null },
    { id: 'rough', label: 'Asphalte granuleux / dégradé', f: 1.35, crash: 1.2, punct: 1.5, w: 4.5 },
    { id: 'cobbles', label: 'Pavés réguliers', f: 2.2, crash: 2.5, punct: 3, w: 4 },
    { id: 'cobbles_hard', label: 'Pavés difficiles (type Roubaix)', f: 3.5, crash: 3.5, punct: 4, w: 3 },
    { id: 'gravel_hard', label: 'Gravier compact / piste', f: 2.0, crash: 2, punct: 3, w: 3.5 },
    { id: 'gravel_loose', label: 'Gravier meuble', f: 3.5, crash: 3, punct: 4, w: 3 },
    { id: 'dirt', label: 'Terre / chemin', f: 3.0, crash: 2, punct: 2.5, w: 2.5 },
    { id: 'wet', label: 'Route mouillée', f: 1.15, crash: 3, punct: 1.3, w: null },
    { id: 'grass', label: 'Herbe / sable', f: 6.0, crash: 2, punct: 1.5, w: 2 },
    { id: 'custom', label: 'Personnalisé', f: null, crash: 1.5, punct: 1.5, w: null },
  ];
  const ROAD_W = 6;                        // m : largeur par défaut d'une route (hors portions)
  const ROAD_W_MIN = 1.5, ROAD_W_MAX = 20; // m : bornes de la largeur saisie

  const byId = (list, id, fallbackIdx = 0) => list.find((x) => x.id === id) || list[fallbackIdx];

  /** Surface frontale de référence cycliste + vélo (m²), Bassett et al. 1999 (H en m, M en kg). */
  function frontalRef(heightCm, weightKg) {
    const h = (Number(heightCm) || 178) / 100;
    const m = Number(weightKg) || 72;
    return 0.0293 * Math.pow(h, 0.725) * Math.pow(m, 0.425) + 0.0604;
  }

  /** Densité de l'air (kg/m³) à l'altitude donnée (atmosphère standard) et à la température donnée. */
  function airDensity(altM, tempC) {
    const p = 101325 * Math.pow(Math.max(0.2, 1 - 2.25577e-5 * altM), 5.25588);
    return p / (287.05 * (tempC + 273.15));
  }

  /**
   * Densité de l'air humide (kg/m³) : pression mesurée au niveau de la mer (hPa) ramenée à l'altitude
   * (même profil que l'atmosphère standard), température tempC, humidité relative rh (%).
   * L'eau (vapeur) est plus légère que l'air sec : un air humide et chaud freine un peu moins.
   */
  function airDensityHumid(altM, tempC, rh, pMslHpa) {
    const p = (Number.isFinite(pMslHpa) ? pMslHpa : 1013.25) * 100 * Math.pow(Math.max(0.2, 1 - 2.25577e-5 * altM), 5.25588);
    const K = tempC + 273.15;
    const es = 610.78 * Math.exp((17.27 * tempC) / (tempC + 237.3)); // pression de vapeur saturante (Pa)
    const pv = Math.min(p, Math.max(0, Math.min(100, Number.isFinite(rh) ? rh : 0)) / 100 * es);
    return (p - pv) / (287.05 * K) + pv / (461.495 * K);
  }

  function surfaceFactor(portion) {
    const s = byId(SURFACES, portion.surface, 1);
    if (s.f === null) return Math.max(0.3, Number(portion.factor) || 1);
    return s.f;
  }

  /** Risques relatifs de chute et de crevaison d'une portion de revêtement. */
  function surfaceRisk(portion) {
    const s = byId(SURFACES, portion.surface, 1);
    return { crash: s.crash, punct: s.punct };
  }

  /** Largeur par défaut du parcours (m) : celle saisie (env.roadWidth), sinon ROAD_W. */
  function roadWidth(v) {
    const n = Number(v);
    return n > 0 ? Math.min(ROAD_W_MAX, Math.max(ROAD_W_MIN, n)) : ROAD_W;
  }

  /** Largeur praticable d'une portion de revêtement (m) : celle saisie sur la portion, sinon celle du revêtement, sinon dflt. */
  function surfaceWidth(portion, dflt) {
    const n = Number(portion && portion.width);
    if (n > 0) return Math.min(ROAD_W_MAX, Math.max(ROAD_W_MIN, n));
    const s = byId(SURFACES, portion && portion.surface, 1);
    return s.w > 0 ? s.w : roadWidth(dflt);
  }

  /**
   * Paramètres mécaniques effectifs.
   * rider : {weight, height, position, helmet, clothing, glasses, socks, shave}
   * bike  : {weight, load, frame, wheels, cdaAdjust, cdaOverride, tire, crrCustom, drivetrain, effCustom, wheelMass, spinMaxKmh}
   */
  function buildSetup(rider, bike) {
    const mRider = Number(rider.weight) > 0 ? Number(rider.weight) : 72;
    const mBike = (Number(bike.weight) > 0 ? Number(bike.weight) : 8.5) + (Number(bike.load) > 0 ? Number(bike.load) : 0);
    const mass = mRider + mBike;
    const wheelMass = Number(bike.wheelMass) > 0 ? Number(bike.wheelMass) : 2.2;
    const massEff = mass + 0.8 * wheelMass; // inertie de rotation des roues

    const aRef = frontalRef(rider.height, mRider);
    const pos = byId(POSITIONS, rider.position, 3);
    const helmet = byId(HELMETS, rider.helmet);
    const clothing = byId(CLOTHING, rider.clothing, 1);
    const frame = byId(FRAMES, bike.frame);
    const wheels = byId(WHEELS, bike.wheels);
    const shoes = byId(SHOES, bike.shoes, 2);
    const glasses = byId(GLASSES, rider.glasses, 1);
    const socks = byId(SOCKS, rider.socks, 1);
    const shave = byId(SHAVE, rider.shave);
    // bras couverts par des manches longues : seules les jambes rasées comptent
    const shaveDcda = clothing.id === 'skinsuit_tt' && shave.id === 'full' ? byId(SHAVE, 'legs').dcda : shave.dcda;
    const parts = [
      { label: `Cycliste — ${pos.label.toLowerCase()}`, v: aRef * pos.factor },
      { label: helmet.label, v: helmet.dcda },
      { label: `Tenue ${clothing.label.toLowerCase()}`, v: clothing.dcda },
      { label: `Cadre ${frame.label.toLowerCase()}`, v: frame.dcda },
      { label: `Roues ${wheels.label.toLowerCase()}`, v: wheels.dcda },
    ];
    if (glasses.dcda) parts.push({ label: glasses.label, v: glasses.dcda });
    if (socks.dcda) parts.push({ label: socks.label, v: socks.dcda });
    if (shaveDcda) parts.push({ label: shave.label, v: shaveDcda });
    if (shoes.dcda) parts.push({ label: shoes.label, v: shoes.dcda });
    if (Number(bike.cdaAdjust)) parts.push({ label: 'Ajustement manuel', v: Number(bike.cdaAdjust) });
    const cdaEstimated = Math.max(0.12, parts.reduce((s, p) => s + p.v, 0));
    const cdaOverride = Number(bike.cdaOverride) > 0 ? Number(bike.cdaOverride) : 0;
    const cda = cdaOverride || cdaEstimated;

    const tire = byId(TIRES, bike.tire, 2);
    const crr = tire.crr !== null ? tire.crr : Math.max(0.001, Number(bike.crrCustom) || 0.004);
    const dt = byId(DRIVETRAINS, bike.drivetrain, 1);
    const etaChain = dt.eff !== null ? dt.eff : Math.min(1, Math.max(0.8, (Number(bike.effCustom) || 97) / 100));
    const eta = Math.min(0.995, etaChain * shoes.k);

    return {
      mRider, mBike, mass: mass + shoes.mass, massEff: massEff + shoes.mass, wheelMass,
      aRef, cda, cdaEstimated, cdaOverride, cdaParts: parts,
      crr, eta, puncture: tire.puncture, sealant: !!tire.sealant,
      fMax: Math.max(200, 0.45 * mRider * G), // force max à la roue au démarrage (couple limité)
      vSpin: (Number(bike.spinMaxKmh) > 0 ? Number(bike.spinMaxKmh) : 65) / 3.6,
    };
  }

  /** Puissance nécessaire (W, aux pédales) pour tenir la vitesse v en régime établi. */
  function steadyPower(setup, v, grade, crrFactor, rho, windHead, windCross) {
    const th = Math.atan(grade);
    const va = v + (windHead || 0);
    const vapp = Math.sqrt(va * va + (windCross || 0) ** 2);
    const F = setup.mass * G * (Math.sin(th) + setup.crr * (crrFactor || 1) * Math.cos(th)) + 0.5 * rho * setup.cda * vapp * va;
    return (F * v) / setup.eta;
  }

  /** Vitesse d'équilibre (m/s) pour une puissance donnée (résolution par dichotomie). */
  function steadySpeed(setup, P, grade, crrFactor, rho, windHead, windCross) {
    let lo = 0, hi = 40;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (steadyPower(setup, mid, grade, crrFactor, rho, windHead, windCross) > P) hi = mid; else lo = mid;
    }
    return 0.5 * (lo + hi);
  }

  PYR.physics = {
    G, POSITIONS, HELMETS, CLOTHING, GLASSES, SOCKS, SHAVE, FRAMES, WHEELS, TIRES, SHOES, DRIVETRAINS, SURFACES, ROAD_W, ROAD_W_MIN, ROAD_W_MAX,
    byId, frontalRef, airDensity, airDensityHumid, surfaceFactor, surfaceRisk, roadWidth, surfaceWidth, buildSetup, steadyPower, steadySpeed,
  };
})(globalThis.PYR = globalThis.PYR || {});
