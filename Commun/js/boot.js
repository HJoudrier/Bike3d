/* author : Hugo Joudrier-Faure */
/* PaceYourRide — chargement d'une page des applications : les scripts, dans l'ordre, depuis la racine du site quelle que soit la
 * profondeur de la page, puis le démarrage (Commun/js/app.js, le dernier de la liste).
 * Le site est fait de quatre applications indépendantes qui ne s'échangent leurs données que par Dropbox (Commun/js/core/cloud.js) :
 *   pro       PaceYourRide/   tracé des parcours, athlètes, équipements, pacing optimal (la seule qui écrit la bibliothèque)
 *   jeu2d     Jeu2D/          le jeu sur la carte : choix du parcours et de l'athlète, puis la course
 *   jeu3d     Jeu3D/          le jeu dans l'univers 3D de Bike3D
 *   compteur  Compteur/       le compteur de la vraie sortie
 * La page dit laquelle elle est avec l'attribut data-app de la balise qui charge ce fichier, en fin de corps :
 *   <script src="../Commun/js/boot.js" data-app="jeu2d"></script>
 * PYR.root : adresse de la racine du site (avec la barre finale) ; PYR.appId, PYR.appDir : l'application et son dossier ;
 * PYR.storageNs : préfixe des clés du stockage local de l'application (voir Commun/js/core/store.js). */
(function () {
  'use strict';

  const ENGINE = [
    'Commun/vendor/leaflet/leaflet.js',
    // moteur (aussi chargé par les tests Node : tests/helpers.js)
    'Commun/js/core/util.js', 'Commun/js/engine/physio.js', 'Commun/js/engine/benchmarks.js', 'Commun/js/engine/physics.js', 'Commun/js/engine/weather.js', 'Commun/js/engine/course.js',
    'Commun/js/engine/sim.js', 'Commun/js/engine/optimizer.js', 'Commun/js/engine/gradient.js', 'Commun/js/engine/draft.js', 'Commun/js/engine/peloton.js', 'Commun/js/engine/tilt.js',
    'Commun/js/engine/metabo.js', 'Commun/js/engine/fuel.js', 'Commun/js/engine/classif.js', 'Commun/js/engine/feed.js', 'Commun/js/engine/tactics.js', 'Commun/js/engine/power-bar.js',
    'Commun/js/engine/slowdown.js', 'Commun/js/engine/race.js', 'Commun/js/engine/catalog.js', 'Commun/js/engine/plan-gpx.js', 'Commun/js/engine/plan-workout.js',
    'Commun/js/engine/activity.js', 'Commun/js/engine/nutrition.js', 'Commun/js/engine/ride.js', 'Commun/js/engine/ride-mixed.js', 'Commun/js/engine/activity-export.js',
    'Commun/js/engine/replay.js', 'Commun/js/engine/history.js', 'Commun/js/engine/nav.js', 'Commun/js/engine/presence.js',
    // état, stockage, échanges
    'Commun/js/core/dom.js', 'Commun/js/core/avatar.js', 'Commun/js/core/codec.js', 'Commun/js/core/zip.js', 'Commun/js/core/race-data.js', 'Commun/js/core/store.js',
    'Commun/js/core/library.js', 'Commun/js/core/cloud.js', 'Commun/js/core/lib-cache.js', 'Commun/js/core/route-file.js', 'Commun/js/core/surface-osm.js',
  ];

  // interface commune aux applications : carte, graphiques, météo, capteurs, calcul des entrées de simulation, plan enregistré
  const SHARED_UI = [
    'Commun/js/ui/services.js', 'Commun/js/ui/route-model.js', 'Commun/js/ui/charts.js', 'Commun/js/ui/chart-config.js', 'Commun/js/ui/map-poi.js', 'Commun/js/ui/map.js',
    'Commun/js/ui/classif-view.js', 'Commun/js/ui/tab-weather.js', 'Commun/js/ui/weather-fx.js', 'Commun/js/ui/sensors.js', 'Commun/js/ui/gear-art.js',
    'Commun/js/ui/sim-inputs.js', 'Commun/js/ui/plan-link.js', 'Commun/js/ui/route-thumb.js', 'Commun/js/ui/lib-pick.js',
  ];

  // interface commune aux deux jeux (carte 2D, 3D) : la page de choix et l'écran de course
  const GAME_UI = [
    'Commun/vendor/qrcode-generator/qrcode.js',
    'Commun/js/jeu/view3d.js', 'Commun/js/jeu/game-source.js', 'Commun/js/jeu/gear-edit.js', 'Commun/js/jeu/game-setup.js', 'Commun/js/jeu/tab-game.js', 'Commun/js/jeu/game-mobile.js',
    'Commun/js/jeu/challenges.js', 'Commun/js/jeu/qr.js', 'Commun/js/jeu/relay.js', 'Commun/js/jeu/live.js',
  ];

  const APPS = {
    pro: {
      dir: 'PaceYourRide', ns: 'paceyourride',
      scripts: ENGINE.concat(SHARED_UI, [
        'PaceYourRide/js/route3d.js', 'PaceYourRide/js/tab-route.js', 'PaceYourRide/js/rider-physio.js', 'PaceYourRide/js/tab-rider.js', 'PaceYourRide/js/rider-import.js', 'PaceYourRide/js/tab-bike.js',
        'PaceYourRide/js/calibration.js', 'PaceYourRide/js/tab-shop.js', 'PaceYourRide/js/tab-perf.js']),
    },
    jeu2d: { dir: 'Jeu2D', ns: 'paceyourride.jeu2d', scripts: ENGINE.concat(SHARED_UI, GAME_UI) },
    jeu3d: { dir: 'Jeu3D', ns: 'paceyourride.jeu3d', scripts: ENGINE.concat(SHARED_UI, GAME_UI) },
    compteur: { dir: 'Compteur', ns: 'paceyourride.compteur', scripts: ENGINE.concat(SHARED_UI, ['Commun/js/jeu/challenges.js', 'Compteur/js/tab-ride.js']) },
    // accueil de PaceYourRide : le projet en cours et la bibliothèque (pas de Commun/js/app.js)
    'pro-home': {
      dir: 'PaceYourRide', ns: 'paceyourride', light: true,
      scripts: ['Commun/vendor/leaflet/leaflet.js', 'Commun/js/core/util.js', 'Commun/js/engine/physics.js', 'Commun/js/engine/classif.js', 'Commun/js/engine/physio.js', 'Commun/js/engine/benchmarks.js',
        'Commun/js/engine/catalog.js', 'Commun/js/core/dom.js', 'Commun/js/core/avatar.js', 'Commun/js/core/library.js', 'Commun/js/core/cloud.js', 'Commun/js/core/lib-cache.js', 'Commun/js/core/route-file.js', 'Commun/js/ui/services.js', 'Commun/js/ui/route-thumb.js', 'Commun/js/ui/lib-pick.js', 'PaceYourRide/js/route-preview.js', 'PaceYourRide/js/home.js'],
    },
    // le portail (racine) : retour de Dropbox et liens vers les applications
    portail: { dir: '', ns: 'paceyourride', light: true,
      scripts: ['Commun/js/core/util.js', 'Commun/js/engine/physics.js', 'Commun/js/core/dom.js', 'Commun/js/core/library.js', 'Commun/js/core/cloud.js', 'Commun/js/portail.js'] },
  };

  const self = document.currentScript;
  const app = APPS[self.dataset.app] || APPS.pro;
  const PYR = globalThis.PYR = globalThis.PYR || {};
  PYR.root = new URL('../..', self.src).href;   // ce fichier est dans Commun/js/
  PYR.appId = self.dataset.app in APPS ? self.dataset.app : 'pro';
  PYR.appDir = app.dir;
  PYR.storageNs = app.ns;

  const list = app.light ? app.scripts : app.scripts.concat(['Commun/js/app.js']);

  // insérés dynamiquement, les scripts se téléchargent ensemble mais s'exécutent dans l'ordre de la liste (async = false)
  for (const src of list) {
    const el = document.createElement('script');
    el.src = PYR.root + src;
    el.async = false;
    el.onerror = () => {
      const msg = `Impossible de charger ${src} : la page doit être servie depuis la racine du site (python3 -m http.server).`;
      console.error(msg);
      const box = document.getElementById('toasts');
      if (box) { const t = document.createElement('div'); t.className = 'toast error'; t.textContent = msg; box.appendChild(t); }
    };
    document.body.appendChild(el);
  }
})();
