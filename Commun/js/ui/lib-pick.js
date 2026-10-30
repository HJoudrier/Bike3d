/* author : Hugo Joudrier-Faure */
/* PaceYourRide — choisir un parcours ou un athlète dans la bibliothèque, de la même façon dans toutes les applications (accueil de PaceYourRide,
 * Jeu 2D, Jeu 3D, compteur) : un carrousel de parcours (le tracé sur la carte en 2D, une vue 3D dans Jeu 3D, avec distance, D+, D−) et des
 * cartes d'athlète. Les mêmes fenêtres permettent d'ajouter un parcours (fichier GPX) ou un athlète (formulaire).
 * Les fonctions dessinent à partir d'une liste d'éléments {id, name, savedAt, data, project?} (library.js) et rendent la main par des rappels ;
 * elles ne touchent ni au stockage ni à Dropbox (voir lib-cache.js pour les jeux et le compteur, home.js pour PaceYourRide). */
(function (PYR) {
  'use strict';

  const D = PYR.dom, L = PYR.library;
  const { h, $$ } = D;

  const fmt = (x, d) => (Math.round(x * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toLocaleString('fr-FR');

  const profiles = new Map();
  function profileOf(it) {
    const key = it.id + '@' + it.savedAt + '@' + (it.project ? JSON.stringify(it.data.route && it.data.route.name) : '');
    if (!profiles.has(key)) profiles.set(key, L.routeProfile(it.data));
    return profiles.get(key);
  }

  /** Petits boutons d'action d'une carte (renommer, retirer…) : actions(it) → [{label, title, fn}]. Un clic ne choisit pas la carte. */
  function actionsEl(it, actions) {
    const list = actions ? actions(it) : [];
    if (!list || !list.length) return null;
    return h('div', { class: 'gs-card-acts' }, list.map((a) => h('button', { class: 'btn ghost icon', type: 'button', title: a.title || a.label, 'aria-label': a.title || a.label,
      onclick: (e) => { e.stopPropagation(); a.fn(); } }, a.label)));
  }

  /**
   * Carrousel de parcours dans `host`. o : {items, pick (identifiant choisi), view ('2d' : le tracé sur la carte ; '3d' : une vue 3D), onPick(id),
   * actions(it), projectLabel, emptyText}. Renvoie {destroy, setPick(id)}.
   */
  function routeCarousel(host, o) {
    D.clear(host);
    const views = [];
    const list = o.items.map((it) => ({ it, p: profileOf(it) })).filter((x) => x.p);
    const is3d = o.view === '3d';
    const track = h('div', { class: 'gs-track', tabindex: '0', role: 'listbox', 'aria-label': 'Parcours' });
    const prev = h('button', { class: 'gs-arrow', type: 'button', 'aria-label': 'Parcours précédent', onclick: () => track.scrollBy({ left: -track.clientWidth * 0.8 }) }, '‹');
    const next = h('button', { class: 'gs-arrow', type: 'button', 'aria-label': 'Parcours suivant', onclick: () => track.scrollBy({ left: track.clientWidth * 0.8 }) }, '›');
    const arrows = () => { prev.disabled = track.scrollLeft <= 4; next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4; };
    track.addEventListener('scroll', PYR.util.debounce(arrows, 80));
    track.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); next.click(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); prev.click(); } });
    for (const { it, p } of list) {
      const vis = is3d ? h('canvas', { 'aria-hidden': 'true' }) : h('div', { class: 'gs-map', 'aria-hidden': 'true' });
      const stat = (cls, label, value) => h('span', { class: cls }, h('small', null, label), h('b', null, value));
      const on = it.id === o.pick;
      const card = h('div', { class: 'gs-route', role: 'option', tabindex: '-1', 'aria-selected': String(on), dataset: { id: it.id },
        'aria-label': `${it.name}, ${fmt(p.length / 1000, 1)} km, D+ ${fmt(p.up)} m, D− ${fmt(p.down)} m` },
      vis,
      h('div', { class: 'gs-route-info' },
        h('span', { class: 'gs-route-name', title: it.name }, it.name),
        h('div', { class: 'gs-route-stats' },
          stat('', 'Distance', fmt(p.length / 1000, 1) + ' km'),
          stat('up', 'D+', p.hasEle ? '▲ ' + fmt(p.up) + ' m' : '—'),
          stat('down', 'D−', p.hasEle ? '▼ ' + fmt(p.down) + ' m' : '—'),
          stat('', 'Altitude', p.hasEle ? fmt(Math.min.apply(null, p.ele)) + '–' + fmt(Math.max.apply(null, p.ele)) + ' m' : '—')),
        it.project ? h('span', { class: 'gs-route-tag' }, o.projectLabel || 'Projet en cours de PaceYourRide') : null,
        h('div', { class: 'gs-pick' }, on ? '✓ Parcours choisi' : 'Choisir ce parcours'),
        actionsEl(it, o.actions)));
      card.addEventListener('click', () => { if (vis.dataset.dragged === '1') { vis.dataset.dragged = ''; return; } o.onPick(it.id); });
      track.appendChild(card);
      views.push(is3d ? PYR.routeThumb.mount(vis, p) : PYR.routeThumb.mountMap(vis, p));
    }
    host.append(h('div', { class: 'gs-car' }, prev, track, next));
    if (!list.length) host.appendChild(h('p', { class: 'hint gs-empty' }, o.emptyText || 'Aucun parcours pour le moment.'));
    const sel = track.querySelector('[aria-selected="true"]');
    // le carrousel n'est pas toujours affiché quand on le remplit (fenêtre fermée) : on le centre dès qu'il a une taille
    const center = () => { const s = track.querySelector('[aria-selected="true"]'); if (s && track.clientWidth) track.scrollTo({ left: s.offsetLeft - track.offsetLeft - (track.clientWidth - s.clientWidth) / 2, behavior: 'auto' }); arrows(); };
    if (sel) center(); else arrows();
    setTimeout(center, 60);
    return {
      destroy() { for (const v of views) v.destroy(); },
      setPick(id) {
        $$('.gs-route', track).forEach((c) => {
          const on2 = c.dataset.id === id;
          c.setAttribute('aria-selected', String(on2));
          c.querySelector('.gs-pick').textContent = on2 ? '✓ Parcours choisi' : 'Choisir ce parcours';
        });
      },
    };
  }

  /** Cartes d'athlète dans `host`. o : {items, pick, onPick(id), actions(it), emptyText}. */
  function athleteCards(host, o) {
    D.clear(host);
    const box = h('div', { class: 'gs-cards', role: 'listbox', 'aria-label': 'Athlètes' });
    for (const it of o.items) {
      const s = L.summary('athlete', it.data) || { title: it.name, detail: '' };
      box.appendChild(h('div', { class: 'gs-ath', role: 'option', tabindex: '0', 'aria-selected': String(it.id === o.pick), dataset: { id: it.id },
        onclick: () => o.onPick(it.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); o.onPick(it.id); } } },
      h('b', null, it.project ? s.title + ' (projet en cours)' : it.name), h('small', null, s.detail), actionsEl(it, o.actions)));
    }
    host.appendChild(box);
    if (!o.items.length) host.appendChild(h('p', { class: 'hint gs-empty' }, o.emptyText || "Aucun athlète enregistré : l'athlète par défaut sera utilisé."));
    return { setPick(id) { $$('.gs-ath', box).forEach((c) => c.setAttribute('aria-selected', String(c.dataset.id === id))); } };
  }

  /** Ouvre le sélecteur de fichier GPX ; rappelle fn({name, data, hasEle}) avec le parcours lu (lib-cache.js routeFromGpx), ou affiche l'erreur. */
  function chooseGpx(fn) {
    const input = h('input', { type: 'file', accept: '.gpx,application/gpx+xml,text/xml', hidden: true });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      input.remove();
      if (!f) return;
      try {
        const r = PYR.libCache.routeFromGpx(await D.readFile(f));
        if (!r.name) r.name = String(f.name || '').replace(/\.(pyr-parcours\.)?gpx$/i, '').slice(0, 60) || L.defaultRouteName();
        r.data.route.name = r.name;
        fn(r);
      } catch (e) { D.toast('Parcours illisible : ' + e.message, 'error', 6000); }
    });
    document.body.appendChild(input);
    input.click();
  }

  /** Fenêtre « Ajouter un athlète » : rappelle fn({name, data}) avec l'athlète (library.js newAthlete) quand on valide. */
  function athleteDialog(fn) {
    const t = new Date(), p2 = (x) => String(x).padStart(2, '0');
    const day = (y) => `${t.getFullYear() - y}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
    const inp = (id, label, attrs) => h('div', { class: 'field' }, h('label', { for: id }, label), h('input', Object.assign({ id }, attrs)));
    const err = h('p', { class: 'wz-warn', role: 'alert', hidden: true });
    const name = inp('lp-name', 'Nom', { type: 'text', maxlength: '30', autocomplete: 'off', value: L.defaultAthleteName() });
    const sex = h('select', { id: 'lp-sex' }, h('option', { value: 'm' }, 'Homme'), h('option', { value: 'f' }, 'Femme'));
    const val = (id) => dlg.querySelector('#' + id).value;
    const form = h('form', { method: 'dialog', novalidate: true, class: 'gs-dlg-form',
      onsubmit: (e) => {
        e.preventDefault();
        const nm = val('lp-name').trim() || L.defaultAthleteName(), age = PYR.util.ageFrom(val('lp-birth'));
        const bad = age === null ? 'Renseigne la date de naissance.' : age < 8 || age > 99 ? 'La date de naissance doit correspondre à un âge de 8 à 99 ans.'
          : [['lp-weight', 'poids'], ['lp-height', 'taille'], ['lp-ftp', 'FTP']].map(([id, l]) => (val(id) === '' ? `Renseigne le ${l}.` : '')).find(Boolean);
        if (bad) { err.textContent = bad; err.hidden = false; return; }
        dlg.close();
        fn({ name: nm, data: L.newAthlete({ name: nm, sex: val('lp-sex'), birthDate: val('lp-birth'), weight: val('lp-weight'), height: val('lp-height'), ftp: val('lp-ftp') }) });
      } },
    h('h3', null, 'Ajouter un athlète'),
    name,
    h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'lp-sex' }, 'Sexe (références de niveau)'), sex), inp('lp-birth', 'Date de naissance', { type: 'date', min: '1900-01-01', max: day(8), value: day(35) })),
    h('div', { class: 'grid3' }, inp('lp-weight', 'Poids (kg)', { type: 'number', min: '25', max: '200', step: '0.1', value: '72' }), inp('lp-height', 'Taille (cm)', { type: 'number', min: '120', max: '230', step: '1', value: '178' }), inp('lp-ftp', 'FTP (W)', { type: 'number', min: '50', max: '600', step: '1', value: '250' })),
    h('p', { class: 'hint' }, 'La puissance critique, le W′ et la courbe de puissance record se règlent ensuite dans PaceYourRide (page Athlète).'),
    err,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Annuler'), h('button', { class: 'btn primary', type: 'submit' }, 'Ajouter à ma bibliothèque')));
    const dlg = h('dialog', { class: 'modal gs-dlg', 'aria-label': 'Ajouter un athlète' }, form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    const n = dlg.querySelector('#lp-name');
    n.focus(); n.select();
  }

  /* ---------- les sélecteurs complets : les mêmes dans PaceYourRide, Jeu 2D, Jeu 3D et le compteur ---------- */

  const VIEW_KEY = (PYR.storageNs || 'paceyourride') + '.pickview';
  /** Vue des parcours choisie ('2d' : le tracé sur la carte ; '3d' : une vue 3D), gardée pour l'application ; `dflt` tant qu'on n'a pas choisi. */
  function viewPref(dflt) {
    let v = null;
    try { v = localStorage.getItem(VIEW_KEY); } catch (e) { /* stockage indisponible */ }
    return v === '3d' || v === '2d' ? v : (dflt === '3d' ? '3d' : '2d');
  }

  /**
   * Sélecteur de parcours : une barre (« Ajouter un parcours », autres boutons, bascule 2D / 3D) puis le carrousel (routeCarousel).
   * o : routeCarousel + {onAdd (ajout d'un fichier GPX), extra ([{label, title, fn}] : autres boutons), defaultView ('2d' | '3d')}.
   * Renvoie {destroy, setPick(id)}.
   */
  function routePicker(host, o) {
    D.clear(host);
    let view = viewPref(o.defaultView), car = null, pick = o.pick;
    const area = h('div', { class: 'gs-route-area' });
    const seg = h('div', { class: 'seg-control gs-view', role: 'radiogroup', 'aria-label': 'Vue des parcours' },
      ['2d', '3d'].map((v) => h('button', { type: 'button', role: 'radio', dataset: { view: v }, 'aria-pressed': String(v === view),
        title: v === '2d' ? 'Le tracé sur le fond de carte' : 'Le tracé en 3D, posé à son altitude : glisse pour le faire tourner', onclick: () => setView(v) }, v === '2d' ? '2D' : '3D')));
    const bar = h('div', { class: 'gs-add' },
      o.onAdd ? h('button', { class: 'btn', type: 'button', title: 'Ajouter un parcours à ta bibliothèque : un fichier GPX, ou un parcours complet exporté par PaceYourRide', onclick: o.onAdd }, '＋ Ajouter un parcours (GPX)') : null,
      (o.extra || []).map((b) => h('button', { class: 'btn', type: 'button', title: b.title || b.label, onclick: b.fn }, b.label)), seg);
    host.append(bar, area);
    function draw() {
      if (car) car.destroy();
      car = routeCarousel(area, Object.assign({}, o, { pick, view, onPick: (id) => { pick = id; o.onPick(id); } }));
    }
    function setView(v) {
      if (v === view) return;
      view = v;
      try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* stockage indisponible */ }
      $$('[data-view]', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
      draw();
    }
    draw();
    return { destroy() { if (car) car.destroy(); }, setPick(id) { pick = id; if (car) car.setPick(id); } };
  }

  /** Sélecteur d'athlète : une barre (« Ajouter un athlète ») puis les cartes (athleteCards). o : athleteCards + {onAdd}. */
  function athletePicker(host, o) {
    D.clear(host);
    const area = h('div');
    host.append(h('div', { class: 'gs-add' }, o.onAdd ? h('button', { class: 'btn', type: 'button', onclick: o.onAdd }, '＋ Ajouter un athlète') : null), area);
    return athleteCards(area, o);
  }

  PYR.libPick = { routeCarousel, athleteCards, routePicker, athletePicker, viewPref, chooseGpx, athleteDialog, profileOf };
})(globalThis.PYR = globalThis.PYR || {});
