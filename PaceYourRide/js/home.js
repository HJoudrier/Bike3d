/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page d'accueil (accueil.html) : le projet en cours, le sélecteur d'un élément (parcours, athlète, vélo, tenue)
 * et l'assistant « plan optimal ». Elle lit et écrit la même sauvegarde que l'application (localStorage, clé de store.js) :
 * choisir un élément ici le recopie dans le projet, que chaque page du site (parcours.html, athlete.html…) retrouve en s'ouvrant. */
(function (PYR) {
  'use strict';

  const D = PYR.dom, L = PYR.library;
  const { $, h } = D;

  const PROJECT_KEY = 'paceyourride.v1';          // même clé que js/core/store.js
  const LIBRARY_KEY = L.STORAGE_KEY;
  const MTIME_KEY = 'paceyourride.v1.mtime';       // date de la dernière modification du projet (js/core/store.js), pour la synchronisation

  /** Pages du site où se modifie chaque rubrique. */
  const PAGE = { route: 'parcours.html', rider: 'athlete.html', bike: 'equipement.html', perf: 'pacing.html' };

  /** Rubriques, dans l'ordre de l'assistant : libellé, page (PAGE) où les modifier. */
  const KINDS = [
    { id: 'route', label: 'Parcours', tab: 'route', empty: 'Aucun parcours', emptyHint: 'Trace-en un ou importe un GPX.', pick: 'Choisis le parcours' },
    { id: 'athlete', label: 'Athlète', tab: 'rider', empty: 'Réglages par défaut', emptyHint: 'Profil non renseigné.', pick: "Choisis l'athlète" },
    { id: 'bike', label: 'Vélo', tab: 'bike', empty: 'Réglages par défaut', emptyHint: 'Vélo non renseigné.', pick: 'Choisis le vélo' },
    { id: 'outfit', label: 'Tenue & position', tab: 'bike', focus: 'r-position', empty: 'Réglages par défaut', emptyHint: 'Tenue non renseignée.', pick: 'Choisis la tenue et la position' },
  ];
  const kindOf = (id) => KINDS.find((k) => k.id === id);

  // ---------- Stockage ----------

  function readJSON(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function writeJSON(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); if (key === LIBRARY_KEY) PYR.cloud.syncSoon(); return true; } catch (e) { D.toast('Enregistrement impossible : stockage du navigateur indisponible.', 'error'); return false; }
  }
  const readProject = () => { const p = readJSON(PROJECT_KEY); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; };
  const readLibrary = () => L.normalize(readJSON(LIBRARY_KEY));

  /** Le projet contient-il quelque chose pour cette rubrique ? (sinon les pages utilisent les valeurs par défaut) */
  function hasData(kind, project) {
    if (kind === 'route') return L.routeLength(project) > 0;
    if (kind === 'athlete' || kind === 'outfit') return !!project.rider;
    return !!project.bike;
  }

  /** Nom que le projet en cours donne à la rubrique (parcours, vélo, tenue), ou '' : champ du projet, enregistré et synchronisé avec lui. */
  function projectName(kind, project) {
    if (kind === 'route') return String(project.route && project.route.name || '');
    if (kind === 'bike') return String(project.bike && project.bike.name || '');
    if (kind === 'outfit') return String(project.rider && project.rider.outfitName || '');
    return '';
  }
  /** Donne ce nom à la rubrique du projet (parcours, vélo ou tenue). */
  function setProjectName(kind, project, name) {
    if (kind === 'route' && project.route) project.route.name = name;
    else if (kind === 'bike') project.bike = Object.assign({}, project.bike, { name });
    else if (kind === 'outfit') project.rider = Object.assign({}, project.rider, { outfitName: name });
  }

  /** Résumé du projet en cours pour une rubrique : { title, detail, empty }. */
  function describeCurrent(kind, project) {
    const k = kindOf(kind);
    if (!hasData(kind, project)) return { title: k.empty, detail: k.emptyHint, empty: true };
    const s = L.summary(kind, L.extract(kind, project));
    if (!s) return { title: k.empty, detail: k.emptyHint, empty: true };
    const name = projectName(kind, project);      // un élément nommé : le nom d'abord, puis son résumé
    return Object.assign({ empty: false }, name ? { title: name, detail: [s.title, s.detail].filter(Boolean).join(' · ') } : s);
  }

  /** « Créer un parcours » : le projet repart d'un parcours vide, nommé d'après l'instant du clic, et la page Parcours s'ouvre. */
  function createRoute() {
    const project = readProject();
    if (L.routeLength(project) > 0 && !confirm("Créer un nouveau parcours ? Le parcours du projet en cours sera remplacé : garde-le d'abord dans ta bibliothèque si tu veux le retrouver.")) return;
    L.startRoute(project);
    if (!writeJSON(PROJECT_KEY, project)) return;
    try { localStorage.setItem(MTIME_KEY, String(Date.now())); } catch (e) { /* stockage indisponible */ }
    PYR.cloud.syncSoon();
    location.href = PAGE.route;
  }

  // ---------- Projet en cours ----------

  let preview;                                          // aperçu du parcours (js/ui/route-preview.js)

  /** Redessine ce que le projet en cours contient : parcours, météo, athlète, vélo et tenue. */
  function renderProject() {
    const project = readProject();
    if (preview) preview.update(project);
    renderAthlete(project);
    renderWeather(project);
    renderGear(project);
  }

  /** Vélo et tenue du projet (carte Matériel) : nom d'abord, puis résumé. */
  function renderGear(project) {
    const box = $('#hm-gear');
    D.clear(box);
    const row = (label, kind) => {
      const d = describeCurrent(kind, project);
      return h('div', { class: 'hm-afull' + (d.empty ? ' is-empty' : '') },
        h('small', { class: 'hm-slot-label' }, label), h('b', { class: 'hm-aname' }, d.title), h('p', { class: 'hm-arec' }, d.detail));
    };
    box.append(row('Vélo', 'bike'), row('Tenue & position', 'outfit'));
  }

  /** Météo du projet (carte Météo) : source, nombre de portions ou jour de départ. */
  function renderWeather(project) {
    const box = $('#hm-weather');
    D.clear(box);
    const w = project.weather;
    if (!w || !w.enabled || !w.snapshot) {
      box.appendChild(h('div', { class: 'hm-rempty' }, h('b', null, 'Aucune météo'), h('small', null, 'Air calme, température saisie dans la page Performance. Choisis une source ci-dessous.')));
      return;
    }
    const count = (a) => (Array.isArray(a) ? a.length : 0);
    const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
    let title, detail;
    if (w.source === 'custom') {
      const c = w.custom || {};
      title = 'Météo personnalisée';
      detail = [plural(count(c.temp), 'portion de température', 'portions de température'), plural(count(c.rain), 'portion de pluie', 'portions de pluie'), plural(count(project.winds), 'portion de vent', 'portions de vent')].join(' · ');
    } else {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(w.startAt || ''));
      title = 'Prévisions Open-Meteo';
      detail = m ? `Départ le ${m[3]}/${m[2]}/${m[1]} à ${m[4]}` : 'Départ non précisé';
    }
    box.appendChild(h('div', { class: 'hm-afull' }, h('b', { class: 'hm-aname' }, title), h('p', { class: 'hm-arec' }, detail)));
  }

  /** Profil de l'athlète du projet (carte Athlète) : identité, morphologie, FTP, W/kg, puissance critique, W′ et niveau. */
  function renderAthlete(project) {
    const box = $('#hm-athlete');
    D.clear(box);
    if (!hasData('athlete', project)) {
      box.appendChild(h('a', { class: 'hm-rempty hm-alink', href: PAGE.rider, title: "Renseigner l'athlète sur la page Athlète" }, h('b', null, 'Aucun athlète'), h('small', null, "Ajoute-en un, renseigne ton profil sur la page Athlète (touche ici) ou choisis-en un dans ta bibliothèque.")));
      return;
    }
    const r = Object.assign({}, L.newAthlete().rider, project.rider);
    const fmt = (x, d) => (Math.round(x * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toLocaleString('fr-FR');
    const stat = (label, value) => h('span', null, h('small', null, label), h('b', null, value));
    const kg = Number(r.weight) || 0;
    const born = PYR.util.ageFrom(r.birthDate), age = born !== null ? born : Number(r.age) || 0;      // l'âge se déduit de la date de naissance
    let a = null;
    try { a = PYR.physio.buildAthlete(r); } catch (e) { /* profil illisible : on n'affiche que l'identité */ }
    const ftp = a ? Math.round(a.ftp) : Number(r.ftp) || 0;
    const wkg = kg && ftp ? ftp / kg : 0;
    const level = wkg && PYR.bench ? PYR.bench.classify(r.sex === 'f' ? 'f' : 'm', 'ftp', wkg).level : null;
    const who = [r.sex === 'f' ? 'Femme' : 'Homme', age ? `${fmt(age)} ans` : '', kg ? `${fmt(kg, 1)} kg` : '', Number(r.height) ? `${fmt(Number(r.height))} cm` : ''].filter(Boolean).join(' · ');
    box.appendChild(h('a', { class: 'hm-afull hm-alink', href: PAGE.rider, title: "Modifier l'athlète sur la page Athlète" },
      h('div', { class: 'hm-aid' }, PYR.avatar.span(40, '#eb6834', r), h('div', null, h('b', { class: 'hm-aname' }, r.name || 'Athlète sans nom'), h('p', { class: 'hm-arec' }, who))),
      h('p', { class: 'hm-rstats' },
        stat('FTP', ftp ? `${fmt(ftp)} W` : '—'),
        stat('W/kg', wkg ? fmt(wkg, 2) : '—'),
        a ? stat('Puissance critique', `${fmt(a.cp)} W`) : null,
        a ? stat('W′', `${fmt(a.w0 / 1000, 1)} kJ`) : null),
      level ? h('p', { class: 'hm-alevel' }, h('span', { class: 'hm-adot', style: { background: level.color }, 'aria-hidden': 'true' }), `Niveau : ${level.label}`, h('small', null, ` · ${level.who}`)) : null));
  }

  // ---------- Ajouter un athlète ----------

  let adlg;

  function openAddAthlete() {
    const f = $('#ath-form');
    f.reset();
    $('#ath-err').hidden = true;
    const t = new Date(), p2 = (x) => String(x).padStart(2, '0');
    $('#ath-birth').max = `${t.getFullYear() - 8}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
    $('#ath-birth').value = `${t.getFullYear() - 35}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;      // 35 ans par défaut, comme la page Athlète
    $('#ath-name').value = L.defaultAthleteName();      // nom par défaut : la date et l'heure de la création
    adlg.showModal();
    $('#ath-name').focus();
    $('#ath-name').select();
  }

  /** Crée l'athlète dans la bibliothèque (le projet en cours ne change pas), puis ouvre le sélecteur dessus pour le choisir si on le souhaite. */
  function addAthlete(e) {
    e.preventDefault();
    const val = (id) => $('#' + id).value;
    const name = val('ath-name').trim() || L.defaultAthleteName();      // champ vidé : le nom par défaut
    const err = $('#ath-err');
    const age = PYR.util.ageFrom(val('ath-birth'));
    const bad = age === null ? 'Renseigne la date de naissance.' : age < 8 || age > 99 ? 'La date de naissance doit correspondre à un âge de 8 à 99 ans.'
      : [['ath-weight', 'poids'], ['ath-height', 'taille'], ['ath-ftp', 'FTP']].map(([id, lbl]) => (val(id) === '' ? `Renseigne le ${lbl}.` : '')).find(Boolean);
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    const lib = readLibrary();
    const it = L.add(lib, 'athlete', name, L.newAthlete({ name, sex: val('ath-sex'), birthDate: val('ath-birth'), weight: val('ath-weight'), height: val('ath-height'), ftp: val('ath-ftp') }));
    if (!writeJSON(LIBRARY_KEY, lib)) return;
    adlg.close();
    D.toast(`« ${it.name} » ajouté à ta bibliothèque.`);
    openWizard('single', 'athlete', it.id);
  }

  // ---------- Fenêtre : sélecteur et assistant ----------

  /** mode : 'plan' (assistant en 5 étapes) ou 'single' (une seule rubrique) ; sel : choix par rubrique ('current' ou id de la bibliothèque). */
  const W = { mode: 'single', steps: [], i: 0, sel: {} };
  let dlg;

  function openWizard(mode, kind, pick) {
    W.mode = mode;
    W.steps = mode === 'plan' ? ['route', 'athlete', 'bike', 'outfit', 'recap'] : [kind];
    W.i = 0;
    W.sel = {};
    const project = readProject(), lib = readLibrary();
    for (const k of KINDS) {
      // le projet en cours par défaut ; sans parcours, le premier de la bibliothèque
      const first = lib[L.KINDS[k.id].list][0];
      W.sel[k.id] = hasData(k.id, project) || !first ? 'current' : first.id;
    }
    if (pick) W.sel[kind] = pick;
    renderWizard();
    if (!dlg.open) dlg.showModal();
  }

  function renderWizard() {
    const step = W.steps[W.i];
    const project = readProject(), lib = readLibrary();
    const plan = W.mode === 'plan';
    $('#wiz-title').textContent = plan ? 'Préparer un plan optimal' : (kindOf(step) || {}).label;

    // fil des étapes
    const steps = $('#wiz-steps');
    D.clear(steps);
    steps.hidden = !plan;
    W.steps.forEach((s, i) => {
      const k = kindOf(s);
      steps.appendChild(h('li', { class: i === W.i ? 'is-current' : i < W.i ? 'is-done' : '', 'aria-current': i === W.i ? 'step' : null },
        h('span', { class: 'wz-dot' }, i < W.i ? '✓' : String(i + 1)), h('span', { class: 'wz-lbl' }, k ? k.label : 'Calcul')));
    });

    const body = $('#wiz-body');
    D.clear(body);
    let ok = true;
    if (step === 'recap') ok = renderRecap(body, project, lib);
    else ok = renderChoices(body, step, project, lib);

    $('#wiz-back').hidden = !plan || W.i === 0;
    const next = $('#wiz-next');
    next.disabled = !ok;
    next.textContent = !plan ? 'Valider' : step === 'recap' ? 'Calculer la stratégie' : 'Suivant';
  }

  /** Une rubrique : le projet en cours puis la bibliothèque, au choix ; enregistrer le projet en cours ; modifier sur sa page. Renvoie vrai si un choix est possible. */
  function renderChoices(body, kind, project, lib) {
    const k = kindOf(kind);
    const items = lib[L.KINDS[kind].list];
    const cur = describeCurrent(kind, project);
    const canCurrent = !(kind === 'route' && cur.empty);

    if (W.sel[kind] !== 'current' && !L.find(lib, kind, W.sel[kind])) W.sel[kind] = canCurrent ? 'current' : (items[0] ? items[0].id : 'current');
    if (W.sel[kind] === 'current' && !canCurrent) W.sel[kind] = items[0] ? items[0].id : 'current';

    body.appendChild(h('p', { class: 'wz-ask' }, k.pick + ' :'));
    const list = h('div', { class: 'wz-list', role: 'radiogroup', 'aria-label': k.label });
    const option = (id, title, detail, tag, onRemove, onRename, thumb) => {
      const input = h('input', { type: 'radio', name: 'wz-' + kind, value: id, checked: W.sel[kind] === id, disabled: id === 'current' && !canCurrent });
      input.addEventListener('change', () => { W.sel[kind] = id; renderWizard(); });
      return h('div', { class: 'wz-row' },
        h('label', { class: 'wz-opt' + (W.sel[kind] === id ? ' is-on' : '') + (thumb ? ' has-thumb' : '') }, input,
          h('span', { class: 'wz-opt-txt' }, h('b', null, title), h('small', null, detail)),
          thumb || null,
          tag ? h('span', { class: 'wz-tag' }, tag) : null),
        onRename ? h('button', { class: 'btn ghost icon', type: 'button', title: 'Renommer', 'aria-label': `Renommer « ${title} »`, onclick: onRename }, '✎') : null,
        onRemove ? h('button', { class: 'btn ghost icon', type: 'button', title: 'Retirer de la bibliothèque', 'aria-label': `Retirer « ${title} » de la bibliothèque`, onclick: onRemove }, '✕') : null);
    };
    list.appendChild(option('current', cur.title, cur.detail, 'Projet en cours', null, null, kind === 'route' && !cur.empty ? routeThumb(project) : null));
    for (const it of items) {
      const s = L.summary(kind, it.data) || { title: '', detail: '' };
      list.appendChild(option(it.id, it.name, [s.title, s.detail].filter(Boolean).join(' · '), null, () => {
        if (!confirm(`Retirer « ${it.name} » de la bibliothèque ?`)) return;
        L.remove(lib, kind, it.id);
        writeJSON(LIBRARY_KEY, lib);
        if (W.sel[kind] === it.id) W.sel[kind] = 'current';
        renderWizard();
      }, () => {
        const name = prompt('Nouveau nom :', it.name);
        if (name === null || !name.trim()) return;
        L.rename(lib, kind, it.id, name);
        if (writeJSON(LIBRARY_KEY, lib)) renderWizard();
      }));
    }
    body.appendChild(list);
    if (!items.length) body.appendChild(h('p', { class: 'wz-hint' }, kind === 'route'
      ? `Ta bibliothèque est vide. Le projet ne garde qu'un seul parcours : utilise « Enregistrer » sur la page Parcours pour en accumuler plusieurs.`
      : kind === 'athlete' ? `Ta bibliothèque est vide : ferme cette fenêtre et utilise « Ajouter un athlète » pour en créer.`
      : `Ta bibliothèque est vide : enregistre le projet en cours pour le retrouver ici, et en préparer d'autres sur les pages du site.`));

    if (kind !== 'route' && kind !== 'athlete') {
      if (!cur.empty) {
        const name = h('input', { type: 'text', maxlength: '60', 'aria-label': 'Nom à donner', placeholder: 'Nom', value: defaultName(kind, project) });
        const save = () => {
          const data = L.extract(kind, project);
          let r = L.save(lib, kind, name.value, data);
          if (r.exists) {
            if (!confirm(`« ${r.exists.name} » existe déjà dans ta bibliothèque. Veux-tu vraiment l'écraser ?`)) return;
            r = L.save(lib, kind, name.value, data, Date.now(), true);
          }
          const it = r.item;
          if (kind === 'bike' || kind === 'outfit') {         // le projet prend le nom sous lequel il est enregistré
            setProjectName(kind, project, it.name);
            if (writeJSON(PROJECT_KEY, project)) { try { localStorage.setItem(MTIME_KEY, String(Date.now())); } catch (e) { /* stockage indisponible */ } }
          }
          if (writeJSON(LIBRARY_KEY, lib)) { D.toast(`« ${it.name} » ${r.replaced ? 'mis à jour dans' : 'enregistré dans'} ta bibliothèque.`); renderWizard(); }
        };
        name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        body.appendChild(h('div', { class: 'wz-save' },
          h('span', { class: 'wz-save-lbl' }, 'Enregistrer le projet en cours dans la bibliothèque'),
          h('div', { class: 'wz-save-row' }, name, h('button', { class: 'btn', type: 'button', onclick: save }, 'Enregistrer'))));
      }
      body.appendChild(h('a', { class: 'wz-edit', href: PAGE[k.tab] + (k.focus ? `?focus=${k.focus}` : '') }, `Modifier ${k.label.toLowerCase()} sur sa page ›`));
    }
    return canCurrent || items.length > 0;
  }

  function defaultName(kind, project) {
    if (kind === 'athlete') return (project.rider && project.rider.name) || '';
    if (projectName(kind, project)) return projectName(kind, project);
    const s = L.summary(kind, L.extract(kind, project));
    return kind === 'route' ? (s ? s.title.split(' · ')[0] : '') : (s ? s.title : '');
  }

  /** Vignette du tracé du projet en cours (SVG sans fond de carte, donc sans réseau) : le trait avec son départ (vert) et son arrivée (rouge). */
  function routeThumb(project) {
    const p = L.routeProfile(project);
    if (!p) return null;
    const NS = 'http://www.w3.org/2000/svg', W = 150, Hh = 96, pad = 9;
    const k = Math.cos(p.lat[Math.floor(p.n / 2)] * Math.PI / 180);       // un degré de longitude est plus court que de latitude
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < p.n; i++) { const x = p.lng[i] * k, y = -p.lat[i]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const sc = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1e-9), (Hh - 2 * pad) / Math.max(y1 - y0, 1e-9));
    const ox = (W - (x1 - x0) * sc) / 2, oy = (Hh - (y1 - y0) * sc) / 2;
    const pt = (i) => [ox + (p.lng[i] * k - x0) * sc, oy + (-p.lat[i] - y0) * sc];
    const stride = Math.max(1, Math.floor(p.n / 300)), pts = [];
    for (let i = 0; i < p.n; i += stride) pts.push(pt(i));
    pts.push(pt(p.n - 1));
    const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const a of Object.keys(attrs)) e.setAttribute(a, attrs[a]); return e; };
    const svg = el('svg', { class: 'wz-thumb', viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': 'Tracé du parcours' });
    svg.appendChild(el('polyline', { points: pts.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' '), fill: 'none', stroke: '#2a78d6', 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const dot = (q, c) => svg.appendChild(el('circle', { cx: q[0].toFixed(1), cy: q[1].toFixed(1), r: 4.5, fill: c, stroke: '#fff', 'stroke-width': 1.5 }));
    dot(pts[0], '#1d9a4a'); dot(pts[pts.length - 1], '#d62828');
    return svg;
  }

  /** Dernière étape : ce qui sera utilisé. Renvoie vrai si le calcul est possible (il faut un parcours). */
  function renderRecap(body, project, lib) {
    body.appendChild(h('p', { class: 'wz-ask' }, 'Le plan sera calculé avec :'));
    const dl = h('div', { class: 'wz-recap' });
    let replaced = false, ok = true;
    for (const k of KINDS) {
      const id = W.sel[k.id];
      let title, detail, tag = '';
      if (id === 'current') {
        const c = describeCurrent(k.id, project);
        title = c.title; detail = c.detail; tag = 'Projet en cours';
        if (k.id === 'route' && c.empty) ok = false;
      } else {
        const it = L.find(lib, k.id, id);
        if (!it) { ok = false; title = k.empty; detail = ''; } else {
          const s = L.summary(k.id, it.data) || { title: '', detail: '' };
          title = it.name; detail = [s.title, s.detail].filter(Boolean).join(' · '); tag = 'Bibliothèque'; replaced = true;
        }
      }
      dl.appendChild(h('div', { class: 'wz-recap-row' },
        h('button', { class: 'wz-recap-edit', type: 'button', onclick: () => { W.i = W.steps.indexOf(k.id); renderWizard(); } }, 'Changer'),
        h('span', { class: 'wz-recap-lbl' }, k.label),
        h('b', null, title), h('small', null, detail), tag ? h('span', { class: 'wz-tag' }, tag) : null));
    }
    body.appendChild(dl);
    if (!ok) body.appendChild(h('p', { class: 'wz-warn' }, "Il faut un parcours : reviens à la première étape pour en choisir un, ou trace-en un sur la page Parcours."));
    else if (replaced) body.appendChild(h('p', { class: 'wz-hint' }, 'Les éléments choisis dans la bibliothèque remplacent ceux du projet en cours. Pense à enregistrer ce dernier avant si tu veux le garder.'));
    return ok;
  }

  /** Recopie dans le projet les éléments choisis dans la bibliothèque. */
  function applySelection() {
    const project = readProject(), lib = readLibrary();
    for (const k of KINDS) {
      const id = W.sel[k.id];
      if (!id || id === 'current' || (W.mode === 'single' && !W.steps.includes(k.id))) continue;
      const it = L.find(lib, k.id, id);
      if (it) { L.apply(k.id, project, it.data); setProjectName(k.id, project, it.name); }
    }
    const ok = writeJSON(PROJECT_KEY, project);
    if (ok) { try { localStorage.setItem(MTIME_KEY, String(Date.now())); } catch (e) { /* stockage indisponible */ } PYR.cloud.syncSoon(); }
    return ok;
  }

  function onNext() {
    const step = W.steps[W.i];
    if (W.mode === 'single') {
      if (applySelection()) { dlg.close(); renderProject(); D.toast('Projet mis à jour.'); }
    } else if (step === 'recap') {
      if (applySelection()) location.href = PAGE.perf + '?do=optimize';
    } else { W.i++; renderWizard(); }
  }

  // ---------- Synchronisation Dropbox ----------

  let cdlg, seenPulls = 0;

  const when = (t) => (t ? new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'jamais');

  function renderCloud() {
    const st = PYR.cloud.status();
    const label = $('#hm-cloud-txt'), btn = $('#hm-cloud');
    btn.classList.toggle('is-on', st.connected && !st.error);
    btn.classList.toggle('is-err', !!st.error);
    label.textContent = st.busy ? 'Synchronisation…' : st.error ? 'Synchro en erreur' : st.connected ? 'Synchronisé ' + when(st.lastSync) : 'Synchroniser mes appareils';
    if (!cdlg.open) return;
    const body = $('#cloud-body');
    D.clear(body);
    if (st.error) body.appendChild(h('p', { class: 'wz-warn', role: 'alert' }, st.error));
    const act = (txt, fn, cls) => h('button', { class: 'btn ' + (cls || ''), type: 'button', disabled: st.busy, onclick: fn }, txt);
    const run = (p) => p.catch((e) => D.toast(e.message, 'error'));
    if (st.connected) {
      body.append(
        h('p', null, "Ton projet en cours et ta bibliothèque sont enregistrés dans ton Dropbox (dossier de l'application). Ouvre cette page sur un autre appareil et connecte-toi au même compte pour les retrouver."),
        h('p', { class: 'wz-hint' }, "Dernière synchronisation : " + when(st.lastSync) + ". Elle se fait à l'ouverture de l'accueil et après chaque changement ici ; ce que tu modifies sur les autres pages part à ton prochain passage sur l'accueil. Le plus récent des deux projets l'emporte ; l'ancien est gardé en copie sur l'appareil."),
        h('div', { class: 'modal-actions' }, act('Se déconnecter', () => { PYR.cloud.logout(); }), act('Synchroniser maintenant', () => run(PYR.cloud.sync()), 'primary')));
      return;
    }
    if (st.needsKey) {
      const input = h('input', { type: 'text', 'aria-label': 'App key Dropbox', placeholder: 'App key', value: st.appKey, autocomplete: 'off', spellcheck: 'false' });
      const copy = () => (navigator.clipboard ? navigator.clipboard.writeText(st.redirectUri) : Promise.reject(new Error('indisponible')))
        .then(() => D.toast('Adresse copiée.'), () => D.toast("Copie impossible : sélectionne l'adresse à la main.", 'error'));
      body.append(
        h('p', null, "Pour synchroniser, il te faut une petite application Dropbox à toi (gratuite, deux minutes). Les données restent dans ton Dropbox ; personne d'autre n'y a accès."),
        h('ol', { class: 'cl-steps' },
          h('li', null, 'Sur ', h('a', { href: 'https://www.dropbox.com/developers/apps', target: '_blank', rel: 'noopener' }, 'dropbox.com/developers/apps'), ' : « Create app » › « Scoped access » › « App folder », avec le nom de ton choix.'),
          h('li', null, 'Onglet « Permissions » : coche files.content.read et files.content.write, puis « Submit ».'),
          h('li', null, 'Onglet « Settings », « Redirect URIs » : ajoute exactement cette adresse.', h('code', { class: 'cl-uri' }, st.redirectUri),
            h('button', { class: 'btn ghost', type: 'button', onclick: copy }, 'Copier')),
          h('li', null, 'Recopie ici la « App key » (en haut de la page Settings).')),
        h('div', { class: 'wz-save-row' }, input,
          act('Se connecter à Dropbox', () => { PYR.cloud.setKey(input.value); run(PYR.cloud.login()); }, 'primary')));
    } else {
      body.append(h('p', null, 'Connecte ton compte Dropbox pour retrouver ton projet et ta bibliothèque sur tous tes appareils.'),
        h('div', { class: 'modal-actions' }, act('Se connecter à Dropbox', () => run(PYR.cloud.login()), 'primary')));
    }
  }

  /** Après un changement venu du nuage (autre appareil) : on relit le projet et la bibliothèque. */
  function onCloudChange(st) {
    if (st.pulls !== seenPulls) { seenPulls = st.pulls; renderProject(); D.toast('Projet et bibliothèque mis à jour depuis Dropbox.'); }
    renderCloud();
  }

  function initCloud() {
    cdlg = $('#cloud-dlg');
    $('#hm-cloud').addEventListener('click', () => { cdlg.showModal(); renderCloud(); });
    $('#cloud-close').addEventListener('click', () => cdlg.close());
    cdlg.addEventListener('click', (e) => { if (e.target === cdlg) cdlg.close(); });
    seenPulls = PYR.cloud.status().pulls;
    PYR.cloud.onChange(onCloudChange);
    renderCloud();
    PYR.cloud.completeLogin().then((r) => {
      if (r === 'connected') D.toast('Dropbox connecté.');
      if (r === 'error') { cdlg.showModal(); renderCloud(); }
      if (PYR.cloud.status().connected) PYR.cloud.sync();
    });
  }

  function init() {
    // un ancien lien de partage pointait sur la page d'ouverture : un défi s'ouvre sur la page Jeu, une invitation sur l'écran de course
    if (/^#defi=/.test(location.hash)) { location.replace('../Jeu2D/index.html' + location.hash); return; }
    if (/^#live=/.test(location.hash)) { location.replace('../Jeu2D/course.html' + location.hash); return; }
    dlg = $('#wiz');
    preview = PYR.routePreview.create($('#hm-route'));
    renderProject();
    $('#hm-new-route').addEventListener('click', createRoute);
    $('#hm-pick-route').addEventListener('click', () => openWizard('single', 'route'));
    $('#hm-pick-athlete').addEventListener('click', () => openWizard('single', 'athlete'));
    $('#hm-pick-bike').addEventListener('click', () => openWizard('single', 'bike'));
    $('#hm-pick-outfit').addEventListener('click', () => openWizard('single', 'outfit'));
    adlg = $('#ath-dlg');
    $('#hm-add-athlete').addEventListener('click', openAddAthlete);
    $('#ath-form').addEventListener('submit', addAthlete);
    $('#ath-close').addEventListener('click', () => adlg.close());
    $('#ath-cancel').addEventListener('click', () => adlg.close());
    adlg.addEventListener('click', (e) => { if (e.target === adlg) adlg.close(); });
    $('#hm-plan').addEventListener('click', () => openWizard('plan'));
    $('#wiz-close').addEventListener('click', () => dlg.close());
    $('#wiz-back').addEventListener('click', () => { if (W.i > 0) { W.i--; renderWizard(); } });
    $('#wiz-next').addEventListener('click', onNext);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });      // clic sur le fond
    // une autre page a pu changer le projet pendant que celle-ci était en arrière-plan
    initCloud();
    window.addEventListener('pageshow', () => { renderProject(); PYR.cloud.syncSoon(300); });
    window.addEventListener('storage', (e) => { if (e.key === PROJECT_KEY) renderProject(); });
  }

  document.addEventListener('DOMContentLoaded', init);
})(globalThis.PYR = globalThis.PYR || {});
