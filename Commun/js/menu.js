/* author : Hugo Joudrier-Faure */
/* PaceYourRide — menu burger des pages du site (en haut à droite de chaque page). Il s'ouvre au clic sur le bouton, se referme
 * au clic ailleurs, à Échap (le focus revient alors au bouton) et dès qu'on choisit une page. Sans JavaScript, le menu reste fermé. */
(function () {
  'use strict';
  const btn = document.getElementById('btn-menu');
  const menu = document.getElementById('site-menu');
  if (!btn || !menu) return;

  function setOpen(open) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  btn.addEventListener('click', () => {
    const open = menu.hidden;
    setOpen(open);
    if (open) (menu.querySelector('a[aria-current="page"]') || menu.querySelector('a')).focus();
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    setOpen(false);
    btn.focus();
  });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  // le menu ne doit pas rester ouvert quand la page revient depuis le cache du navigateur (bouton Précédent)
  window.addEventListener('pageshow', () => setOpen(false));
})();
