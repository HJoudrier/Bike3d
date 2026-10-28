/* author : Hugo Joudrier-Faure */
/* PaceYourRide — chargement d'une page de l'application (parcours.html, athlete.html, equipement.html, pacing.html, Jeu/…,
 * Compteur/…) : les scripts, dans l'ordre, depuis la racine du site quelle que soit la profondeur de la page, puis le démarrage
 * (js/app.js, le dernier de la liste). Une seule liste pour toutes les pages ; chacune n'initialise que ce qu'elle affiche.
 * PYR.root : adresse de la racine du site (avec la barre finale). La page appelle ce fichier en fin de corps :
 *   <script src="../js/boot.js"></script>     (depuis Jeu/index.html par exemple)
 * La page d'accueil (index.html) a sa propre liste, plus courte. */
(function () {
  'use strict';

  const SCRIPTS = [
    'vendor/leaflet/leaflet.js',
    // moteur (aussi chargé par les tests Node : tests/helpers.js)
    'js/core/util.js', 'js/engine/physio.js', 'js/engine/benchmarks.js', 'js/engine/physics.js', 'js/engine/weather.js', 'js/engine/course.js',
    'js/engine/sim.js', 'js/engine/optimizer.js', 'js/engine/gradient.js', 'js/engine/draft.js', 'js/engine/peloton.js', 'js/engine/tilt.js',
    'js/engine/metabo.js', 'js/engine/fuel.js', 'js/engine/classif.js', 'js/engine/feed.js', 'js/engine/tactics.js', 'js/engine/power-bar.js',
    'js/engine/slowdown.js', 'js/engine/race.js', 'js/engine/catalog.js', 'js/engine/plan-gpx.js', 'js/engine/plan-workout.js',
    'js/engine/activity.js', 'js/engine/nutrition.js', 'js/engine/ride.js', 'js/engine/ride-mixed.js', 'js/engine/activity-export.js',
    'js/engine/replay.js', 'js/engine/history.js', 'js/engine/nav.js', 'js/engine/presence.js',
    'vendor/qrcode-generator/qrcode.js',
    // état, stockage, échanges
    'js/core/dom.js', 'js/core/avatar.js', 'js/core/codec.js', 'js/core/zip.js', 'js/core/race-data.js', 'js/core/store.js', 'js/core/library.js',
    // interface : chaque page n'initialise que ses parties (js/app.js)
    'js/ui/services.js', 'js/ui/route-model.js', 'js/ui/charts.js', 'js/ui/chart-config.js', 'js/ui/map-poi.js', 'js/ui/map.js',
    'js/ui/classif-view.js', 'js/ui/tab-route.js', 'js/ui/tab-weather.js', 'js/ui/rider-physio.js', 'js/ui/tab-rider.js', 'js/ui/rider-import.js',
    'js/ui/tab-bike.js', 'js/ui/calibration.js', 'js/ui/gear-art.js', 'js/ui/tab-shop.js', 'js/ui/tab-perf.js', 'js/ui/weather-fx.js',
    'js/ui/view3d.js', 'js/ui/game-source.js', 'js/ui/game-setup.js', 'js/ui/tab-game.js', 'js/ui/game-mobile.js', 'js/ui/sensors.js', 'js/ui/tab-ride.js',
    'js/ui/challenges.js', 'js/ui/qr.js', 'js/ui/relay.js', 'js/ui/live.js',
    'js/app.js',
  ];

  const PYR = globalThis.PYR = globalThis.PYR || {};
  PYR.root = new URL('..', document.currentScript.src).href;   // ce fichier est dans js/

  // insérés dynamiquement, les scripts se téléchargent ensemble mais s'exécutent dans l'ordre de la liste (async = false)
  for (const src of SCRIPTS) {
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
