/* author : Hugo Joudrier-Faure */
/* PaceYourRide — écran de course (page de jeu). Le mode jeu a deux pages : les réglages de la partie, puis, dès « Démarrer » (décompte
 * compris) et jusqu'à « Quitter », la page de jeu. Sur téléphone (portrait et paysage), elle passe en plein écran : carte en fond, HUD,
 * boutons carrés, réserves et barre de puissance par zones, comme dans la démo. Sur grand écran, la même interface occupe toute la
 * colonne de la carte, avec en plus le profil d'élévation en dessous et le panneau de droite (classements en temps réel, commandes).
 * Ce module ne fait que présenter : la logique reste dans tab-game.js (T.setCmd, T.setTactic, T.togglePause…), qui lui
 * envoie un instantané du HUD (T.snapshot()). Les ids de tab-game.js (#hud-*, #g-*, #game-chart, #game-classif…) restent
 * dans la page : les widgets lourds (profil, classement, puces, ravitaillement) sont déplacés ici le temps de la course,
 * puis remis à leur place. */
(function (PYR) {
  'use strict';

  /** Même découpage que la mise en page mobile de style.css : portrait, ou téléphone en paysage. */
  const PHONE = '(max-width: 900px), (max-width: 950px) and (max-height: 520px) and (orientation: landscape)';
  const STEP = 5;                                        // téléphone : W par appui sur − / + et pas de la barre
  const STEP_WIDE = 1;                                   // grand écran : précis au watt près
  const HOLD_FIRST = 400, HOLD_EVERY = 90, HOLD_FAST = 1300; // appui long : délai, cadence, puis pas de 25 W
  // durées tenables du dégradé de la barre, de la plus longue à la plus courte : rgb de la couleur atteinte à la puissance tenable pendant tau
  const HEAT = [
    { tau: 3600, rgb: '250, 204, 21', a: 0, label: '1 h' },       // repère de départ (rien n'est tracé)
    { tau: 1200, rgb: '234, 179, 8', a: 0.70, label: '20 min', band: false },  // jaune : repère seulement
    { tau: 300, rgb: '249, 115, 22', a: 0.78, label: '5 min', band: false },   // orange : repère seulement
    { tau: 60, rgb: '220, 38, 38', a: 0.84, label: '1 min' },                  // rouge : bande de 1 min à 15 s
    { tau: 15, rgb: '147, 51, 234', a: 0.85, label: '15 s' },                  // violet : bande de 15 s à la limite d'une seconde
  ];
  const DRAG_PX = 6;                                     // en deçà, un glisser compte comme un simple toucher

  const U = PYR.util, D = PYR.dom, store = PYR.store, PB = PYR.powerBar, Tac = PYR.tactics, Fu = PYR.fuel;
  const { h, $ } = D;

  const M = {};
  const E = {};              // éléments construits par build()
  const SPIN_W = 16;         // px : largeur des petites flèches du champ « Durée » (fixée en CSS) ; le texte du champ s'arrête avant
  const PULL_INF = 305;     // valeur du champ « Durée d'un relais » qui s'affiche « ∞ » (sans limite de durée) : juste au-delà de 300 s
  const parked = [];         // widgets déplacés : [{ el, ph }] (ph : repère laissé à leur place d'origine)
  let TG = null, G = null;   // PYR.tabGame et son état
  let mq = null;
  let mode = null;           // écran de course affiché : null, 'phone' (plein écran) ou 'wide' (grand écran, page conservée)
  let inRace = false;        // téléphone : une course est en cours (ou vient de se terminer), on veut le plein écran
  let sheetTab = null;       // feuille ouverte (téléphone seulement) : null, 'prof' ou 'rank'
  let detail = false;        // réserves : valeurs plutôt que pourcentages
  let edges = null, edgesKey = '';
  let ro = null;
  let popKey = null;         // détail ouvert au-dessus des réserves : null, 'tte' (limites de la durée tenable), 'ppr' (courbe de puissance record) ou 'gut' (digestion)

  /* ---------- construction ---------- */
  const icon = (cls, ...kids) => D.svg('svg', { viewBox: '0 0 18 18', 'aria-hidden': 'true', class: 'rm-ic ' + cls }, ...kids);
  const icPause = () => icon('ic-pause', D.svg('rect', { x: 3, y: 2, width: 4, height: 14, rx: 1 }), D.svg('rect', { x: 11, y: 2, width: 4, height: 14, rx: 1 }));
  const icPlay = () => { const s = icon('ic-play', D.svg('path', { d: 'M4 2l11 7-11 7z' })); s.setAttribute('hidden', ''); return s; };
  const icCurve = () => icon('ic-line', D.svg('path', { d: 'M2 3 C 4 11, 8 14, 16 15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }), D.svg('path', { d: 'M2 15 H16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1', opacity: '0.5' }));
  const icLayers = () => icon('ic-line', D.svg('path', { d: 'M9 2 L16.5 6.2 L9 10.4 L1.5 6.2 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }), D.svg('path', { d: 'M1.8 9.6 L9 13.6 L16.2 9.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }), D.svg('path', { d: 'M1.8 12.8 L9 16.8 L16.2 12.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: '0.55' }));
  const icStopwatch = () => icon('ic-line',
    D.svg('circle', { cx: 9, cy: 10.4, r: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }),
    D.svg('path', { d: 'M7 1.8 H11 M9 1.8 V4.4 M9 10.4 L11.4 8 M13.8 4.2 L15 3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
  const icStats = () => icon('ic-line', D.svg('path', { d: 'M3 15 V9 M9 15 V3 M15 15 V7', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round' }));
  const icProfile = () => icon('ic-line', D.svg('path', { d: 'M1 15 L6 6 L9.5 11 L12 8 L17 15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  // loupe sur trois points côte à côte : le zoom peloton
  const icZoom = () => icon('ic-line',
    D.svg('circle', { cx: 7.5, cy: 7.5, r: 5.6, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }),
    D.svg('path', { d: 'M11.6 11.6 L16.4 16.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }),
    D.svg('circle', { cx: 5.2, cy: 8.6, r: 1.1 }), D.svg('circle', { cx: 7.5, cy: 6.2, r: 1.1 }), D.svg('circle', { cx: 9.8, cy: 8.6, r: 1.1 }));

  // téléphone penché : l'appareil (qui tourne avec l'inclinaison mesurée) entre deux flèches, une par rang à gauche et à droite
  const icTilt = () => icon('ic-line',
    D.svg('path', { d: 'M1.6 9 L4.2 6.6 M1.6 9 L4.2 11.4 M16.4 9 L13.8 6.6 M16.4 9 L13.8 11.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    D.svg('g', { class: 'rm-tiltphone' }, D.svg('rect', { x: 6.4, y: 2.6, width: 5.2, height: 12.8, rx: 1.2, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }), D.svg('path', { d: 'M8.4 13.2 H9.6', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' })));

  // boussole : l'aiguille (rouge au nord) tourne avec la carte et montre où est le nord (--north posée par map.js)
  const icCompass = () => icon('ic-line',
    D.svg('circle', { cx: 9, cy: 9, r: 7.6, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }),
    D.svg('g', { class: 'rm-needle' }, D.svg('path', { d: 'M9 2.6 L11.4 9 L6.6 9 Z', fill: '#d03b3b' }), D.svg('path', { d: 'M9 15.4 L11.4 9 L6.6 9 Z', fill: 'currentColor', opacity: '0.55' })));

  const pauseButton = (cls) => h('button', { class: cls + ' rm-pbtn', type: 'button', 'aria-label': 'Mettre en pause', onclick: togglePlay }, icPause(), icPlay());

  /** Lignes des statistiques du modèle physiologique (affichées seulement quand il est joué). */
  const PHYS_STATS = ['pc', 'gy', 'gl', 'tc', 'hr', 'ox', 'sw'];

  /** Une réserve : libellé, piste (avec, pour le glycogène, la part du foie et la part hachurée des glucides en cours d'absorption) et valeur. */
  function reserveRow(label, withGut) {
    const fill = h('div', { class: 'rm-fill' }), val = h('span', { class: 'rm-val' });
    const liver = withGut ? h('div', { class: 'rm-fill rm-liver' }) : null;
    const gut = withGut ? h('div', { class: 'rm-gut' }) : null, stomach = withGut ? h('div', { class: 'rm-gut stomach' }) : null;
    const el = h('div', { class: 'rm-row' }, h('span', { class: 'rm-lab' }, label), h('div', { class: 'rm-track' + (withGut ? ' stacked' : '') }, fill, liver, gut, stomach), val);
    return { el, fill, val, gut, stomach, liver };
  }

  function build() {
    const mapWrap = $('.map-wrap');

    // HUD : vitesse, puissance, pente
    const item = (id, unit, cls) => { const v = h('strong', { class: 'rm-hv' }, '0'), u = h('span', { class: 'rm-hu' }, unit); E[id] = v; E[id + 'u'] = u; return h('div', { class: 'rm-hi' + (cls ? ' ' + cls : '') }, v, u); };
    // grand écran : une seconde ligne sous la première, avec le temps, la distance parcourue et la distance restante
    E.hud = h('div', { class: 'rm-hud rm-card' },
      h('div', { class: 'rm-hud1' }, item('v', 'km/h'), item('p', 'W'), item('sl', '% pente'), item('wd', 'vent km/h', 'sm wd'), item('fc', 'bpm', 'sm fc')),
      h('div', { class: 'rm-hud2 wide-only' }, item('tm', 'temps', 'sm'), item('di', 'distance', 'sm'), item('re', 'restant', 'sm')));
    // vent relatif au cycliste : une flèche (sens où il souffle, en haut = vers l'avant : vent de face = flèche vers le bas) et sa vitesse ;
    // fréquence cardiaque simulée (modèle physiologique seulement)
    E.wd.textContent = '';
    E.wdArrow = h('span', { class: 'rm-wa' });
    E.wdArrow.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1.5 L14.5 9 L10.4 9 L10.4 16.5 L7.6 16.5 L7.6 9 L3.5 9 Z" fill="currentColor"/></svg>';
    E.wdVal = h('span', null, '–');
    E.wd.append(E.wdArrow, E.wdVal);
    E.fcBox = E.fc.parentElement; E.fcBox.hidden = true;
    // grand écran : bloc « Statistiques » (celui de la carte et celui qui était en bas du panneau de droite, fusionnés), à gauche de la carte
    // ou dans le panneau de droite selon son réglage. Le temps, la distance et le restant sont dans l'entête.
    const STATS = [
      ['ed', 'Énergie économisée'], ['va', 'Vitesse moy.'], ['pa', 'Puissance moy.'], ['np', 'Puissance norm.'], ['wk', 'Travail'],
      ['dc', 'D+ cumulé'], ['dr', 'D+ restant'], ['wm', 'W′ mini'], ['pm', 'P max'], ['sh', 'Temps abrité'], ['rp', 'Relais pris'], ['fo', 'Forme du jour'], ['ma', 'Machine'],
      // modèle physiologique (option de course) : signature effective et état du corps
      ['pc', 'PC effective'], ['gy', 'Glycogène I · II · foie'], ['gl', 'Glycémie'], ['tc', 'Temp. centrale'], ['hr', 'FC estimée'], ['ox', 'Lipides · glucides'], ['sw', 'Sueur · sodium'],
    ];
    E.stat = {};
    E.statsTitle = h('h3', { class: 'chart-title-editable', title: 'Double-clique pour choisir où afficher les statistiques' }, 'Statistiques');
    E.statsTitle.addEventListener('dblclick', (e) => { e.preventDefault(); openStatsConfig(); });
    E.stats = h('div', { class: 'rm-stats wide-only' }, E.statsCard = h('div', { class: 'rm-stats-card rm-card' }, h('div', { class: 'chart-head' }, E.statsTitle), ...STATS.map(([id, label]) => {
      E.stat[id] = h('strong', null, '–');
      return h('div', { class: 'rm-sr' }, h('span', null, label), E.stat[id]);
    })));
    E.stat.ed.parentElement.title = 'Énergie économisée grâce à l\'aspiration (dans les roues, ou devant un groupe)';
    E.stat.np.parentElement.title = 'Puissance normalisée (NP) depuis le départ';
    E.stat.wm.parentElement.title = 'W′ restant le plus bas depuis le départ';
    E.stat.pm.parentElement.title = 'Puissance maximale depuis le départ';
    E.stat.dc.parentElement.title = 'Dénivelé positif cumulé depuis le départ';
    E.stat.dr.parentElement.title = 'Dénivelé positif restant avant l’arrivée';
    for (const id of ['rp', 'fo', 'ma', ...PHYS_STATS]) E.stat[id].parentElement.hidden = true; // lignes affichées seulement quand elles ont quelque chose à dire
    E.stat.pc.parentElement.title = 'Puissance critique du moment (CP2 effective) : glycogène, fatigue des fibres, chaleur, eau, altitude et commande centrale';
    E.stat.gy.parentElement.title = 'Glycogène des fibres lentes (I), des fibres rapides (II) et du foie, en % de leur capacité';
    E.stat.tc.parentElement.title = 'Température centrale (noyau) : au-delà de 39,5 °C la capacité baisse, vers 40 °C la commande centrale lâche';
    E.stat.hr.parentElement.title = 'Fréquence cardiaque prédite par le modèle (réserve de VO₂, dérive thermique et de déshydratation)';
    E.stat.ox.parentElement.title = 'Lipides et glucides oxydés en ce moment (g/h)';
    E.stat.sw.parentElement.title = 'Débit de sueur et natrémie (sodium du sang, mmol/L ; sous 135 : hyponatrémie)';
    E.chips = h('div', { class: 'rm-chips' });
    // watts économisés grâce à l'aspiration : « (−24) » en vert à droite de la puissance
    E.pd = h('span', { class: 'rm-hd', hidden: true, title: 'Watts que tu n\'as pas à dépenser grâce à l\'aspiration' });
    const pRow = h('div', { class: 'rm-hvrow' });
    E.p.replaceWith(pRow);
    pRow.append(E.p, E.pd);
    // grand écran : vitesse ascensionnelle (m/h, moyenne glissante sur 30 s) à droite de la vitesse
    E.vam = h('span', { class: 'rm-vam wide-only', title: 'Vitesse ascensionnelle (VAM), moyenne sur les 30 dernières secondes' }, '–');
    const vRow = h('div', { class: 'rm-hvrow' });
    E.v.replaceWith(vRow);
    vRow.append(E.v, E.vam);

    // colonne de boutons carrés
    // le temps est déjà dans l'entête du grand écran : ce carré ne sert que sur téléphone
    E.clock = h('div', { class: 'rm-sq rm-card phone-only', 'aria-label': 'Temps de course' }, '0:00');
    E.rankTxt = h('span', null, '–');
    E.rank = h('button', { class: 'rm-sq rm-card phone-only', type: 'button', 'aria-label': 'Ouvrir le classement', onclick: () => openSheet('rank') }, E.rankTxt);
    E.prof = h('button', { class: 'rm-sq rm-card phone-only', type: 'button', 'aria-label': 'Ouvrir le profil de l\'étape', onclick: () => openSheet('prof') }, icProfile());
    E.speed = h('button', { class: 'rm-sq rm-card', type: 'button', 'aria-label': 'Vitesse du temps', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: toggleSpeedPicker }, '×1');
    // les vitesses disponibles (celles de #g-speed) se déroulent vers la gauche à partir du bouton
    E.speedOpts = h('div', { class: 'rm-speedopts', role: 'radiogroup', 'aria-label': 'Vitesse du temps', hidden: true },
      ...[...$('#g-speed').options].map((o) => h('button', {
        class: 'rm-sq rm-card rm-so', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-v': o.value, onclick: () => pickSpeed(o.value),
      }, '×' + o.value)));
    E.speedWrap = h('div', { class: 'rm-speedwrap' }, E.speed, E.speedOpts);
    E.quit = h('button', { class: 'rm-sq rm-card phone-only', type: 'button', hidden: true, 'aria-label': 'Quitter la course', onclick: () => TG.quit() }, '✕');
    // grand écran : afficher / masquer le profil d'élévation et le profil de puissance (record, étape, disponible) sous la carte
    const viewButton = (key, label, ic) => h('button', {
      class: 'rm-sq rm-card wide-only', type: 'button', 'aria-pressed': 'true', 'aria-label': label, title: label, onclick: () => setView(key),
    }, ic());
    E.tgStats = viewButton('gameStats', 'Afficher ou masquer les statistiques (temps, distance, puissance normalisée, énergie…)', icStats);
    E.tgProfile = viewButton('gameProfile', 'Afficher ou masquer le profil d\'élévation', icProfile);
    E.tgCurve = viewButton('gameCurve', 'Afficher ou masquer le profil de puissance record', icCurve);
    // grand écran : fond de carte (le contrôle de Leaflet est masqué), une liste qui se déroule sous le bouton
    E.baseBtn = h('button', { class: 'rm-sq rm-card', type: 'button', 'aria-label': 'Fond de carte', title: 'Fond de carte', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: toggleBaseMenu }, icLayers());
    E.baseMenu = h('div', { class: 'rm-basemenu rm-card', role: 'radiogroup', 'aria-label': 'Fond de carte', hidden: true });
    E.baseWrap = h('div', { class: 'rm-basewrap wide-only' }, E.baseBtn, E.baseMenu);
    // grand écran, peloton en 2D : la carte au plus près du joueur, pour voir sa place parmi ceux qui l'entourent
    E.zoom = h('button', {
      class: 'rm-sq rm-card wide-only', type: 'button', hidden: true, 'aria-pressed': 'false', 'aria-label': 'Zoom peloton',
      title: 'Zoom peloton : la carte au plus près, ta place dans le groupe (touche Z)', onclick: () => { TG.toggleCloseUp(); refresh(); },
    }, icZoom());
    // téléphone, peloton en 2D : changer de rang en penchant l'appareil (comme ← →) ; la posture du départ ou de la reprise est la neutralité
    E.tilt = h('button', {
      class: 'rm-sq rm-card rm-tilt phone-only', type: 'button', hidden: true, 'aria-pressed': 'false', 'aria-label': 'Changer de rang en penchant le téléphone',
      title: 'Penche le téléphone à droite ou à gauche pour changer de rang (gardé penché, les rangs s\'enchaînent)', onclick: async () => { await TG.setTilt(!G.tiltOn); refresh(); },
    }, icTilt());
    // boussole : par défaut la carte suit l'orientation du cycliste ; enfoncée, le nord reste en haut
    E.compass = h('button', {
      class: 'rm-sq rm-card', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Orientation de la carte',
      onclick: () => { TG.setNorthUp(!(G.snap && G.snap.northUp)); refresh(); },
    }, icCompass());
    E.side = h('div', { class: 'rm-side' }, E.clock, E.rank, E.prof, pauseButton('rm-sq rm-card'), E.speedWrap, E.baseWrap, E.compass, ...(PYR.view3d ? PYR.view3d.buttons() : []), E.zoom, E.tilt, E.quit);
    // grand écran : les trois boutons d'affichage (statistiques, profil, puissance) en haut de la colonne de gauche
    E.views = h('div', { class: 'rm-views wide-only' }, E.tgStats, E.tgProfile, E.tgCurve);

    // feuille Profil ou Classement : chaque vignette de la colonne de droite ouvre sa feuille, sans onglets
    // téléphone, feuille Classement : étape (chronomètre), grimpeur (maillot à pois rouges), sprinteur (maillot vert), à gauche de « Résumé / Tous »
    const CV = PYR.classifView;
    const clsBtn = (id, label, icon) => {
      const b = h('button', { class: 'rm-clsbtn', type: 'button', 'aria-label': label, title: label, 'aria-pressed': 'false', onclick: () => { TG.showClassTab(id); refresh(); } }, icon);
      E['cls_' + id] = b;
      return b;
    };
    E.clsGroup = h('div', { class: 'rm-clsgroup', role: 'group', 'aria-label': 'Classements' },
      clsBtn('stage', 'Classement de l’étape (au temps)', icStopwatch()), clsBtn('kom', 'Classement du grimpeur (maillot à pois rouges)', CV.jersey('kom')),
      clsBtn('points', 'Classement du sprinteur (maillot vert)', CV.jersey('green')));
    E.profSlot = h('div', { class: 'rm-slot rm-prof-slot' });
    E.rankSlot = h('div', { class: 'rm-slot' });
    E.noRank = h('p', { class: 'rm-note' }, 'Aucun autre coureur sur cette course.');
    E.replay = h('button', { class: 'rm-act', type: 'button', onclick: replay }, 'Rejouer l\'étape');
    E.leave = h('button', { class: 'rm-act phone-only', type: 'button', onclick: () => TG.quit() }, 'Quitter');
    E.fin = h('div', { class: 'rm-fin', hidden: true }, E.replay, E.leave);
    E.vProf = h('div', { class: 'rm-view', 'data-view': 'prof' }, E.profSlot);
    E.vRank = h('div', { class: 'rm-view', 'data-view': 'rank' }, E.noRank, E.rankSlot);
    E.sheet = h('div', { class: 'rm-sheet rm-card', role: 'dialog', 'aria-label': 'Informations de course', hidden: true },
      h('div', { class: 'rm-sh' }, E.shTitle = h('strong', { class: 'rm-shtitle' }), E.shRight = h('div', { class: 'rm-shr' }, E.clsGroup)),
      E.vProf, E.vRank, E.fin);

    // réserves + durée tenable
    E.rows = [reserveRow('W′'), reserveRow('Glycogène', true), reserveRow('Hydratation'), reserveRow('PPR')];
    E.rows[3].el.title = 'PPR : part de ta courbe de puissance record utilisée (touche pour le détail)';
    E.tv = h('div', { class: 'rm-tv' }, '–');
    E.ts = h('div', { class: 'rm-ts' });
    // toucher « Tenable » ou le glycogène ouvre le détail (limites de la durée tenable, digestion) ; sans déclencher l'alternance % / valeurs
    const opener = (key) => (e) => { e.stopPropagation(); if (reservesToPockets()) setPockets(E.pockets.hidden); else togglePop(key); };
    const openerKey = (key) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (reservesToPockets()) setPockets(E.pockets.hidden); else togglePop(key); } };
    E.rows[1].el.classList.add('rm-info');
    E.rows[1].el.setAttribute('role', 'button'); E.rows[1].el.tabIndex = 0;
    E.rows[1].el.setAttribute('aria-label', 'Détail de la digestion');
    E.rows[1].el.addEventListener('click', opener('gut')); E.rows[1].el.addEventListener('keydown', openerKey('gut'));
    // « Record » : part de la courbe de puissance record utilisée ; le détail (courbe disponible et explication) est dans sa propre fenêtre
    E.rows[3].el.classList.add('rm-info');
    E.rows[3].el.setAttribute('role', 'button'); E.rows[3].el.tabIndex = 0;
    E.rows[3].el.setAttribute('aria-label', 'Détail de la courbe de puissance record');
    E.rows[3].el.addEventListener('click', opener('ppr')); E.rows[3].el.addEventListener('keydown', openerKey('ppr'));
    E.res = h('div', {
      class: 'rm-res rm-card', role: 'button', tabindex: '0', 'aria-label': 'Réserves et durée tenable. Toucher pour ouvrir les poches et bidons (avec l’alimentation), sinon pour alterner pourcentages et valeurs',
      onclick: onReserves, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReserves(); } },
    }, E.barsA = h('div', { class: 'rm-bars' }, ...E.rows.map((r) => r.el)), E.tteBox = h('div', {
      class: 'rm-tte rm-info', role: 'button', tabindex: '0', 'aria-label': 'Détail de la durée tenable', onclick: opener('tte'), onkeydown: openerKey('tte'),
    }, h('div', { class: 'rm-tl' }, 'Tenable'), E.tv, E.ts));
    E.pop = h('div', { class: 'rm-pop rm-card', role: 'dialog', hidden: true, onclick: () => togglePop(null) });
    E.fuel = h('div', { class: 'rm-fuel' }); // Ravito : au-dessus de la carte (téléphone) ou avec les autres actions (grand écran)
    // « Poches / Bidons » remplace Manger et Boire : une fenêtre pour mettre la main à la poche (bidons, camelback, gels, barres)
    E.pocketsSub = h('small', null, '');
    E.pocketsBtn = h('button', {
      class: 'rm-act rm-pocketsbtn', type: 'button', hidden: true, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      title: 'Poches / Bidons : choisis ce que tu bois et ce que tu manges (touches M et B : choix automatique)', onclick: () => setPockets(E.pockets.hidden),
    }, h('span', null, 'Poches / Bidons'), E.pocketsSub);
    E.pockets = h('div', { class: 'rm-pockets rm-card', role: 'dialog', 'aria-label': 'Poches et bidons', hidden: true });
    E.bottom = h('div', { class: 'rm-bottom' }, E.sheet, E.pop, E.fuel, E.res);

    // le bas de la carte : réserves et ravitaillement, puis (voir plus bas) la barre de puissance et les actions, le tout sur la carte
    E.dock = h('div', { class: 'rm-dock' }, E.bottom);
    // grand écran : colonne à gauche de la carte, alignée à gauche : statistiques, profil d'élévation, puissance selon la durée (voir mount)
    E.charts = h('div', { class: 'rm-charts wide-only' }, E.stats);
    // grand écran : les réserves (glycogène, hydratation, W′, Record, Tenable) sous l'entête, entre les boutons de gauche et de droite
    E.reserves = h('div', { class: 'rm-reserves wide-only' });
    E.rm = h('div', { class: 'rm', hidden: true }, E.hud, E.chips, E.side, E.views, E.reserves, E.charts, E.dock, E.pockets);
    mapWrap.append(E.rm);

    // panneau du bas : barre de puissance par zones, − / +, tactiques
    E.zl = h('span', null, '');
    // chaque zone est un bouton : un clic règle la puissance nominale de la zone (voir selectZone), un glisser sur la barre règle au watt près
    E.zones = PB.NAMES.map((n, i) => h('div', {
      class: 'rm-z z' + (i + 1), role: 'button', 'data-zone': String(i), onclick: () => selectZone(i),
    }, n));
    // partie de la barre devenue indisponible : au-dessus de la puissance que le cycliste peut produire en ce moment (W′, courbe record, fatigue)
    E.lock = h('div', { class: 'rm-lock', hidden: true });
    // bandes de durée tenable : rien, puis jaune (20 min), orange (5 min), rouge (1 min), gris (15 s) de plus en plus opaques, et gris foncé
    // au-delà de la limite d'une seconde (restriction automatique de la puissance) ; chaque bande est une grille (voir css)
    // les variables CSS (--c : couleur, --a : opacité) se posent avec setProperty : D.h ne sait pas les écrire
    const tinted = (el, x) => { el.style.setProperty('--c', x.rgb); el.style.setProperty('--a', String(x.a)); return el; };
    E.heatBands = HEAT.slice(1).map((x) => tinted(h('div', { class: 'rm-hb', hidden: true }), x));
    E.bar = h('div', { class: 'rm-bar', role: 'slider', tabindex: '0', 'aria-label': 'Puissance demandée', 'aria-valuemin': '0' }, ...E.zones, ...E.heatBands, E.lock);
    E.tickPC = h('div', { class: 'rm-tick pc' });
    E.labPC = h('div', { class: 'rm-tlab' }, 'PC');
    // repères du dégradé sous la barre : 20 min, 5 min, 1 min, 15 s
    E.heatLabs = HEAT.slice(1).map((x) => tinted(h('div', { class: 'rm-hl', hidden: true }, x.label), x));
    E.tickMax = h('div', { class: 'rm-tick max', title: 'Puissance maximale possible en ce moment' });
    E.cursor = h('div', { class: 'rm-cursor' });
    const step = (label, aria, dir) => { const b = h('button', { class: 'rm-step', type: 'button', 'aria-label': aria }, label); bindStep(b, dir); return b; };
    const mode = (id, label, cls) => { const b = h('button', { class: 'rm-act' + (cls ? ' ' + cls : ''), type: 'button', 'data-mode': id, 'aria-pressed': 'false', onclick: () => tactic(id) }, label); E['m_' + id] = b; return b; };
    mode('cover', 'Suivre les attaques', 'wide-only'); // place le bouton dans E.m_cover, rangé plus bas sous « Suivre »
    E.wAuto = h('button', { class: 'rm-act wide-only', type: 'button', 'aria-pressed': 'false', onclick: toggleAuto }, 'Pilote automatique');
    // les actions : sous la barre de puissance sur téléphone, en colonne à gauche de la carte sur grand écran (voir mount)
    E.acts = h('div', { class: 'rm-acts' }, mode('relay', 'Relayer'), sprintButton(), mode('follow', 'Suivre'), E.wAuto);
    // « Suivre les attaques » est un sous-bouton de « Suivre », avec deux limites à partir desquelles on se laisse décrocher :
    // « W′ > » (part de W′ à conserver) et « PPR < » (part maximale de la courbe de puissance record utilisée)
    const limitField = (label, title, key, min, max) => {
      const inp = h('input', { type: 'number', min: String(min), max: String(max), step: '5', inputmode: 'numeric', 'aria-label': title });
      inp.addEventListener('change', () => { if (inp.value !== '') TG.setFollowLimit(key, inp.value); refresh(); });
      return { inp, el: h('label', { class: 'rm-pullf', title }, h('span', null, label), inp, h('small', null, '%')) };
    };
    const limW = limitField('W′ >', 'Tu te laisses décrocher plutôt que de passer sous ce pourcentage de ton W′ : l\'effort est limité à la puissance qui ferait franchir la limite (0 : pas de limite). Le champ clignote en orange puis en rouge à l\'approche de la limite.', 'followW', 0, 95);
    const limP = limitField('PPR <', 'Tu te laisses décrocher plutôt que de dépasser ce pourcentage de ta courbe de puissance record utilisée : l\'effort est limité à la puissance qui ferait franchir la limite (100 : pas de limite). Le champ clignote en orange puis en rouge à l\'approche de la limite.', 'followPpr', 5, 100);
    E.limW = limW.inp; E.limP = limP.inp; E.limWBox = limW.el; E.limPBox = limP.el;
    E.followSub = h('div', { class: 'rm-relaysub', hidden: true }, limW.el, limP.el, E.m_cover);
    // mode relais : « Passer le relais » (actif quand on mène), durée d'un relais et deux limites à partir desquelles on laisse le relais :
    // « W′ > » et « PPR < » ; visibles seulement avec « Relayer » (voir update et mount)
    E.passBtn = h('button', { class: 'rm-act rm-pass', type: 'button', onclick: passRelay }, 'Passer le relais');
    // durée d'un relais : de 5 à 300 s, puis « ∞ » (sans limite de durée, 0 en interne). Vrai champ numérique, donc avec les petites flèches
    // du navigateur : il va de 5 à 305 par pas de 5, et 305 (au-delà de 300) s'affiche « ∞ » (texte du champ masqué, « ∞ » posé par-dessus)
    E.pullIn = h('input', { type: 'number', min: '5', max: String(PULL_INF), step: '5', inputmode: 'numeric', 'aria-label': 'Durée d\'un relais, en secondes, de 5 à 300 puis infini (sans limite de durée)' });
    // le symbole ∞ est un dessin (SVG) et non un caractère : sa forme ne dépend pas des polices du système ; fitInf le cale exactement
    // sur la boîte du texte « 300 » du champ (même position, même largeur, même hauteur de chiffres)
    E.pullInf = h('span', { class: 'rm-inf', 'aria-hidden': 'true' }, D.svg('svg', { viewBox: '0 0 24 12', class: 'rm-infsvg', preserveAspectRatio: 'none' },
      D.svg('path', { d: 'M12 6 C 9.6 1.2, 2.6 1.2, 2.6 6 C 2.6 10.8, 9.6 10.8, 12 6 C 14.4 1.2, 21.4 1.2, 21.4 6 C 21.4 10.8, 14.4 10.8, 12 6 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linejoin': 'round' })));
    E.pullBox = h('span', { class: 'rm-numwrap' }, E.pullIn, E.pullInf);
    E.pullUnit = h('small', null, 's');
    const showPull = () => {
      const s = TG.pullSec();
      E.pullIn.value = s === 0 ? String(PULL_INF) : String(s);
      E.pullBox.classList.toggle('is-inf', s === 0);
      fitInf();
    };
    const applyPull = (sec) => { TG.setPullSec(sec); showPull(); refresh(); };
    E.pullIn.addEventListener('change', () => {
      const n = Number(E.pullIn.value);
      if (E.pullIn.value === '' || !Number.isFinite(n)) { showPull(); refresh(); return; } // saisie illisible : on revient à la valeur en cours
      applyPull(n > 300 ? 0 : Math.max(5, n)); // au-delà de 300 : ∞
    });
    const relW = limitField('W′ >', 'Tu laisses le relais dès que ton W′ passe sous ce pourcentage (0 : pas de limite). Le champ clignote en orange puis en rouge à l\'approche de la limite.', 'relayW', 0, 95);
    const relP = limitField('PPR <', 'Tu laisses le relais dès que tu utilises plus de ce pourcentage de ta courbe de puissance record (100 : pas de limite). Le champ clignote en orange puis en rouge à l\'approche de la limite.', 'relayPpr', 5, 100);
    E.relW = relW.inp; E.relP = relP.inp; E.relWBox = relW.el; E.relPBox = relP.el;
    E.relaySub = h('div', { class: 'rm-relaysub', hidden: true },
      h('label', { class: 'rm-pullf', title: 'Durée d\'un relais, de 5 à 300 s puis ∞ (sans limite de durée)' }, h('span', { class: 'rm-pullic', role: 'img', 'aria-label': 'Durée' }, icStopwatch()), E.pullBox, E.pullUnit), relW.el, relP.el, E.passBtn);
    E.panel = h('div', { class: 'rm-panel', hidden: true },
      h('div', { class: 'rm-p1' }, h('span', null, 'Puissance demandée'), E.zl),
      h('div', { class: 'rm-p2' }, step('−', 'Diminuer la puissance', -1),
        h('div', { class: 'rm-barwrap' }, E.bar, E.tickPC, E.labPC, ...E.heatLabs, E.tickMax, E.cursor),
        step('+', 'Augmenter la puissance', 1)),
      E.acts);
    // deuxième ligne du bas : la barre de puissance, et sur grand écran le bouton Attaque / Sprint à sa droite, sous Manger / Boire
    E.dockRow = h('div', { class: 'rm-dock-row' }, E.panel);
    E.dock.append(E.dockRow);
    bindBar();
  }

  /* ---------- barre de puissance ---------- */
  function fracOf(e) {
    const r = E.bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }

  /** Pas de la barre et des boutons − / + : le watt sur grand écran (souris), 5 W au doigt. */
  const stepW = () => (mode === 'wide' ? STEP_WIDE : STEP);

  /** Règle la consigne (reprise en main, ou puissance de relais en mode relais) et rafraîchit aussitôt l'écran. */
  function setPower(p) {
    TG.setCmd(p);
    refresh();
  }

  /** Puissance nominale d'une zone (celle de la tactique correspondante), arrondie au pas de la barre ; null sans cycliste. */
  function zonePower(i) {
    const P = G.me ? Tac.steadyPower(G.me, PB.MODES[i]) : null;
    return P === null ? null : Math.round(P / stepW()) * stepW();
  }

  /** Clic sur une zone : la puissance nominale de la zone, pas la position du pointeur. */
  function selectZone(i) {
    if (swallowClick) return; // fin d'un glisser, pas un clic
    const P = zonePower(i);
    if (P !== null) setPower(P);
  }

  let swallowClick = false;

  function bindBar() {
    // Le pointeur n'est capturé qu'une fois le glisser engagé : un simple clic reste un clic sur la zone touchée (bouton),
    // et un glisser règle la puissance sous le pointeur, au watt près.
    let drag = null;
    E.bar.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
    });
    E.bar.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id || !edges) return;
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) { drag = null; return; } // bouton relâché hors de la barre
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= DRAG_PX) return;
        drag.moved = true;
        try { E.bar.setPointerCapture(e.pointerId); } catch (_) { /* pointeur déjà relâché */ }
      }
      setPower(Math.round(PB.posToPower(fracOf(e), edges) / stepW()) * stepW());
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 60); }
      drag = null;
    };
    E.bar.addEventListener('pointerup', end);
    E.bar.addEventListener('pointercancel', end);
    E.bar.addEventListener('lostpointercapture', end);
    E.bar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setPower(G.cmd + stepW()); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setPower(G.cmd - stepW()); }
    });
  }

  /**
   * Libellés des zones : « Z1 - Récupération »… quand la place le permet, sinon « Z1 - Récup », sinon « Récup ».
   * Le même niveau pour les cinq zones : le premier où aucun libellé ne déborde de son segment.
   */
  function fitZoneLabels() {
    if (!E.bar.clientWidth) return; // barre masquée : rien à mesurer
    let level = 0;
    for (; level < PB.LEVELS - 1; level++) {
      E.zones.forEach((z, i) => { z.textContent = PB.zoneText(i, level); });
      if (E.zones.every((z) => z.scrollWidth <= z.clientWidth)) break;
    }
    E.zones.forEach((z, i) => { z.textContent = PB.zoneText(i, level); });
  }

  /** − / + : un pas par appui (1 W sur grand écran, 5 W sur téléphone), répété à l'appui long, puis cinq fois plus gros. */
  function bindStep(btn, dir) {
    let t0 = 0, to = null, iv = null;
    const stop = () => { clearTimeout(to); clearInterval(iv); to = iv = null; };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setPower(G.cmd + dir * stepW());
      t0 = performance.now();
      to = setTimeout(() => {
        iv = setInterval(() => setPower(G.cmd + dir * stepW() * (performance.now() - t0 > HOLD_FAST ? 5 : 1)), HOLD_EVERY);
      }, HOLD_FIRST);
    });
    for (const n of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(n, stop);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => { if (e.detail === 0) setPower(G.cmd + dir * stepW()); }); // clavier
  }

  /* ---------- actions ---------- */
  /**
   * Bouton « Sprint » (attaque et sprint réunis) : chaque appui monte l'effort de 20 % de l'écart entre le haut de la zone PMA et
   * le record de puissance le plus élevé, il retombe si l'on cesse d'appuyer. Réagit dès le toucher pour pouvoir marteler.
   * La barre du bas du bouton montre le niveau atteint.
   */
  function sprintButton() {
    E.sprFill = h('i');
    E.m_sprint = h('button', {
      class: 'rm-act rm-spr', type: 'button', 'data-mode': 'sprint', 'aria-pressed': 'false',
      title: 'Appuie plusieurs fois pour monter et maintenir l\'effort (touches 6 et 7)',
      onpointerdown: (e) => { e.preventDefault(); TG.sprintTap(); },
      onclick: (e) => { if (e.detail === 0) TG.sprintTap(); }, // clavier
      oncontextmenu: (e) => e.preventDefault(),
    }, E.sprLabel = h('span', null, 'Sprint'), E.sprFill);
    return E.m_sprint;
  }

  function tactic(id) {
    TG.setTactic(id);
    refresh();
  }

  function toggleAuto() {
    const c = $('#g-auto');
    if (c.disabled) return;
    c.checked = !c.checked;
    c.dispatchEvent(new Event('change'));
    refresh();
  }

  /** Vitesse du temps : le bouton déroule les vitesses possibles vers la gauche, on touche celle voulue. */
  function toggleSpeedPicker() {
    if ($('#g-speed').disabled) return;
    setSpeedPicker(E.speedOpts.hidden);
  }

  function setSpeedPicker(open) {
    if (open) setBaseMenu(false); // une seule liste ouverte à la fois
    E.speedOpts.hidden = !open;
    E.speed.setAttribute('aria-expanded', String(open));
  }

  /* ---------- fond de carte (grand écran) ---------- */
  function setBaseMenu(open) {
    if (open) setSpeedPicker(false); // une seule liste ouverte à la fois
    if (open && !E.baseMenu.children.length) { // la liste se construit à la première ouverture, une fois la carte prête
      for (const b of PYR.map.baseLayers || []) {
        E.baseMenu.append(h('button', { class: 'rm-bo', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-id': b.id, onclick: () => { PYR.map.setBase(b.id); setBaseMenu(false); } }, b.label));
      }
    }
    if (open) { const cur = PYR.map.baseId && PYR.map.baseId(); for (const o of E.baseMenu.children) o.setAttribute('aria-checked', String(o.dataset.id === cur)); }
    E.baseMenu.hidden = !open;
    E.baseBtn.setAttribute('aria-expanded', String(open));
  }

  function toggleBaseMenu() {
    setBaseMenu(E.baseMenu.hidden);
  }

  document.addEventListener('pointerdown', (e) => { if (E.baseMenu && !E.baseMenu.hidden && !E.baseWrap.contains(e.target)) setBaseMenu(false); });

  /** Choisit la vitesse (le réglage #g-speed garde sa liaison avec l'état) et referme la liste. */
  function pickSpeed(v) {
    const sel = $('#g-speed');
    if (!sel.disabled) { sel.value = v; sel.dispatchEvent(new Event('change')); }
    setSpeedPicker(false);
    refresh();
  }

  /** Pause / reprise ; avant le départ (partie annulée pendant le décompte, puis page de jeu rouverte), le bouton relance la partie. */
  function togglePlay() {
    if (!G.running && !G.finished && G.st && G.st.t === 0) TG.start(); else TG.togglePause();
    refresh();
  }

  /* ---------- détails : durée tenable et digestion ---------- */
  function togglePop(key) {
    popKey = popKey === key ? null : key;
    if (popKey) { sheetTab = null; applySheet(); }
    E.pop.hidden = !popKey;
    layout();
    refresh();
  }

  const clock = (t) => (Number.isFinite(t) ? U.fmtClock(t) : '> 6 h');

  /** Durée en toutes lettres : « 15 s », « 1 min », « 1 min 05 s », « 5 min », « 1 h 30 min ». */
  function durText(d) {
    if (d < 60) return `${Math.round(d)} s`;
    return U.fmtDuration(d).replace(/ 00 s$/, '').replace(/ 00 min$/, '');
  }

  /** Tableau « puissance disponible à partir de maintenant » : par durée, la puissance disponible, le record frais et leur rapport. */
  function fwdGrid(s) {
    const grid = h('div', { class: 'rm-fwd' }, h('span', { class: 'hd' }, 'Pendant'), h('span', { class: 'hd r' }, 'Disponible'), h('span', { class: 'hd r' }, 'Record frais'), h('span', { class: 'hd r' }, ''));
    for (const f2 of s.fwd) {
      const frac = f2.rec > 0 ? f2.P / f2.rec : 1;
      grid.append(h('span', null, durText(f2.tau)), h('span', { class: 'r' + (frac < 0.8 ? ' lim' : '') }, `${fmt(f2.P, 0)} W`), h('span', { class: 'r' }, `${fmt(f2.rec, 0)} W`),
        h('span', { class: 'r' + (frac < 0.8 ? ' lim' : '') }, `${fmt(Math.min(1, frac) * 100, 0)} %`));
    }
    return grid;
  }

  /** Contenu du détail ouvert (relu à chaque mise à jour du HUD). */
  function renderPop(s) {
    D.clear(E.pop);
    const line = (txt, cls) => h('div', { class: 'rm-pl' + (cls ? ' ' + cls : '') }, txt);
    const f = s.fuel;
    if (popKey === 'tte') {
      const t = s.tte;
      E.pop.append(h('h4', null, `Durée tenable à ${fmt(s.ttP, 0)} W`));
      if (!t) E.pop.append(line('Roue libre : aucune limite à cette puissance.'));
      else {
        const row = (id, label, v) => line(`${label} : ${clock(v)}`, t.by === id ? 'lim' : '');
        E.pop.append(
          row('wprime', `Épuisement de W′ (réserve au-dessus de la puissance critique ${fmt(s.cp, 0)} W)`, t.wprime),
          row('record', 'Limite de la courbe de puissance record', t.record));
        if (f) E.pop.append(row('fuel', 'Fringale (glycogène)', t.fuel));
        E.pop.append(line(`Limite atteinte en premier : ${t.by ? { wprime: 'W′', record: 'courbe de puissance record', fuel: 'fringale' }[t.by] : 'aucune'}.`, 'sum'));
      }
      if (s.fwd.length) {
        E.pop.append(h('h4', { class: 'rm-sub' }, 'Puissance disponible à partir de maintenant'), fwdGrid(s));
        E.pop.append(line(`Courbe record utilisée : ${fmt(s.usage.use * 100, 0)} % (fenêtre de ${durText(s.usage.d)}). Après un effort, la puissance disponible s'affaisse puis se reconstitue seconde après seconde.`, 'help'));
      }
      E.pop.append(line(s.tteHelp, 'help'));
    } else if (popKey === 'ppr') {
      E.pop.append(h('h4', null, 'PPR : courbe de puissance record'));
      E.pop.append(line(`Part utilisée : ${fmt(Math.min(s.usage.use, 9.99) * 100, 0)} % (fenêtre de ${durText(s.usage.d)})`, s.usage.use >= 0.9 ? 'lim' : ''));
      E.pop.append(line('Ta courbe de puissance record donne, pour chaque durée, la puissance maximale que tu sais produire frais. Le PPR est la part de cette courbe que ton effort récent consomme, sur la durée la plus exigeante.', 'help'));
      E.pop.append(line('Vert : de la marge. Orange puis rouge : tu approches de ta limite, la puissance disponible va s\'affaisser et tu ne pourras plus tenir cette allure. Au-delà de 100 %, c\'est la limite : tu lâches.', 'help'));
      if (s.fwd.length) E.pop.append(h('h4', { class: 'rm-sub' }, 'Puissance disponible à partir de maintenant'), fwdGrid(s));
      E.pop.append(line('Dans « Suivre », la limite « PPR < » te laisse décrocher plutôt que de dépasser la part choisie de ta courbe.', 'help'));
    } else if (popKey === 'gut' && f) {
      E.pop.append(h('h4', null, 'Glycogène et digestion'));
      const state = f.bonk ? ' — fringale !' : f.energy < 0.35 ? ' — mange !' : '';
      E.pop.append(line(`Glycogène : ${fmt(f.energy * 100, 0)} %${state}`, f.bonk ? 'lim' : ''));
      if (Math.abs(f.trend) >= 0.005) E.pop.append(line(`Tendance : ${f.trend > 0 ? '+' : '−'}${fmt(Math.abs(f.trend) * 100, 0)} % par heure`));
      if (f.gut > 1) {
        E.pop.append(
          line(`À absorber : ${fmt(f.gut, 0)} g de glucides (estomac ${fmt(f.stomach, 0)} g, intestin ${fmt(f.intestine, 0)} g).`),
          line(`Absorption en cours : ${fmt(f.absorbing, 0)} g/h (plafond ${fmt(f.ceiling, 0)} g/h).`));
      } else E.pop.append(line('Rien en cours de digestion.'));
      E.pop.append(line('Partie hachurée de la barre : glucides avalés, pas encore absorbés.', 'help'));
      E.pop.append(line('Le glycogène est le carburant stocké dans tes muscles et ton foie : en puisant dessus à haute intensité, il baisse, et à zéro, c’est la fringale. Manger des glucides le recharge.', 'help'));
      E.pop.append(line(`Hydratation : ${fmt(f.hydration * 100, 0)} %${f.dehydrated ? ' — bois !' : ''}${f.fluid ? ` · ${fmt(f.fluid, 2)} L dans les bidons` : ''}`));
      E.pop.append(line(`Vivres : ${f.gels} gel${f.gels > 1 ? 's' : ''} · ${f.bars} barre${f.bars > 1 ? 's' : ''}`));
      const ph = f.phys;
      if (ph) {
        // modèle physiologique : ce qui limite la puissance critique en ce moment, puis l'état du corps
        E.pop.append(h('h4', { class: 'rm-sub' }, `Physiologie · PC effective ${fmt(ph.CP2e, 0)} W (${fmt(ph.cpK * 100, 0)} %)`));
        const pct = (k) => `${k < 1 ? '−' : '+'}${fmt(Math.abs(1 - k) * 100, 1)} %`;
        const lim = [['glycogène', ph.gly], ['fatigue des fibres', ph.phi], ['chaleur', ph.mT * ph.VA_T], ['déshydratation', ph.mHyd], ['altitude', ph.mAlt], ['glycémie', ph.VA_glu], ['caféine, motivation', ph.VA_other]]
          .filter((x) => Math.abs(1 - x[1]) >= 0.005).map((x) => `${x[0]} ${pct(x[1])}`);
        E.pop.append(line(lim.length ? `Ce qui joue : ${lim.join(' · ')}` : 'Rien ne te limite encore : signature intacte.', ph.cpK < 0.9 ? 'lim' : ''));
        E.pop.append(line(`Glycogène : fibres lentes ${fmt(ph.gI * 100, 0)} %, rapides ${fmt(ph.gII * 100, 0)} %, foie ${fmt(ph.gL * 100, 0)} % · glycémie ${fmt(ph.glu, 1)} mmol/L`, ph.hypo ? 'lim' : ''));
        E.pop.append(line(`Brûlé en ce moment : ${fmt(ph.fat, 0)} g/h de lipides, ${fmt(ph.cho, 0)} g/h de glucides (dont ${fmt(ph.exo, 0)} g/h venus de ce que tu as mangé)`));
        E.pop.append(line(`Corps : noyau ${fmt(ph.Tc, 1)} °C, peau ${fmt(ph.Tsk, 1)} °C · sueur ${fmt(ph.SR, 1)} L/h · natrémie ${fmt(ph.Na, 0)} mmol/L · FC estimée ${fmt(ph.HR, 0)} bpm`, ph.hot || ph.hypoNa ? 'lim' : ''));
        if (ph.caf > 0.2) E.pop.append(line(`Caféine : ${fmt(ph.caf, 1)} mg/L dans le sang (effort perçu plus faible).`));
        E.pop.append(line('Modèle physiologique : chaque type de fibres a son glycogène ; le foie tient la glycémie ; la chaleur se lit au noyau et à la peau ; l’eau bue passe par l’estomac (1,2 L/h au plus).', 'help'));
      }
    } else {
      popKey = null; E.pop.hidden = true;
    }
  }

  /** Affiche ou masque un des deux profils sur la carte (grand écran) ; le choix est enregistré. */
  const VIEW_ATTR = { gameStats: 'data-hide-stats', gameProfile: 'data-hide-profile', gameCurve: 'data-hide-curve' };
  function applyViews() {
    const btn = { gameStats: E.tgStats, gameProfile: E.tgProfile, gameCurve: E.tgCurve };
    for (const key of Object.keys(VIEW_ATTR)) {
      const shown = store.state.ui[key] !== false;
      document.body.toggleAttribute(VIEW_ATTR[key], !shown);
      btn[key].setAttribute('aria-pressed', String(shown));
    }
  }

  function setView(key) {
    store.set('ui.' + key, store.state.ui[key] === false, true);
    applyViews();
    afterLayoutChange(); // la carte change de hauteur
  }

  /** Téléphone, avec l’alimentation : toucher le bloc des réserves (W′, glycogène, hydratation, PPR, Tenable) ouvre (ou referme) les poches et bidons, qui s’affichent sur la carte juste au-dessus du bloc. */
  function reservesToPockets() { return mode === 'phone' && !E.pocketsBtn.hidden; }
  function onReserves() { if (reservesToPockets()) setPockets(E.pockets.hidden); else toggleDetail(); }

  function toggleDetail() {
    detail = !detail;
    refresh();
  }

  function replay() {
    closeSheet();
    TG.reset();
    TG.start();
  }

  /* ---------- feuille ---------- */
  function applySheet() {
    const o = !!sheetTab;
    if (o) setSpeedPicker(false);
    E.sheet.hidden = !o;
    E.side.hidden = o; // la feuille couvre la colonne de boutons
    for (const v of [E.vProf, E.vRank]) v.hidden = v.dataset.view !== sheetTab;
    E.shTitle.textContent = sheetTab === 'rank' ? 'Classement' : sheetTab === 'prof' ? 'Profil d’élévation' : '';
    E.shRight.hidden = sheetTab !== 'rank';
  }

  function openSheet(tab) {
    popKey = null;
    E.pop.hidden = true;
    sheetTab = tab;
    applySheet();
    layout();
    refresh();
    if (sheetTab === 'prof' && G.chart) G.chart.surface.request();
  }

  function closeSheet() {
    sheetTab = null;
    applySheet();
    layout();
  }

  /* ---------- déplacement des widgets ---------- */
  function park(el, target) {
    if (!el || parked.some((p) => p.el === el)) return;
    const ph = document.createComment('rm');
    el.parentNode.insertBefore(ph, el);
    target.append(el);
    parked.push({ el, ph });
  }

  function unpark() {
    while (parked.length) {
      const { el, ph } = parked.pop();
      if (ph.parentNode) ph.parentNode.insertBefore(el, ph);
      ph.remove();
    }
  }

  /**
   * Grand écran : place le profil d'élévation et la puissance selon la durée, chacun selon son réglage (fenêtre de configuration du graphique) :
   * sur la carte (colonne de gauche, après les statistiques) ou dans le panneau de droite, sous le classement et au-dessus du texte d'aide.
   * Les emplacements d'origine sont mémorisés une fois (park), pour tout remettre en place en quittant l'écran de course.
   */
  function placeCharts() {
    if (mode !== 'wide') return;
    const ui = store.state.ui, side = $('#game-side-charts');
    const prof = $('#bottom'), curve = $('#game-curve-wrap');
    for (const el of [prof, curve]) if (!parked.some((p) => p.el === el)) park(el, E.charts);
    // statistiques, profil, puissance : dans cet ordre dans chacun des deux emplacements (append déplace le bloc à la fin de sa nouvelle
    // boîte, donc ajouter les blocs dans l'ordre garde l'ordre)
    for (const [el, onSide] of [[E.stats, ui.gameStatsSide], [prof, ui.gameProfileSide], [curve, ui.gameCurveSide]]) (onSide ? side : E.charts).append(el);
  }

  /** Fenêtre de réglage des statistiques (double clic sur leur titre) : sur la carte, ou dans le panneau de droite sous le classement. */
  /** Statistiques en liste (une ligne par donnée) ou en vignettes (une carte par donnée). */
  function applyStatsView() {
    E.statsCard.classList.toggle('tiles', !!store.state.ui.gameStatsTiles);
    E.stats.classList.toggle('tiles-on', !!store.state.ui.gameStatsTiles);
  }

  function openStatsConfig() {
    const pos = M.positionRow('stats');
    const setView = (tiles) => {
      store.set('ui.gameStatsTiles', tiles, true);
      applyStatsView();
      refreshView();
      afterLayoutChange();
    };
    const vList = h('button', { type: 'button', onclick: () => setView(false) }, 'Liste');
    const vTiles = h('button', { type: 'button', onclick: () => setView(true) }, 'Vignettes');
    const refreshView = () => {
      const tiles = !!store.state.ui.gameStatsTiles;
      vList.setAttribute('aria-pressed', String(!tiles));
      vTiles.setAttribute('aria-pressed', String(tiles));
    };
    refreshView();
    const set = (side) => {
      store.set('ui.gameStatsSide', side, true);
      refreshBtns();
      M.placeCharts();
      pos.refresh(); // carte ou bande : les voisins possibles ne sont plus les mêmes
    };
    const bMap = h('button', { type: 'button', onclick: () => set(false) }, 'Sur la carte');
    const bSide = h('button', { type: 'button', onclick: () => set(true) }, 'Panneau de droite');
    const refreshBtns = () => {
      const side = !!store.state.ui.gameStatsSide;
      bMap.setAttribute('aria-pressed', String(!side));
      bSide.setAttribute('aria-pressed', String(side));
    };
    refreshBtns();
    D.modal({
      title: 'Configuration — Statistiques',
      body: [
        h('p', { class: 'hint' }, 'En mode jeu sur grand écran, les statistiques s\'affichent sur la carte (colonne de gauche) ou dans le panneau de droite, sous le classement et au-dessus du texte « Gère toi-même l\'effort… ». Le réglage est enregistré.'),
        h('div', { class: 'cc-place' }, h('span', { class: 'cc-label' }, 'Affichage'), h('div', { class: 'seg-control', role: 'radiogroup', 'aria-label': 'Où afficher les statistiques' }, bMap, bSide)),
        h('div', { class: 'cc-place' }, h('span', { class: 'cc-label' }, 'Présentation'), h('div', { class: 'seg-control', role: 'radiogroup', 'aria-label': 'Statistiques en liste ou en vignettes' }, vList, vTiles)),
        pos,
      ],
      actions: [{ label: 'Tout réinitialiser', onClick: () => { setView(false); set(false); return false; } }, { label: 'Fermer', primary: true }],
    });
  }

  /** Réglage de l'emplacement d'un graphique modifié : on replace les graphiques et on met la mise en page à jour. */
  M.placeCharts = function () {
    placeCharts();
    applyOrder();
    afterLayoutChange();
  };

  /* ---------- ordre des blocs (classements, statistiques, profil d'élévation, puissance selon la durée) ---------- */
  const ORDER_IDS = ['classif', 'stats', 'profile', 'curve'];

  /** Ordre enregistré, complété et nettoyé : une permutation des quatre blocs. */
  function orderOf() {
    const raw = store.state.ui.gameOrder;
    const a = Array.isArray(raw) ? raw.filter((x, i) => ORDER_IDS.includes(x) && raw.indexOf(x) === i) : [];
    for (const id of ORDER_IDS) if (!a.includes(id)) a.push(id);
    return a;
  }
  const blockEl = (id) => (id === 'classif' ? $('#game-classif-sec') : id === 'stats' ? E.stats : id === 'profile' ? $('#bottom') : $('#game-curve-wrap'));
  /** Où le bloc est affiché : « side » (bande latérale : le classement y est toujours) ou « map » (colonne de gauche de la carte). */
  function placeOf(id) {
    const ui = store.state.ui;
    return id === 'classif' || (id === 'stats' && ui.gameStatsSide) || (id === 'profile' && ui.gameProfileSide) || (id === 'curve' && ui.gameCurveSide) ? 'side' : 'map';
  }
  /** Pose l'ordre choisi (propriété order de chaque bloc : valable dans la bande comme dans la colonne de la carte). */
  function applyOrder() {
    orderOf().forEach((id, i) => { const el = blockEl(id); if (el) el.style.order = String(i); });
  }
  /** Le bloc voisin, dans le même emplacement, avant (dir −1) ou après (dir +1) celui-ci ; null s'il n'y en a pas. */
  function neighbour(id, dir) {
    const o = orderOf(), here = placeOf(id);
    for (let j = o.indexOf(id) + dir; j >= 0 && j < o.length; j += dir) if (placeOf(o[j]) === here) return o[j];
    return null;
  }
  M.canMove = (id, dir) => neighbour(id, dir) !== null;
  /** Monte (dir −1) ou descend (dir +1) un bloc d'un cran parmi ceux du même emplacement. Vrai s'il a bougé. */
  M.moveBlock = function (id, dir) {
    const other = neighbour(id, dir);
    if (!other) return false;
    const o = orderOf(), i = o.indexOf(id), j = o.indexOf(other);
    [o[i], o[j]] = [o[j], o[i]];
    store.set('ui.gameOrder', o, true);
    applyOrder();
    afterLayoutChange();
    return true;
  };
  /** Ligne « Position » (Monter / Descendre) d'une fenêtre de configuration ; les boutons se grisent quand le bloc est déjà en haut ou en bas. */
  M.positionRow = function (id) {
    const up = h('button', { type: 'button', onclick: () => { M.moveBlock(id, -1); refreshRow(); } }, '▲ Monter');
    const down = h('button', { type: 'button', onclick: () => { M.moveBlock(id, 1); refreshRow(); } }, '▼ Descendre');
    const refreshRow = () => { up.disabled = !M.canMove(id, -1); down.disabled = !M.canMove(id, 1); };
    refreshRow();
    const row = h('div', { class: 'cc-place' }, h('span', { class: 'cc-label' }, 'Position'), h('div', { class: 'seg-control', role: 'group', 'aria-label': 'Place du bloc parmi les autres' }, up, down));
    row.refresh = refreshRow; // à rappeler quand l'emplacement du bloc change (carte / bande latérale) : ses voisins possibles changent
    return row;
  };

  /** Fenêtre de réglage des classements (double clic sur leur titre) : leur place parmi les autres blocs. */
  function openClassifConfig() {
    D.modal({
      title: 'Configuration — Classements',
      body: [
        h('p', { class: 'hint' }, 'En mode jeu sur grand écran, la bande latérale affiche les classements, et, selon leur réglage, les statistiques, le profil d\'élévation et la puissance selon la durée. Monte ou descends ce bloc pour le placer au-dessus ou en dessous des autres. Le réglage est enregistré.'),
        M.positionRow('classif'),
      ],
      actions: [{ label: 'Fermer', primary: true }],
    });
  }

  /* ---------- entrée / sortie du mode course ---------- */
  function mount() {
    park($('#hud-banner'), E.chips);
    park($('.hud-chips'), E.chips);
    E.chips.prepend($('#hud-banner'));
    park($('#hud-fuel-actions'), E.fuel);
    if (mode === 'phone') { // grand écran : le profil reste sous la carte et le classement dans le panneau de droite
      park($('#game-chart'), E.profSlot);
      park($('#game-legend'), E.profSlot);
      park($('#game-classif'), E.rankSlot);
      park($('#board-all'), E.shRight); // « Résumé / Tous » en haut du bloc, en face du titre « Classement »
    } else { // grand écran : les deux profils passent sur la carte (qui garde toute la hauteur) ou dans le panneau de droite, selon leur réglage
      placeCharts();
    }
    E.rm.hidden = false;
    E.panel.hidden = false;
    arrangeReserves();
    (mode === 'wide' ? E.rm : E.panel).append(E.acts); // grand écran : colonne à gauche de la carte
    // grand écran : « Attaque / Sprint » est un bouton à part, à droite de la barre de puissance ; sinon il est avec les autres actions
    if (mode === 'wide') E.dockRow.append(E.m_sprint); else E.acts.insertBefore(E.m_sprint, E.acts.children[1] || null);
    // « Poches / Bidons » : à gauche de la barre de puissance (grand écran), ou en touchant le bloc des réserves, sans bouton (téléphone)
    if (mode === 'wide') E.dockRow.prepend(E.pocketsBtn); else E.pocketsBtn.remove(); // téléphone : pas de bouton, on ouvre les poches en touchant le bloc des réserves
    E.pocketsBtn.title = 'Poches / Bidons : choisis ce que tu bois et ce que tu manges' + (mode === 'phone' ? '' : ' (touches M et B : choix automatique)');
    // « Passer le relais » et la durée d'un relais : sous « Relais » dans la colonne d'actions (grand écran), sous la rangée d'actions (téléphone)
    if (mode === 'wide') E.acts.insertBefore(E.relaySub, E.m_relay.nextSibling); else E.panel.append(E.relaySub);
    if (mode === 'wide') E.acts.insertBefore(E.followSub, E.m_follow.nextSibling); else E.panel.append(E.followSub);
    E.m_sprint.classList.toggle('rm-sprint-big', mode === 'wide');
    E.sprLabel.textContent = mode === 'wide' ? 'Attaque / Sprint' : 'Sprint';
    E.acts.classList.toggle('rm-actcol', mode === 'wide');
    document.body.dataset.race = mode;
    sheetTab = null;
    applySheet();
    window.scrollTo(0, 0);
    if (!ro && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => layout());
      for (const el of [$('.map-wrap'), E.hud, E.chips, E.side, E.views, E.reserves, E.dock, E.panel, E.acts, E.m_sprint, E.charts, E.bar]) ro.observe(el);
    }
    afterLayoutChange();
  }

  function unmount() {
    unpark();
    E.charts.prepend(E.stats); // le bloc de statistiques revient dans la colonne de gauche (il n'a pas d'emplacement d'origine ailleurs)
    E.pocketsBtn.remove();
    setPockets(false);
    E.rm.hidden = true;
    E.panel.hidden = true;
    delete document.body.dataset.race;
    PYR.map.followOffset = null;
    $('.map-wrap').style.removeProperty('--rm-dock-h');
    $('.map-wrap').style.removeProperty('--rm-zoomtop');
    $('.map-wrap').style.removeProperty('--rm-top');
    $('.map-wrap').style.removeProperty('--rm-rtop');
    $('.map-wrap').style.removeProperty('--rm-ltop');
    $('.map-wrap').style.removeProperty('--rm-ctop');
    if (ro) { ro.disconnect(); ro = null; }
    afterLayoutChange();
  }

  /** La carte et le profil changent de taille avec la mise en page. */
  function afterLayoutChange() {
    setTimeout(() => {
      PYR.map.map.invalidateSize();
      if (G && G.chart) G.chart.surface.request();
      layout();
      refresh();
    }, 60);
  }

  /**
   * Répartit les réserves : une seule carte (réserves et « Tenable ») dans les deux cas. Sur grand écran, deux colonnes de lignes
   * (glycogène et hydratation, puis W′ et Record), et Manger / Boire rejoignent les autres actions dans la colonne de droite ; sur
   * téléphone, W′, glycogène, hydratation, Record, avec Manger / Boire au-dessus de la carte.
   */
  function arrangeReserves() {
    const [w, g, hy, rec] = E.rows.map((r) => r.el);
    if (mode === 'wide') {
      E.barsA.append(g, hy, E.tteBox, w, rec); // « Tenable » au milieu : glycogène et hydratation à gauche, W′ et Record à droite
      E.reserves.append(E.res, E.pop); // sous l'entête ; le détail s'ouvre vers le bas
      E.rm.append(E.pockets);
      E.acts.append(E.fuel);
    } else {
      E.barsA.append(w, g, hy, rec);
      E.res.append(E.tteBox); // « Tenable » à droite des lignes
      // sous la feuille : poches (elles s’ouvrent sur la carte, juste au-dessus des réserves, comme les détails), détail, Ravito, réserves ;
      // un seul append, car après le grand écran le détail et les poches ne sont plus dans ce bloc
      E.bottom.append(E.pockets, E.pop, E.fuel, E.res);
    }
  }

  /**
   * Recalcule l'écran voulu. Onglet Mode jeu avec une partie prête, du décompte jusqu'à « Quitter » (M.enter / M.leave) : plein écran
   * sur téléphone, colonne de la carte sur grand écran. Avant, la page de réglages s'affiche seule.
   */
  M.sync = function () {
    const ready = store.state.ui.tab === 'game' && !!G && G.ready;
    const phone = !!(mq && mq.matches);
    const want = !ready || !inRace ? null : phone ? 'phone' : 'wide';
    if (want === mode) { if (mode) layout(); return; }
    if (mode) unmount();
    mode = want;
    if (mode) mount();
    if (PYR.view3d) PYR.view3d.setStage(!!mode); // la vue 3D ne recouvre la carte que sur la page de jeu
    TG.applyFollowLimits(); // le relais est libre (sans durée ni limites) sur téléphone
    // téléphone : le profil d’élévation n’a ni boutons ni déplacement, seulement le zoom à deux doigts, centré sur le coureur
    if (G && G.chart) G.chart.zoom.setLock(mode === 'phone', 0.5);
  };

  /** Page de jeu : décompte, course, arrivée (plein écran sur téléphone). */
  M.enter = function () {
    inRace = true;
    M.sync();
    refresh();
  };

  /** Retour à la page de réglages (Quitter, nouvelle partie, changement d'onglet). */
  M.leave = function () {
    inRace = false;
    M.sync();
  };

  /** Arrivée : le classement s'ouvre, avec Rejouer et Quitter. */
  M.finished = function () {
    if (mode === 'phone') openSheet('rank');
  };

  M.active = () => mode !== null;
  M.isPhone = () => mode === 'phone';

  /** Décale le point suivi par la caméra pour que le cycliste reste dans la zone libre entre le HUD et les réserves. */
  function layout() {
    if (!mode) return;
    fitZoneLabels();
    const wr = $('.map-wrap').getBoundingClientRect();
    if (!wr.height || !wr.width) return;
    let top = E.hud.getBoundingClientRect().bottom - wr.top + 8;
    // grand écran : sous l'entête, une rangée (boutons, réserves, boutons), puis les alertes au centre juste dessous
    let rowBottom = 0;
    if (mode === 'wide') {
      const rv = E.reserves.getBoundingClientRect();
      rowBottom = Math.max(E.views.getBoundingClientRect().bottom, E.side.getBoundingClientRect().bottom, rv.height ? rv.bottom : 0) - wr.top + 8;
      if (rv.height) top = Math.max(top, rv.bottom - wr.top + 8);
      $('.map-wrap').style.setProperty('--rm-ctop', Math.round(rv.height ? rv.bottom - wr.top + 8 : top) + 'px');
    }
    if (E.chips.children.length && !E.chips.hidden) {
      const c = E.chips.getBoundingClientRect();
      if (c.height) top = Math.max(top, c.bottom - wr.top + 4);
    }
    const dockTop = E.dock.getBoundingClientRect().top;
    const bottom = wr.bottom - dockTop + 8;
    // grand écran : la colonne de gauche commence sous le HUD et s'arrête au-dessus des réserves
    $('.map-wrap').style.setProperty('--rm-top', Math.round(E.hud.getBoundingClientRect().bottom - wr.top + 8) + 'px');
    $('.map-wrap').style.setProperty('--rm-dock-h', Math.max(0, wr.bottom - dockTop) + 'px'); // l'attribution de la carte passe au-dessus
    // grand écran : la colonne de gauche (statistiques, profil, puissance selon la durée) et la colonne d'actions à droite décalent aussi le point suivi
    let left = 0;
    if (mode === 'wide') {
      for (const c of [...E.charts.children, E.views]) {
        const r = c.getBoundingClientRect();
        if (r.width && r.height) left = Math.max(left, r.right - wr.left + 8);
      }
      // le zoom de la carte (+ / −) se place à droite, juste sous le bouton des fonds de carte ; les actions de la colonne de droite
      // (centrées) commencent sous lui, la colonne de gauche (statistiques, graphiques) sous sa rangée de boutons
      const zoomEl = document.querySelector('.leaflet-control-zoom');
      const zoomTop = E.side.getBoundingClientRect().bottom - wr.top + 6;
      const zoomBottom = zoomTop + (zoomEl ? zoomEl.getBoundingClientRect().height : 0);
      $('.map-wrap').style.setProperty('--rm-zoomtop', Math.round(zoomTop) + 'px');
      $('.map-wrap').style.setProperty('--rm-ltop', Math.round(rowBottom) + 'px');
      $('.map-wrap').style.setProperty('--rm-rtop', Math.round(Math.max(rowBottom, zoomBottom + 8)) + 'px');
    }
    const sd = E.side.hidden ? null : E.side.getBoundingClientRect();
    let right = sd && sd.width ? wr.right - sd.left + 8 : 0;
    if (E.acts.classList.contains('rm-actcol')) { const ar = E.acts.getBoundingClientRect(); if (ar.width) right = Math.max(right, wr.right - ar.left + 8); }
    // téléphone en paysage : la barre de puissance occupe une colonne à droite de la carte
    const pr = E.panel.getBoundingClientRect();
    if (pr.width && pr.left > wr.left + wr.width * 0.4) right = Math.max(right, wr.right - pr.left + 8);
    PYR.map.followOffset = { x: (left - right) / 2, y: (top - bottom) / 2 };
    // téléphone : hauteur maximale des poches, ouvertes sur la carte entre le bandeau du haut et les réserves
    $('.map-wrap').style.setProperty('--rm-pk-max', Math.max(120, Math.round(E.bottom.getBoundingClientRect().top - wr.top - (E.hud.getBoundingClientRect().bottom - wr.top) - 16)) + 'px');
  }

  /* ---------- affichage ---------- */
  const fmt = (x, d) => U.fmt(x, d);
  const level = (f) => (f > 0.5 ? 'var(--good)' : f > 0.2 ? 'var(--warning)' : f > 0.05 ? 'var(--serious)' : 'var(--critical)');

  function setRow(r, f, color, text) {
    r.fill.style.width = (U.clamp(f, 0, 1) * 100).toFixed(1) + '%';
    r.fill.style.background = color;
    r.val.textContent = text;
  }

  /**
   * Bandes de durée tenable sur la barre : la bande où se trouve une puissance dit combien de temps on peut encore la tenir.
   * Rien tant qu'on peut la tenir plus de 20 min ; puis, par niveaux de transparence croissants, jaune (20 min : de la puissance
   * tenable 20 min à celle tenable 5 min), orange (5 min), rouge (1 min), gris (15 s), et le gris foncé hachuré au-delà de la limite
   * d'une seconde (voir E.lock) : la restriction automatique de puissance.
   */
  /** Suffixe du dénivelé positif, par profil (D+ restant). */
  const dplusCache = new WeakMap();
  function dplusLeft(p, s) {
    let a = dplusCache.get(p);
    if (!a) {
      a = new Float64Array(p.n);
      for (let i = p.n - 2; i >= 0; i--) a[i] = a[i + 1] + Math.max(0, p.ele[i + 1] - p.ele[i]);
      dplusCache.set(p, a);
    }
    return a[U.clamp(Math.round(s / p.step), 0, p.n - 1)];
  }

  function eleAt(p, s) {
    const x = U.clamp(s / p.step, 0, p.n - 1), i = Math.min(p.n - 2, Math.floor(x));
    return p.ele[i] + (p.ele[i + 1] - p.ele[i]) * (x - i);
  }

  /** Vitesse ascensionnelle (m/h) : altitude gagnée sur les 30 dernières secondes de course ; le tampon repart de zéro quand le temps recule (nouvelle partie). */
  const VAM_WINDOW = 30;
  let vamBuf = [];
  function vam(t, ele) {
    if (vamBuf.length && t < vamBuf[vamBuf.length - 1].t) vamBuf = [];
    vamBuf.push({ t, e: ele });
    while (vamBuf.length > 2 && vamBuf[1].t <= t - VAM_WINDOW) vamBuf.shift();
    const a = vamBuf[0];
    if (t - a.t < 5) return '–';
    const v = (ele - a.e) / (t - a.t) * 3600;
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), 0)} m/h`;
  }

  function updateHeat(s, pos) {
    const stops = [];
    let prev = 0;
    for (const x of HEAT) {
      const f = s.fwd.find((y) => y.tau === x.tau);
      if (!f) continue;
      prev = Math.max(prev, Math.min(f.P, s.cap)); // les puissances tenables croissent quand la durée diminue
      stops.push({ x, p: prev });
    }
    // la bande i va de la puissance tenable pendant sa durée à celle de la durée suivante (la dernière va jusqu'à la limite d'une seconde)
    const w = E.bar.clientWidth || 1, pcX = PB.powerToPos(s.cp, edges) * w;
    let lastX = -1e9;
    const info = [];
    E.heatBands.forEach((band, i) => {
      const q = stops[i + 1], next = stops[i + 2];
      const lo = q ? q.p : s.max, hi = next ? next.p : s.cap;
      const inside = !!q && lo < s.max - 1;
      const lab = E.heatLabs[i];
      // repère sous la barre pour chaque durée (20 min, 5 min, 1 min, 15 s), sans chevauchement ni masquer « PC »
      const x = PB.powerToPos(lo, edges) * w;
      const show = inside && x - lastX >= 30 && Math.abs(x - pcX) >= 26;
      lab.hidden = !show;
      if (show) { lab.style.left = pos(lo); lastX = x; }
      if (inside) info.push(`${q.x.label} au-dessus de ${fmt(lo, 0)} W`);
      // bande hachurée : seulement pour 1 min (rouge) et 15 s (violet) ; jaune et orange n'ont que leur repère
      const on = inside && q.x.band !== false && hi > lo + 0.5;
      band.hidden = !on;
      if (!on) return;
      const x0 = PB.powerToPos(lo, edges), x1 = PB.powerToPos(Math.min(hi, s.max), edges);
      band.style.left = (x0 * 100) + '%';
      band.style.width = ((x1 - x0) * 100) + '%';
    });
    if (!info.length && !(s.cap < s.max - 1)) { E.bar.removeAttribute('title'); return; }
    E.bar.title = 'Durée pendant laquelle tu peux encore tenir une puissance : ' + info.join(' · ')
      + (s.cap < s.max - 1 ? ` · au-delà de ${fmt(s.cap, 0)} W : indisponible (restriction automatique)` : '');
  }

  function updateBar(s) {
    const key = Math.round(s.ftp) + '|' + s.max;
    if (key !== edgesKey) { edgesKey = key; edges = PB.zoneEdges(s.ftp, s.max); }
    const pos = (p) => (PB.powerToPos(p, edges) * 100) + '%';
    E.cursor.style.left = pos(s.shown);
    E.tickPC.style.left = E.labPC.style.left = pos(s.cp);
    E.tickMax.style.left = pos(s.cap);
    // grisé foncé : au-dessus de la limite d'une seconde (indisponible maintenant) ; grisé clair : au-dessus de ce que le cycliste
    // peut tenir une minute (la limite d'une seconde ne montre pas le contre-effort qui suit un effort à la limite de la courbe record)
    const limited = s.cap < s.max - 1;
    E.lock.hidden = !limited;
    if (limited) E.lock.style.left = pos(Math.max(0, s.cap));
    updateHeat(s, pos);
    const zi = PB.zoneIndex(s.shown, edges), sprint = s.mode === 'sprint' || s.mode === 'attack';
    E.zones.forEach((z, j) => {
      z.classList.toggle('on', j === zi && !sprint);
      const P = zonePower(j);
      z.title = P === null ? PB.LABELS[j] : `Z${j + 1} - ${PB.LABELS[j]} : ${P} W`;
    });
    E.cursor.classList.toggle('hot', sprint);
    const lead = s.mode === 'auto' ? 'Pilote automatique' : s.mode === 'manual' ? PB.LABELS[zi] : Tac.LABELS[s.mode] || PB.LABELS[zi];
    E.zl.textContent = `${lead} · ${fmt(s.shown, 0)} W`;
    E.bar.setAttribute('aria-valuemax', String(s.max));
    E.bar.setAttribute('aria-valuenow', String(Math.round(s.shown)));
    E.bar.setAttribute('aria-valuetext', `${PB.LABELS[zi]}, ${Math.round(s.shown)} watts`);
    E.m_sprint.setAttribute('aria-pressed', String(s.boost > 0));
    // home-trainer ou vraie route : la puissance est mesurée, la barre la montre sans la régler, et les tactiques ne servent pas
    const real = !!s.source && s.source !== 'avatar';
    E.bar.classList.toggle('rm-measured', real);
    E.bar.setAttribute('aria-readonly', String(real));
    E.m_sprint.disabled = s.finished || real;
    E.sprFill.style.width = (Math.min(1, s.boost) * 100) + '%';
    // Relais, Suivre et Suivre les attaques s'activent indépendamment les uns des autres
    const lay = s.layers;
    for (const id of ['relay', 'follow', 'cover']) {
      const b = E['m_' + id];
      b.setAttribute('aria-pressed', String(lay[id]));
      b.disabled = s.finished || real;
    }
    E.wAuto.disabled = s.live || real;
    E.wAuto.setAttribute('aria-pressed', String(s.mode === 'auto'));
    // mode relais : « Passer le relais » (quand on mène) et durée d'un relais (fixée en défi et en course en direct)
    // « Suivre les attaques » et les limites W′ / PPR : sous « Suivre », tant qu'on suit (avec ou sans les attaques)
    // téléphone : « Suivre » n’a pas de réglages W′ > ni PPR < (réservés au grand écran)
    E.followSub.hidden = !(lay.follow || lay.cover) || mode === 'phone';
    if (document.activeElement !== E.limW) E.limW.value = String(s.followW);
    if (document.activeElement !== E.limP) E.limP.value = String(s.followPpr);
    if (document.activeElement !== E.relW) E.relW.value = String(s.relayW);
    if (document.activeElement !== E.relP) E.relP.value = String(s.relayPpr);
    // à l'approche d'une limite, son champ clignote en orange (à moins de 10 points) puis en rouge (à moins de 3 points)
    const warnW = (limit) => (limit > 0 ? (s.wf - limit / 100 <= 0.03 ? 2 : s.wf - limit / 100 <= 0.1 ? 1 : 0) : 0);
    const warnP = (limit) => (limit < 100 ? (s.usage.use >= limit / 100 - 0.03 ? 2 : s.usage.use >= limit / 100 - 0.1 ? 1 : 0) : 0);
    const flag = (el, level) => { el.classList.toggle('warn-orange', level === 1); el.classList.toggle('warn-red', level === 2); };
    flag(E.limWBox, warnW(s.followW)); flag(E.limPBox, warnP(s.followPpr));
    flag(E.relWBox, warnW(s.relayW)); flag(E.relPBox, warnP(s.relayPpr));
    // téléphone : le joueur est toujours actif et gère lui-même son effort, il reprend le relais en désactivant « Relayer » puis en le réactivant ;
    // pas de « Passer le relais », ni de durée ni de limite W′ / PPR pour le relais (elles ne servent qu'à « Suivre »)
    E.relaySub.hidden = !lay.relay || mode === 'phone';
    E.passBtn.disabled = !s.pulling || s.finished;
    E.passBtn.title = s.pulling ? 'Tu mènes : te laisser glisser tout de suite pour laisser passer les autres' : 'Disponible quand tu mènes le groupe';
    if (document.activeElement !== E.pullIn) E.pullIn.value = s.pullSec === 0 ? String(PULL_INF) : String(s.pullSec);
    E.pullBox.classList.toggle('is-inf', s.pullSec === 0);
    if (s.pullSec === 0) fitInf();
    E.pullIn.setAttribute('aria-valuetext', s.pullSec === 0 ? 'infini : sans limite de durée' : `${s.pullSec} secondes`);
    E.pullIn.disabled = !!s.pullFixed;
    E.pullIn.title = s.pullFixed ? 'Durée fixée par le défi ou l\'organisateur' : '';
  }

  /* ---------- poches / bidons ---------- */
  const MIX_ORDER = ['water', 'hypo', 'iso', 'hyper'];
  const SLOT_NAMES = ['Bidon 1', 'Bidon 2', 'Bidon 3', 'Camelback'];
  let pocketsKey = '', PK = {};

  function setPockets(open) {
    if (open && mode === 'phone' && sheetTab) closeSheet(); // téléphone : les poches remplacent la feuille ouverte (Profil, Classement, Plus)
    E.pockets.hidden = !open;
    if (open && popKey) { popKey = null; E.pop.hidden = true; }
    E.pocketsBtn.setAttribute('aria-expanded', String(open));
    pocketsKey = '';
    if (open) refresh();
    layout(); // hauteur disponible sous le bandeau du haut
  }

  /** Une ligne de la fenêtre : titre à gauche, éléments à droite. */
  const pkRow = (cls, ...kids) => h('div', { class: 'rm-pkrow ' + cls }, ...kids);
  const pkHead = (txt) => h('h4', { class: 'rm-pkh' }, txt);
  const mixLabel = (id) => Fu.MIXES[id].label;

  /** Construit le contenu de la fenêtre : avant le départ, le matériel se prépare (contenus, aliments) ; ensuite on choisit quoi boire et manger. */
  function buildPockets(edit, f, s) {
    D.clear(E.pockets);
    PK = { cont: [], food: {}, sel: [], num: {}, tot: {} };
    if (edit) {
      E.pockets.append(h('p', { class: 'rm-pknote' }, 'Avant le départ : choisis ce que tu emportes. En course, tu piocheras ici ce que tu bois et ce que tu manges.'));
      E.pockets.append(pkHead('Bidons et camelback'));
      Fu.SLOTS.forEach((type, i) => {
        const sel = h('select', { 'aria-label': SLOT_NAMES[i] + ' : contenu', onchange: () => {
          const slots = PK.sel.map((x) => x.value);
          TG.setKit({ slots }); refresh();
        } },
        h('option', { value: '' }, 'Aucun'), ...MIX_ORDER.map((id) => h('option', { value: id }, mixLabel(id))));
        PK.sel.push(sel);
        E.pockets.append(pkRow('rm-pkcont', h('span', { class: 'rm-pkname' }, `${SLOT_NAMES[i]} · ${fmt(Fu.CONTAINERS[type].cap, 1)} L`), sel));
      });
      for (const cat of ['gel', 'bar']) {
        E.pockets.append(pkHead(cat === 'gel' ? 'Gels' : 'Barres'));
        for (const k of Fu.FOOD_IDS.filter((x) => Fu.FOODS[x].cat === cat)) {
          const food = Fu.FOODS[k];
          const num = h('strong', { class: 'rm-pknum' }, '0');
          const step = (d) => h('button', { type: 'button', class: 'rm-pkstep', 'aria-label': (d > 0 ? 'Ajouter ' : 'Retirer ') + food.name.toLowerCase(),
            onclick: () => { TG.setKit({ items: { [k]: Math.max(0, (PK.kit.items[k] || 0) + d) } }); refresh(); } }, d > 0 ? '+' : '−');
          PK.num[k] = num;
          E.pockets.append(pkRow('rm-pkfood', h('span', { class: 'rm-pkname' }, food.name, h('small', null, ` ${food.carbs} g`)), h('span', { class: 'rm-pkstepper' }, step(-1), num, step(1))));
        }
        PK.tot[cat] = h('p', { class: 'rm-pknote' });
        E.pockets.append(PK.tot[cat]);
      }
      return;
    }
    E.pockets.append(pkHead('Bidons et camelback'));
    if (!f.containers.length) E.pockets.append(h('p', { class: 'rm-pknote' }, 'Aucun contenant emporté.'));
    let bottleNo = 0;
    f.containers.forEach((c) => {
      const fill = h('i'), txt = h('span', { class: 'rm-pkvol' });
      const btn = h('button', { type: 'button', class: 'rm-pkbtn', onclick: () => { TG.drink(c.i); refresh(); } }, 'Boire');
      PK.cont[c.i] = { fill, txt, btn };
      const name = c.type === 'camelback' ? 'Camelback' : `Bidon ${++bottleNo}`;
      E.pockets.append(pkRow('rm-pkcont', h('span', { class: 'rm-pkname' }, `${name} · ${mixLabel(c.mix)}`, h('span', { class: 'rm-pkbar' }, fill)), txt, btn));
    });
    for (const cat of ['gel', 'bar']) {
      const ids = Fu.FOOD_IDS.filter((x) => Fu.FOODS[x].cat === cat && f.stock[x] > 0);
      E.pockets.append(pkHead(cat === 'gel' ? 'Gels' : 'Barres'));
      if (!ids.length) E.pockets.append(h('p', { class: 'rm-pknote' }, cat === 'gel' ? 'Plus de gel.' : 'Plus de barre.'));
      for (const k of ids) {
        const food = Fu.FOODS[k], n = h('strong', { class: 'rm-pknum' }, '0');
        const btn = h('button', { type: 'button', class: 'rm-pkbtn', onclick: () => { TG.eat(k); refresh(); } }, 'Manger');
        PK.food[k] = { n, btn };
        E.pockets.append(pkRow('rm-pkfood', h('span', { class: 'rm-pkname' }, food.name, h('small', null, ` ${food.carbs} g`)), n, btn));
      }
    }
    PK.hint = h('p', { class: 'rm-pknote' });
    E.pockets.append(PK.hint);
  }

  /** Met à jour ce qui change (volumes, stocks, délais) sans reconstruire la fenêtre. */
  function updatePockets(edit, f, s) {
    if (edit) {
      PK.kit = s.kit;
      s.kit.slots.forEach((v, i) => { if (document.activeElement !== PK.sel[i]) PK.sel[i].value = v; });
      for (const k of Fu.FOOD_IDS) PK.num[k].textContent = String(s.kit.items[k] || 0);
      for (const cat of ['gel', 'bar']) {
        const n = Fu.FOOD_IDS.reduce((a, k) => a + (Fu.FOODS[k].cat === cat ? s.kit.items[k] || 0 : 0), 0);
        PK.tot[cat].textContent = `${n} / ${Fu.POCKETS[cat]} dans les poches`;
      }
      return;
    }
    for (const c of f.containers) {
      const r = PK.cont[c.i];
      if (!r) continue;
      r.fill.style.width = `${Math.max(0, Math.min(1, c.vol / c.cap)) * 100}%`;
      r.txt.textContent = `${fmt(c.vol, 2)} L`;
      r.btn.disabled = c.vol < 0.001 || f.drinkIn > 0 || s.finished;
      r.btn.textContent = f.drinkIn > 0 && c.vol >= 0.001 ? `${Math.ceil(f.drinkIn)} s` : 'Boire';
    }
    for (const k of Object.keys(PK.food)) {
      PK.food[k].n.textContent = `×${f.stock[k]}`;
      PK.food[k].btn.disabled = f.eatIn > 0 || s.finished;
      PK.food[k].btn.textContent = f.eatIn > 0 ? `${Math.ceil(f.eatIn)} s` : 'Manger';
    }
    // pas de clavier sur téléphone : pas de rappel des touches M et B
    PK.hint.hidden = mode === 'phone';
    PK.hint.textContent = mode === 'phone' ? '' : 'Touches M (manger) et B (boire) : choix automatique.';
  }

  /** Bouton « Poches / Bidons » et fenêtre, mis à jour à chaque rafraîchissement (la fenêtre seulement quand elle est ouverte). */
  function renderPockets(s) {
    const f = s.fuel;
    E.pocketsBtn.hidden = !f;
    if (!f) { if (!E.pockets.hidden) setPockets(false); return; }
    E.pocketsSub.textContent = ` ${f.gels + f.bars} · ${fmt(f.fluid, 2)} L`;
    if (E.pockets.hidden) return;
    const edit = !s.started;
    const key = edit ? 'edit' : 'play|' + f.containers.map((c) => c.type + c.mix).join(',') + '|' + Fu.FOOD_IDS.filter((k) => f.stock[k] > 0).join(',');
    if (key !== pocketsKey) { pocketsKey = key; buildPockets(edit, f, s); }
    updatePockets(edit, f, s);
  }

  /**
   * Cale le symbole ∞ du champ « Durée » sur la boîte exacte qu'occuperait le texte « 300 » : à droite des chiffres, il s'arrête où
   * s'arrête leur texte (avant les petites flèches du navigateur, dont la largeur est fixée en CSS) ; sa largeur est celle de « 300 » dans la
   * police du champ et sa hauteur celle des chiffres, centrés comme le texte l'est dans le champ. Mesure refaite seulement si le champ change.
   */
  let infKey = '';
  const infCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  function fitInf() {
    const inp = E.pullIn, box = E.pullInf;
    if (!inp || !inp.offsetParent || !infCtx) return;
    const svg = box.firstChild, cs = getComputedStyle(inp);
    if (!svg.dataset.fit) { // le viewBox colle au tracé (épaisseur du trait comprise) : le dessin remplit toute la boîte
      const bb = svg.firstChild.getBBox(), sw = 2.2;
      if (bb.width > 0) { svg.setAttribute('viewBox', `${bb.x - sw / 2} ${bb.y - sw / 2} ${bb.width + sw} ${bb.height + sw}`); svg.dataset.fit = '1'; }
    }
    const key = `${inp.offsetWidth}|${inp.offsetHeight}|${cs.font}`;
    if (key === infKey) return;
    infKey = key;
    infCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = infCtx.measureText('300');
    const px = (v) => parseFloat(v) || 0;
    const top0 = px(cs.borderTopWidth) + px(cs.paddingTop);
    const contentH = inp.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
    // la ligne de texte (hauteur de ligne L) est centrée dans le champ ; dans la ligne, le navigateur répartit l'interligne autour du texte
    // en arrondissant à l'entier inférieur la part au-dessus (ce qui remonte le texte d'un demi-pixel de plus en plus d'un pixel)
    const lineH = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    const L = /px$/.test(cs.lineHeight) ? parseFloat(cs.lineHeight) : lineH;
    const baseline = top0 + (contentH - L) / 2 + m.fontBoundingBoxAscent + Math.floor((L - lineH) / 2);
    const right = inp.offsetWidth - px(cs.borderRightWidth) - px(cs.paddingRight) - SPIN_W; // aligné à droite, avant les flèches
    const top = baseline - m.actualBoundingBoxAscent, bottom = baseline + m.actualBoundingBoxDescent;
    Object.assign(box.style, { left: `${right - m.width}px`, top: `${top}px`, width: `${m.width}px`, height: `${bottom - top}px` });
  }

  /** « Passer le relais » : le joueur qui mène se laisse glisser tout de suite. */
  function passRelay() {
    TG.passRelay();
    refresh();
  }

  function update(s) {
    if (!mode || !s) return;
    renderPockets(s);
    E.v.textContent = fmt(s.v, 1);
    E.p.textContent = fmt(s.p, 0);
    E.p.classList.toggle('cap', s.capped);
    E.pu.textContent = s.capped ? 'W limitée' : 'W';
    E.sl.textContent = fmt(s.grade, 1);
    // vent relatif et fréquence cardiaque simulée
    const w = s.wind;
    E.wdVal.textContent = w ? fmt(w.kmh, 0) : '–';
    E.wdArrow.style.visibility = w && w.kmh >= 0.5 ? '' : 'hidden';
    if (w) E.wdArrow.style.transform = `rotate(${w.rot.toFixed(0)}deg)`;
    E.wd.parentElement.title = w
      ? `Vent : ${fmt(w.kmh, 0)} km/h, ${w.head >= 0 ? 'de face' : 'dans le dos'} ${fmt(Math.abs(w.head), 0)} km/h, de ${w.side >= 0 ? 'droite' : 'gauche'} ${fmt(Math.abs(w.side), 0)} km/h ; vent apparent ${fmt(w.app, 0)} km/h. La flèche montre où le vent souffle, par rapport à ta route (en haut = vers l'avant : vent de face, flèche vers le bas).`
      : 'Vent relatif au cycliste (flèche : où il souffle, par rapport à ta route)';
    E.fcBox.hidden = !s.hr;
    if (s.hr) { E.fc.textContent = fmt(s.hr.HR, 0); E.fcBox.title = 'Fréquence cardiaque simulée par le modèle physiologique (réserve de VO₂, chaleur, déshydratation)'; }
    // statistiques (colonne de gauche, grand écran)
    // temps, distance et restant : seconde ligne du HUD (grand écran)
    E.tm.textContent = U.fmtClock(s.t);
    E.di.textContent = `${fmt(s.s / 1000, 2)} km`;
    E.re.textContent = `${fmt(s.rest / 1000, 2)} km`;
    E.stat.ed.textContent = `${fmt(s.savedKJ, 0)} kJ`;
    E.stat.va.textContent = `${fmt(s.avgV, 1)} km/h`;
    E.stat.pa.textContent = `${fmt(s.avgP, 0)} W`;
    E.stat.np.textContent = s.np ? `${fmt(s.np, 0)} W` : '–';
    E.stat.wk.textContent = `${fmt(s.workKJ, 0)} kJ`;
    E.stat.sh.textContent = `${fmt(s.shelteredPct, 0)} %`;
    E.stat.wm.textContent = `${fmt(s.wMinKJ, 1)} kJ`;
    E.stat.pm.textContent = `${fmt(s.pMaxW, 0)} W`;
    E.stat.rp.textContent = String(s.pulls);
    E.stat.rp.parentElement.hidden = !s.pulls;
    E.stat.fo.textContent = s.formLabel;
    E.stat.fo.parentElement.hidden = !s.formLabel;
    E.stat.ma.textContent = s.machine;
    E.stat.ma.parentElement.hidden = !s.machine;
    const ph = s.fuel && s.fuel.phys;
    for (const id of PHYS_STATS) E.stat[id].parentElement.hidden = !ph;
    if (ph) {
      E.stat.pc.textContent = `${fmt(ph.CP2e, 0)} W · ${fmt(ph.cpK * 100, 0)} %`;
      E.stat.gy.textContent = `${fmt(ph.gI * 100, 0)} · ${fmt(ph.gII * 100, 0)} · ${fmt(ph.gL * 100, 0)} %`;
      E.stat.gl.textContent = `${fmt(ph.glu, 1)} mmol/L`;
      E.stat.tc.textContent = `${fmt(ph.Tc, 1)} °C`;
      E.stat.hr.textContent = `${fmt(ph.HR, 0)} bpm`;
      E.stat.ox.textContent = `${fmt(ph.fat, 0)} · ${fmt(ph.cho, 0)} g/h`;
      E.stat.sw.textContent = `${fmt(ph.SR, 1)} L/h · ${fmt(ph.Na, 0)}`;
    }
    E.clock.textContent = U.fmtClock(s.t);
    {
      const p = store.profile;
      if (p) {
        const left = dplusLeft(p, s.s);
        E.stat.dc.textContent = `${fmt(dplusLeft(p, 0) - left, 0)} m`;
        E.stat.dr.textContent = `${fmt(left, 0)} m`;
        E.vam.textContent = vam(s.t, eleAt(p, s.s));
      }
    }

    const hasBoard = !$('#game-classif').hidden;
    E.rank.hidden = !hasBoard;
    E.rankTxt.textContent = s.rank ? `${s.rank}/${s.total}` : '–';
    // classements disponibles (étape toujours ; grimpeur et sprinteur quand des côtes ou des sprints sont en jeu) ; « Résumé / Tous » seulement sur l’étape
    {
      const ids = new Set([...document.querySelectorAll('#classif-tabs button')].map((b) => b.dataset.tab));
      E.clsGroup.hidden = ids.size < 2;
      for (const id of ['stage', 'kom', 'points']) {
        E['cls_' + id].hidden = !ids.has(id);
        E['cls_' + id].setAttribute('aria-pressed', String(G.ctab === id || (id === 'stage' && !ids.has(G.ctab))));
      }
      if (mode === 'phone') $('#board-all').style.display = ids.size < 2 || G.ctab === 'stage' || !ids.has(G.ctab) ? '' : 'none';
    }

    // pause, vitesse, quitter
    for (const b of document.querySelectorAll('.rm-pbtn')) {
      b.querySelector('.ic-pause').toggleAttribute('hidden', s.paused);
      b.querySelector('.ic-play').toggleAttribute('hidden', !s.paused);
      b.setAttribute('aria-label', s.paused ? 'Reprendre' : 'Mettre en pause');
      b.disabled = s.live || s.finished || s.source === 'road';
    }
    E.speed.textContent = s.slowed ? '×1' : '×' + s.scale;
    E.speed.classList.toggle('slowed', !!s.slowed);
    E.speed.title = s.slowed ? 'Vitesse ×1 le temps de l\'évènement (réglage : ×' + s.scale + ')' : '';
    E.speed.disabled = s.live || (!!s.source && s.source !== 'avatar');
    if (E.speed.disabled) setSpeedPicker(false);
    for (const b of E.speedOpts.children) b.setAttribute('aria-checked', String(Number(b.dataset.v) === s.scale));
    E.quit.hidden = !(s.paused || s.finished);

    // aspiration ; en bordure (peloton en 2D, vent de côté) : signalé à côté
    E.pd.hidden = !(s.draft >= 1) && !s.edge;
    if (!E.pd.hidden) E.pd.textContent = s.edge ? `bordure${s.draft >= 1 ? ` (−${fmt(s.draft, 0)})` : ''}` : `(−${fmt(s.draft, 0)})`;
    E.pd.classList.toggle('edge', !!s.edge);
    E.pd.title = s.edge ? 'En bordure : contre le bord sous le vent, sans place dans l\'éventail, à peine abrité' : 'Watts que tu n\'as pas à dépenser grâce à l\'aspiration';
    G.snap = s;
    E.compass.setAttribute('aria-pressed', String(!!s.northUp));
    E.compass.title = s.northUp ? 'Nord en haut (cliquer pour que la carte suive l\'orientation du cycliste)' : 'La carte suit l\'orientation du cycliste (cliquer pour mettre le nord en haut)';
    E.zoom.hidden = !s.peloton;
    E.zoom.setAttribute('aria-pressed', String(!!s.closeUp));
    E.tilt.hidden = !(s.peloton && s.tiltable);
    E.tilt.setAttribute('aria-pressed', String(!!s.tilt));

    // réserves
    const [rw, re, rh, rr] = E.rows;
    setRow(rw, s.wf, level(s.wf), detail ? `${fmt(s.wkJ, 1)} kJ` : `${fmt(s.wf * 100, 0)} %`);
    const f = s.fuel;
    re.el.hidden = rh.el.hidden = !f;
    if (f) {
      // modèle physiologique : glycogène des muscles (vert) puis du foie (jaune pâle) ; sinon un seul stock, de la couleur de son niveau
      const sp = f.split;
      setRow(re, sp ? sp.muscle : f.energy, sp ? 'var(--gly-muscle)' : level(f.energy / 0.6), detail && f.gut > 1 ? `+${fmt(f.gut, 0)} g` : `${fmt(f.energy * 100, 0)} %`);
      re.liver.style.width = (U.clamp(sp ? sp.liver : 0, 0, 1) * 100).toFixed(1) + '%';
      // hachuré : glucides avalés, dans l'intestin (vert) puis dans l'estomac (marron)
      re.gut.style.width = (f.gutParts.intestine * 100).toFixed(1) + '%';
      re.stomach.style.width = (f.gutParts.stomach * 100).toFixed(1) + '%';
      re.el.title = s.gutTitle;
      setRow(rh, f.hydration, level((f.hydration - 0.3) / 0.5), detail ? `${fmt(f.fluid, 2)} L` : `${fmt(f.hydration * 100, 0)} %`);
    }
    // part de la courbe de puissance record utilisée (vert < 90 %, puis orange, rouge près de 100 %)
    setRow(rr, s.usage.use, level((1 - s.usage.use) * 5), `${fmt(Math.min(s.usage.use, 9.99) * 100, 0)} %`);
    rr.fill.style.width = (Math.min(1, s.usage.use) * 100).toFixed(1) + '%';
    rr.el.title = `Courbe de puissance record utilisée à ${fmt(s.usage.use * 100, 0)} % sur la fenêtre de ${durText(s.usage.d)}. Toucher pour le détail.`;
    applyTte();
    E.tv.textContent = $('#hud-tte').textContent;
    E.tteBox.title = s.tteTitle;
    E.ts.textContent = $('#hud-tte-sub').textContent;
    const tn = G.tteNow;
    E.tv.style.color = tn === null || tn === undefined ? '' : tn > 1200 ? 'var(--good-text)' : tn > 300 ? 'var(--ink)' : 'var(--critical)';

    updateBar(s);
    if (popKey) renderPop(s);

    if (sheetTab === 'rank') {
      E.noRank.hidden = hasBoard;
      E.rankSlot.hidden = !hasBoard;
    }
    E.fin.hidden = !(s.finished && sheetTab === 'rank');
    E.replay.hidden = s.live;
  }

  /** Option « Afficher la durée tenable (TTE) dans le HUD » : décochée, la vignette « Tenable » et son détail disparaissent. */
  function applyTte() {
    const on = store.state.game.showTte !== false;
    document.body.toggleAttribute('data-hide-tte', !on);
    if (!on && popKey === 'tte') togglePop(null);
  }

  /** Relit l'instantané du jeu (après une action de l'écran, sans attendre le prochain HUD). */
  function refresh() {
    if (mode && TG) update(TG.snapshot());
  }

  M.update = update;
  M.refresh = refresh;
  /** Inclinaison mesurée (°, > 0 à droite) : l'icône du bouton penche avec le téléphone. */
  M.tiltOffset = (deg) => { if (E.tilt) E.tilt.style.setProperty('--tilt', Math.max(-45, Math.min(45, deg)) + 'deg'); };

  M.init = function () {
    TG = PYR.tabGame;
    G = TG.state;
    build();
    applyOrder();
    applyStatsView();
    const ct = $('#game-classif-title');
    ct.classList.add('chart-title-editable');
    ct.title = 'Double-clique pour choisir la place des classements parmi les autres blocs';
    ct.addEventListener('dblclick', (e) => { e.preventDefault(); openClassifConfig(); });
    applyViews();
    applyTte();
    store.on('game', applyTte);
    if (window.matchMedia) {
      mq = window.matchMedia(PHONE);
      const onChange = () => M.sync();
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
    window.addEventListener('resize', () => { if (mode) layout(); });
    // la liste des vitesses se referme au toucher ailleurs ou avec Échap
    document.addEventListener('click', (e) => { if (!E.speedOpts.hidden && !E.speedWrap.contains(e.target)) setSpeedPicker(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !E.speedOpts.hidden) { setSpeedPicker(false); E.speed.focus(); } });
    // la fenêtre « Poches / Bidons » se referme au toucher ailleurs ou avec Échap
    // téléphone : la feuille Profil ou Classement se ferme en touchant le reste de l’écran (sauf à l’arrivée, où elle porte « Rejouer » et « Quitter »)
    document.addEventListener('pointerdown', (e) => { if (mode === 'phone' && sheetTab && !E.fin.offsetParent && !E.sheet.contains(e.target)) closeSheet(); });
    document.addEventListener('pointerdown', (e) => { if (!E.pockets.hidden && !E.pockets.contains(e.target) && !E.pocketsBtn.contains(e.target) && !(mode === 'phone' && E.res.contains(e.target))) setPockets(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !E.pockets.hidden) { setPockets(false); E.pocketsBtn.focus(); } });
  };

  PYR.gameMobile = M;
})(globalThis.PYR = globalThis.PYR || {});
