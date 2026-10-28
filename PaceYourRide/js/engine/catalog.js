/* author : Hugo Joudrier-Faure */
/* PaceYourRide — catalogue du magasin : vélo (cadre, roues, pneus, transmission) et cycliste (casque,
 * lunettes, maillot ou combinaison, chaussettes, chaussures, épilation).
 * Chaque article se traduit en réglages du cycliste ou du vélo utilisés par la simulation :
 * masse, aérodynamisme (classes de physics.js), roulement, rendement de la transmission,
 * résistance aux crevaisons. Modèles génériques (pas de marques), prix indicatifs en euros.
 * Masses : « cadre » = vélo complet sans les roues ; roues sans pneus ; pneus à la paire. */
(function (PYR) {
  'use strict';

  /** Catégories, par page du magasin (vélo, cycliste). */
  const CATEGORIES = [
    { id: 'frame', page: 'bike', label: 'Cadre', hint: 'Masse du vélo (sans les roues) et aérodynamisme du cadre.' },
    { id: 'wheels', page: 'bike', label: 'Roues', hint: 'Profil des jantes (aérodynamisme), masse et inertie à relancer.' },
    { id: 'tires', page: 'bike', label: 'Pneus', hint: 'Résistance au roulement et risque de crevaison.' },
    { id: 'drivetrain', page: 'bike', label: 'Transmission', hint: 'Frottements de la chaîne : la part de ta puissance qui arrive à la roue.' },
    { id: 'helmet', page: 'rider', label: 'Casque', hint: 'Aérodynamisme de la tête.' },
    { id: 'glasses', page: 'rider', label: 'Lunettes', hint: 'Un petit détail autour du visage.' },
    { id: 'kit', page: 'rider', label: 'Maillot et cuissard', hint: 'Coupe de la tenue : plus elle colle, moins elle freine.' },
    { id: 'suit', page: 'rider', label: 'Combinaison', hint: 'Une seule pièce à la place du maillot et du cuissard.' },
    { id: 'socks', page: 'rider', label: 'Chaussettes', hint: 'Hautes et texturées, elles lissent l\'air sur le mollet.' },
    { id: 'shoes', page: 'rider', label: 'Chaussures', hint: 'Rigidité de la semelle (puissance transmise), masse, couvre-chaussures.' },
    { id: 'shave', page: 'rider', label: 'Épilation / rasage', hint: 'Des jambes lisses freinent moins (essais en soufflerie).' },
  ];

  const ITEMS = {
    frame: [
      { id: 'alu', name: 'Alu Sport', price: 900, mass: 8.4, bike: { frame: 'road' }, desc: 'Aluminium, polyvalent et solide.' },
      { id: 'endurance', name: 'Carbone Endurance', price: 2200, mass: 7.1, bike: { frame: 'road' }, desc: 'Confortable sur les longues sorties.' },
      { id: 'climber', name: 'Carbone Grimpeur', price: 4800, mass: 5.5, bike: { frame: 'climber' }, desc: 'Ultraléger, tubes fins : taillé pour les cols.' },
      { id: 'aero', name: 'Carbone Aéro', price: 5200, mass: 6.7, bike: { frame: 'aero' }, desc: 'Tubes profilés, câbles intégrés : rapide sur le plat.' },
      { id: 'tt', name: 'Contre-la-montre', price: 6500, mass: 7.6, bike: { frame: 'tt' }, desc: 'Le plus aérodynamique ; pense à la position CLM (onglet Équipement).' },
      { id: 'gravel', name: 'Gravel Alu', price: 1400, mass: 8.8, bike: { frame: 'gravel' }, desc: 'Pour les chemins et les pistes.' },
    ],
    wheels: [
      { id: 'box', name: 'Jante plate', price: 180, mass: 2.0, bike: { wheels: 'box' }, desc: 'Alu, profil ≈ 18 mm et 32 rayons : la roue classique.' },
      { id: 'alu', name: 'Alu 25 mm', price: 250, mass: 1.9, bike: { wheels: 'low' }, desc: 'Profil 20–30 mm : robustes, un peu lourdes.' },
      { id: 'climb', name: 'Carbone 30 mm', price: 1600, mass: 1.25, bike: { wheels: 'low' }, desc: 'Profil 20–30 mm, les plus légères : relances et montées.' },
      { id: 'c45', name: 'Carbone 45 mm', price: 1400, mass: 1.45, bike: { wheels: 'mid' }, desc: 'Profil 40–50 mm : le bon compromis légèreté / aérodynamisme.' },
      { id: 'c65', name: 'Carbone 60 mm', price: 1900, mass: 1.65, bike: { wheels: 'deep' }, desc: 'Profil 60 mm : rapides sur le plat.' },
      { id: 'c80', name: 'Carbone 80 mm', price: 2300, mass: 1.85, bike: { wheels: 'deep80' }, desc: 'Profil 80 mm : les plus rapides sur le plat, plus lourdes en montée.' },
      { id: 'disc', name: 'Lenticulaire + 80 mm', price: 3300, mass: 2.0, bike: { wheels: 'disc' }, desc: 'Roue arrière pleine : pour le contre-la-montre.' },
      { id: 'gravel', name: 'Gravel 25 mm', price: 650, mass: 1.75, bike: { wheels: 'spoked' }, desc: 'Jantes larges pour pneus de gravel.' },
    ],
    tires: [
      { id: 'training', name: 'Renforcé anti-crevaison', price: 60, mass: 0.9, bike: { tire: 'training' }, desc: 'Presque increvable, mais freine.' },
      { id: 'road', name: 'Route polyvalent', price: 80, mass: 0.56, bike: { tire: 'road' }, desc: 'Le pneu de tous les jours.' },
      { id: 'tubeless', name: 'Tubeless + préventif', price: 150, mass: 0.6, bike: { tire: 'tubeless' }, desc: 'Rapide, et le liquide colmate une partie des crevaisons.' },
      { id: 'race', name: 'Course latex', price: 160, mass: 0.46, bike: { tire: 'race' }, desc: 'Le plus rapide, mais fragile.' },
      { id: 'gravel', name: 'Gravel 40 mm', price: 120, mass: 0.9, bike: { tire: 'gravel' }, desc: 'Adhérence et confort hors du bitume.' },
    ],
    drivetrain: [
      { id: 'lube', name: 'Chaîne lubrifiée', price: 35, bike: { drivetrain: 'clean' }, desc: 'Huilée et propre : l\'entretien habituel.' },
      { id: 'wax', name: 'Chaîne cirée', price: 90, bike: { drivetrain: 'waxed' }, desc: 'Paraffine : moins de frottements, et elle reste propre.' },
    ],
    helmet: [
      { id: 'city', name: 'Urbain', price: 50, rider: { helmet: 'city' }, desc: 'Pratique, pas aérodynamique.' },
      { id: 'road', name: 'Route ventilé', price: 110, rider: { helmet: 'road' }, desc: 'Léger et bien aéré.' },
      { id: 'aero', name: 'Aéro route', price: 230, rider: { helmet: 'aero' }, desc: 'Coque lisse, gain sur le plat.' },
      { id: 'tt', name: 'Chrono', price: 380, rider: { helmet: 'tt' }, desc: 'Profil en goutte d\'eau et visière pour le contre-la-montre.' },
    ],
    glasses: [
      { id: 'none', name: 'Sans lunettes', price: 0, rider: { glasses: 'none' }, desc: 'Les yeux au vent.' },
      { id: 'sport', name: 'Lunettes de sport', price: 90, rider: { glasses: 'sport' }, desc: 'Verres enveloppants, branches sous les sangles.' },
      { id: 'shield', name: 'Écran panoramique', price: 180, rider: { glasses: 'shield' }, desc: 'Un grand écran qui prolonge le casque.' },
    ],
    kit: [
      { id: 'loose', name: 'Tenue ample', price: 60, rider: { clothing: 'loose' }, desc: 'T-shirt et short : confortable, flotte au vent.' },
      { id: 'fitted', name: 'Maillot et cuissard', price: 160, rider: { clothing: 'fitted' }, desc: 'La tenue classique, ajustée.' },
      { id: 'aero', name: 'Maillot aéro', price: 230, rider: { clothing: 'aero' }, desc: 'Tissu texturé, manches longues jusqu\'au coude, coupe près du corps.' },
    ],
    suit: [
      { id: 'road', name: 'Combinaison route', price: 320, rider: { clothing: 'skinsuit' }, desc: 'Une seule pièce, manches courtes : pour la course sur route.' },
      { id: 'tt', name: 'Combinaison chrono', price: 450, rider: { clothing: 'skinsuit_tt' }, desc: 'Manches longues et tissu texturé : la plus rapide.' },
    ],
    socks: [
      { id: 'short', name: 'Socquettes', price: 10, rider: { socks: 'short' }, desc: 'Juste au-dessus de la chaussure.' },
      { id: 'classic', name: 'Chaussettes mi-mollet', price: 15, rider: { socks: 'classic' }, desc: 'La hauteur habituelle.' },
      { id: 'aero', name: 'Chaussettes aéro', price: 35, rider: { socks: 'aero' }, desc: 'Hautes, à surface texturée.' },
    ],
    shoes: [
      { id: 'flat', name: 'Baskets', price: 60, bike: { shoes: 'flat' }, desc: 'Pédales plates : une partie de l\'effort se perd.' },
      { id: 'mtb', name: 'VTT / gravel', price: 130, bike: { shoes: 'mtb' }, desc: 'Semelle souple, on peut marcher.' },
      { id: 'road', name: 'Route', price: 160, bike: { shoes: 'road' }, desc: 'Semelle rigide et cales.' },
      { id: 'carbon', name: 'Route carbone', price: 360, bike: { shoes: 'carbon' }, desc: 'Plus légères et plus rigides.' },
      { id: 'aero', name: 'Carbone + couvre-chaussures', price: 430, bike: { shoes: 'aero' }, desc: 'Le petit gain aéro des rouleurs.' },
    ],
    shave: [
      { id: 'none', name: 'Au naturel', price: 0, rider: { shave: 'none' }, desc: 'Poils compris.' },
      { id: 'legs', name: 'Jambes rasées', price: 5, rider: { shave: 'legs' }, desc: 'Un rasoir et dix minutes.' },
      { id: 'full', name: 'Jambes et bras épilés', price: 60, rider: { shave: 'full' }, desc: 'Plus long à repousser. Sous des manches longues, les bras ne comptent plus.' },
    ],
  };

  /** Équipement « d'entrée de gamme », référence des comparaisons. */
  const BASE = {
    frame: 'alu', wheels: 'alu', tires: 'road', drivetrain: 'lube',
    helmet: 'road', glasses: 'sport', kit: 'fitted', socks: 'classic', shoes: 'road', shave: 'none',
  };
  const DEFAULT_TIRES_MASS = 0.56;

  function get(cat, id) { return (ITEMS[cat] || []).find((x) => x.id === id) || null; }

  /**
   * Réglages à appliquer quand on choisit l'article `id` de la catégorie `cat`, à partir de l'état
   * actuel (rider, bike) et de la sélection du magasin (pour la masse des pneus déjà montés).
   * Renvoie {rider: {...}, bike: {...}} (seulement les champs modifiés).
   */
  function patchFor(cat, id, rider, bike, sel) {
    const it = get(cat, id);
    if (!it) throw new Error('Article inconnu');
    const out = { rider: Object.assign({}, it.rider), bike: Object.assign({}, it.bike) };
    const weight = Number(bike.weight) > 0 ? Number(bike.weight) : 8.5;
    const wheelMass = Number(bike.wheelMass) > 0 ? Number(bike.wheelMass) : 2.2;
    const tiresNow = sel && sel.tires && get('tires', sel.tires) ? get('tires', sel.tires).mass : DEFAULT_TIRES_MASS;
    const round = (x, d) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d);
    if (cat === 'frame') {
      out.bike.weight = round(it.mass + wheelMass, 2);
    } else if (cat === 'wheels') {
      const wm = it.mass + tiresNow;
      out.bike.wheelMass = round(wm, 2);
      out.bike.weight = round(weight - wheelMass + wm, 2);
    } else if (cat === 'tires') {
      out.bike.wheelMass = round(wheelMass - tiresNow + it.mass, 2);
      out.bike.weight = round(weight - tiresNow + it.mass, 2);
    }
    return out;
  }

  /** L'article choisi est-il toujours celui qui est monté ? (les réglages ont pu être modifiés ailleurs) */
  function isMounted(cat, id, rider, bike) {
    const it = get(cat, id);
    if (!it) return false;
    for (const [k, v] of Object.entries(it.rider || {})) if (rider[k] !== v) return false;
    for (const [k, v] of Object.entries(it.bike || {})) if (bike[k] !== v) return false;
    return true;
  }

  /** Équipement complet → réglages (pour les comparaisons). sel : article par catégorie (BASE par défaut). */
  function fullSetup(sel, rider, bike) {
    const s = Object.assign({}, BASE, sel);
    const r = Object.assign({}, rider), b = Object.assign({}, bike);
    for (const c of CATEGORIES) {
      const it = get(c.id, s[c.id]);
      if (it) { Object.assign(r, it.rider); Object.assign(b, it.bike); }
    }
    const f = get('frame', s.frame) || get('frame', BASE.frame);
    const w = get('wheels', s.wheels) || get('wheels', BASE.wheels);
    const t = get('tires', s.tires) || get('tires', BASE.tires);
    b.weight = f.mass + w.mass + t.mass;
    b.wheelMass = w.mass + t.mass;
    return { rider: r, bike: b };
  }

  /** Réglages touchés par un article (« rider.clothing », « bike.wheels »…). */
  function fields(cat) {
    const out = new Set();
    for (const it of ITEMS[cat] || []) {
      for (const k of Object.keys(it.rider || {})) out.add('rider.' + k);
      for (const k of Object.keys(it.bike || {})) out.add('bike.' + k);
    }
    return out;
  }

  /** Deux catégories qui se disputent le même réglage (maillot et combinaison). */
  function rivals(a, b) {
    if (a === b) return false;
    const fb = fields(b);
    for (const f of fields(a)) if (fb.has(f)) return true;
    return false;
  }

  PYR.catalog = { CATEGORIES, ITEMS, BASE, get, patchFor, isMounted, fullSetup, rivals };
})(globalThis.PYR = globalThis.PYR || {});
