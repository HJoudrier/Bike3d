/* author : Hugo Joudrier-Faure */
/* PaceYourRide — le portail (index.html, racine du site). Il sert aussi d'adresse de retour à la connexion Dropbox, la seule à déclarer dans
 * la console de l'application Dropbox : il enregistre la connexion puis renvoie à l'application d'où l'on est parti (cloud.js completeLogin). */
(function (PYR) {
  'use strict';

  const D = PYR.dom, { $ } = D;

  function render() {
    const st = PYR.cloud.status();
    $('#po-cloud-txt').textContent = st.connected
      ? 'Dropbox : connecté' + (st.lastSync ? ' (dernière lecture ' + new Date(st.lastSync).toLocaleString('fr-FR') + ').' : '.')
      : 'Dropbox : non connecté. Connecte-toi une fois, dans PaceYourRide, les jeux ou le compteur.';
    const btn = $('#po-cloud-btn');
    btn.textContent = st.connected ? 'Se déconnecter' : 'Se connecter à Dropbox';
    btn.className = st.connected ? 'btn' : 'btn primary';
    btn.onclick = () => (st.connected ? PYR.cloud.logout() : PYR.cloud.login().catch((e) => D.toast(e.message, 'error')));
  }

  function init() {
    PYR.cloud.onChange(render);
    render();
    PYR.cloud.completeLogin().then((r) => { if (r === 'error') D.toast(PYR.cloud.status().error || 'Connexion impossible.', 'error'); render(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(globalThis.PYR = globalThis.PYR || {});
