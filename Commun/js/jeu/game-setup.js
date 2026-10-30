/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Jeu (Jeu/index.html) : la configuration de la partie. Les réglages sont liés à l'état (data-bind, js/app.js) et
 * enregistrés avec le projet ; on choisit ensuite l'écran de course, la carte (Jeu2D) ou l'univers 3D de Bike3D (Jeu3D), où la
 * partie se joue : « Démarrer » l'ouvre et lance le départ ; une course en direct s'y crée ou s'y rejoint (la connexion avec les autres
 * joueurs, comme celle du home-trainer ou du GPS, vit sur l'écran de course). */
(function (PYR) {
  'use strict';

  const D = PYR.dom, store = PYR.store;
  const { $, $$ } = D;

  const NOTES = {
    '2d': 'La course sur la carte : le tracé, les coureurs, les manches à air, et le profil sous la carte.',
    '3d': 'La course dans le paysage cartoon de Bike3D, généré autour de ton parcours : revêtements, météo réelle, ton vélo du magasin. Il faut un navigateur avec WebGL ; la carte reste disponible.',
  };

  const display = () => (store.state.game.display === '3d' ? '3d' : '2d');
  const racePage = () => (display() === '3d' ? 'race3d' : 'race2d');

  function render() {
    const d = display();
    $$('[data-display-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.displayChoice === d)));
    const note = $('#g-display-note');
    if (note) note.textContent = NOTES[d];
  }

  const S = {
    init() {
      $$('[data-display-choice]').forEach((b) => b.addEventListener('click', () => { store.set('game.display', b.dataset.displayChoice); render(); }));
      $('#g-go').addEventListener('click', () => {
        if (!store.profile) { D.toast('Trace d\'abord un parcours (page Parcours).', 'error'); return; }
        PYR.app.go(racePage(), { start: 1 });
      });
      $('#g-live-create').addEventListener('click', () => PYR.app.go(racePage(), { do: 'live-create' }));
      $('#g-live-join').addEventListener('click', () => PYR.app.go(racePage(), { do: 'live-join' }));
      render();
    },
  };

  PYR.gameSetup = S;
})(globalThis.PYR = globalThis.PYR || {});
