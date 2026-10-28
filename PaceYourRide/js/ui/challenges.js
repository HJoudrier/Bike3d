/* author : Hugo Joudrier-Faure */
/* PaceYourRide — défis en différé : un parcours figé + les résultats (fantômes) de chaque cycliste.
 * Partage sans serveur : lien (#defi=…), code à copier-coller ou fichier .json. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, R = PYR.raceData, C = PYR.codec, Cl = PYR.classif, CV = PYR.classifView;
  const { h, $ } = D;

  const MAX_STORED = 12;
  const MAX_GHOSTS = 7;
  /** Couleurs des adversaires (palette catégorielle, ordre fixe ; orange = toi, bleu = plan optimal). */
  const COLORS = ['#1baf7a', '#4a3aa7', '#e87ba4', '#008300', '#eda100', '#e34948', '#6f6d66'];

  const cache = new Map(); // id → défi décompressé

  /** Longueur (m) d'un parcours canonique. */
  const courseLength = (c) => c.step * (c.n - 1);

  /**
   * Points de passage d'un défi : ceux fixés à sa création ; pour un défi plus ancien, ceux que
   * donnent ses règles (aucun s'il n'en a pas).
   */
  function checkpointsOf(course, cps, rules) {
    return Array.isArray(cps) ? Cl.normalize(cps, courseLength(course)) : Cl.build(R.geometryProfile(course), PYR.race.normRules(rules));
  }

  /** Zones de ravitaillement d'un défi : celles fixées à sa création ; pour un défi plus ancien, celles que donnent ses règles. */
  function feedOf(course, feed, rules) {
    return Array.isArray(feed) ? PYR.feed.normalize(feed, courseLength(course)) : PYR.feed.build(R.geometryProfile(course), PYR.race.normRules(rules));
  }

  /* ---------- stockage (forme compacte) ---------- */
  function packChallenge(ch) {
    return {
      id: ch.id, title: ch.title, createdAt: ch.createdAt, creator: ch.creator, fair: !!ch.fair, rules: ch.rules,
      rider: ch.fair ? ch.rider : undefined, bike: ch.fair ? ch.bike : undefined,
      course: R.packCourse(ch.course), cps: ch.cps, feed: ch.feed,
      entries: ch.entries.map(R.packEntry),
    };
  }
  function unpackChallenge(p) {
    const ch = Object.assign({}, p, { course: R.unpackCourse(p.course), entries: (p.entries || []).map(R.unpackEntry) });
    ch.signature = R.courseSignature(ch.course);
    ch.cps = checkpointsOf(ch.course, p.cps, p.rules);
    ch.feed = feedOf(ch.course, p.feed, p.rules);
    return ch;
  }

  function get(id) {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id);
    const p = store.state.challenges[id];
    if (!p) return null;
    const ch = unpackChallenge(p);
    cache.set(id, ch);
    return ch;
  }

  function persist(ch) {
    cache.set(ch.id, ch);
    store.state.challenges[ch.id] = packChallenge(ch);
    // on ne garde que les défis les plus récents
    const ids = Object.keys(store.state.challenges);
    if (ids.length > MAX_STORED) {
      ids.sort((a, b) => String(store.state.challenges[a].createdAt).localeCompare(String(store.state.challenges[b].createdAt)));
      for (const id of ids.slice(0, ids.length - MAX_STORED)) {
        if (id === store.state.activeChallenge) continue;
        delete store.state.challenges[id];
        cache.delete(id);
      }
    }
    store.save();
  }

  function riderName() {
    const n = String(store.state.rider.name || '').trim();
    return n || 'Cycliste anonyme';
  }

  function shareUrlBase() {
    return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : null;
  }

  const CH = {
    COLORS,

    active() { return get(store.state.activeChallenge); },

    /** Le parcours chargé est-il exactement celui du défi actif ? */
    isCurrent(ch) {
      ch = ch || CH.active();
      return !!ch && R.currentSignature(store.state) === ch.signature;
    },

    list() {
      return Object.keys(store.state.challenges).map(get).filter(Boolean)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    /** Crée un défi à partir du parcours courant (il devient un parcours figé). */
    create({ title, fair }) {
      const p = store.profile;
      if (!p) throw new Error('Trace d\'abord un parcours.');
      const course = R.canonicalCourse(p, store.state);
      const rules = PYR.race.normRules(store.state.game);
      const ch = {
        id: U.uid() + U.uid(), title: String(title || '').trim() || `Défi de ${riderName()}`,
        createdAt: new Date().toISOString(), creator: riderName(), fair: !!fair,
        rider: fair ? JSON.parse(JSON.stringify(store.state.rider)) : undefined,
        bike: fair ? JSON.parse(JSON.stringify(store.state.bike)) : undefined,
        rules, cps: Cl.fromList(store.state.checkpoints, R.geometryProfile(course)), // sprints et sommets du parcours, figés avec le défi
        feed: PYR.feed.fromList(store.state.feedZones, R.geometryProfile(course)), // zones de ravitaillement, figées avec le défi
        course, entries: [],
      };
      if (ch.rider) { delete ch.rider.name; }
      ch.signature = R.courseSignature(course);
      persist(ch);
      CH.load(ch);
      return ch;
    },

    /** Applique un parcours canonique (géométrie figée, portions, conditions) au projet courant. */
    applyCourse(c) {
      store.state.surfaces = c.surfaces.map((s) => Object.assign({ id: U.uid() }, s));
      store.state.winds = c.winds.map((w) => Object.assign({ id: U.uid() }, w));
      store.state.env.temperature = c.env.temperature;
      store.state.road = { width: c.env.roadWidth > 0 ? c.env.roadWidth : PYR.physics.ROAD_W };
      Object.assign(store.state.perf, c.opts);
      PYR.routeModel.setFixed(R.courseGeometry(c));
      // météo figée avec le parcours : même ciel pour tous, lu à l'heure de chacun ; sans météo, on n'en utilise pas
      const w = store.state.weather;
      if (c.weather) {
        const startAt = PYR.weather.epochToLocal(c.weather.start, c.weather.off);
        Object.assign(w, { enabled: true, source: 'api', startAt, snapshot: c.weather, utcOffset: c.weather.off, fetchedAt: Date.now(), fetchedFor: PYR.weather.freshKey(R.geometryProfile(c), startAt) });
      } else w.enabled = false;
      store.emit('surfaces'); store.emit('winds'); store.emit('env'); store.emit('road'); store.emit('perf'); store.emit('weather');
      PYR.app.refreshBindings();
      store.save();
    },

    /** Charge le parcours du défi et l'active. */
    load(ch) {
      store.state.activeChallenge = ch.id;
      CH.applyCourse(ch.course);
      store.emit('challenge', ch);
      store.save();
    },

    /** Transforme les résultats d'une course en direct en défi (pour la rejouer ou la partager). */
    fromRace({ title, creator, course, fair, rider, bike, rules, cps, feed, entries }) {
      const ch = {
        id: U.uid() + U.uid(), title: title || `Course de ${creator}`, createdAt: new Date().toISOString(),
        creator, fair: !!fair, rider: fair ? rider : undefined, bike: fair ? bike : undefined,
        rules: PYR.race.normRules(rules), cps: checkpointsOf(course, cps, rules), feed: feedOf(course, feed, rules), course, entries: entries.slice(),
      };
      ch.signature = R.courseSignature(course);
      persist(ch);
      CH.load(ch);
      return ch;
    },

    deactivate() {
      store.state.activeChallenge = null;
      store.save();
      store.emit('challenge', null);
    },

    remove(id) {
      delete store.state.challenges[id];
      cache.delete(id);
      if (store.state.activeChallenge === id) store.state.activeChallenge = null;
      store.save();
      store.emit('challenge', CH.active());
    },

    /** Ajoute un résultat au défi actif. */
    addEntry(entry) {
      const ch = CH.active();
      if (!ch) return null;
      ch.entries.push(entry);
      persist(ch);
      store.emit('challenge', ch);
      return ch;
    },

    /** Importe un défi reçu : fusion des résultats si on le connaît déjà. */
    importObject(obj) {
      if (!obj || obj.kind !== 'challenge' || !obj.course) throw new Error('Ce n\'est pas un défi PaceYourRide.');
      const incoming = unpackChallenge(obj);
      const known = get(incoming.id);
      let ch = incoming;
      let added = incoming.entries.length;
      if (known) {
        if (known.signature !== incoming.signature) throw new Error('Ce défi a le même identifiant qu\'un défi connu mais un parcours différent.');
        const ids = new Set(known.entries.map((e) => e.id));
        const fresh = incoming.entries.filter((e) => !ids.has(e.id));
        added = fresh.length;
        known.entries.push(...fresh);
        ch = known;
      }
      persist(ch);
      CH.load(ch);
      return { ch, added, merged: !!known };
    },

    /** Texte collé (lien, code ou JSON) → défi. */
    async importText(text) {
      const t = String(text || '').trim();
      if (!t) throw new Error('Rien à importer.');
      if (t.startsWith(C.CODE_PREFIX) || /#live=/.test(t)) throw new Error('C\'est un code de course en direct : utilise « Rejoindre une course ».');
      let obj;
      try {
        if (t.startsWith('{')) obj = JSON.parse(t);
        else {
          const m = t.match(/#defi=([A-Za-z0-9_-]+)/);
          obj = await C.unpackJson(m ? m[1] : t.replace(/\s+/g, ''));
        }
      } catch (e) {
        throw new Error('Défi illisible : vérifie que le code ou le fichier est complet.');
      }
      return CH.importObject(obj);
    },

    wire(ch) {
      return Object.assign({ app: 'PaceYourRide', kind: 'challenge', v: 1 }, packChallenge(ch));
    },

    async code(ch) { return C.packJson(CH.wire(ch)); },

    async link(ch) {
      const base = shareUrlBase();
      return base ? `${base}#defi=${await CH.code(ch)}` : null;
    },

    download(ch) {
      const name = String(ch.title || 'defi').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      D.download(`${name || 'defi'}.pyr.json`, JSON.stringify(CH.wire(ch)), 'application/json');
    },

    /** Fantômes du défi actif (les meilleurs temps), avec leurs temps de passage aux sprints et aux sommets. */
    ghosts() {
      const ch = CH.active();
      if (!ch || !CH.isCurrent(ch)) return [];
      return ch.entries.slice().sort((a, b) => a.time - b.time).slice(0, MAX_GHOSTS)
        .map((e, i) => ({ id: e.id, name: e.name, color: COLORS[i % COLORS.length], s: e.s, time: e.time, auto: e.auto, sp: Cl.entrySplits(ch.cps, e) }));
    },

    /** Points de passage du défi actif (sprints, sommets, arrivée). */
    checkpoints() {
      const ch = CH.active();
      return ch && CH.isCurrent(ch) ? ch.cps : null;
    },

    /** Zones de ravitaillement du défi actif. */
    feedZones() {
      const ch = CH.active();
      return ch && CH.isCurrent(ch) ? ch.feed : null;
    },

    /** Classements annexes d'un défi, sur tous ses résultats : {cps, sd, name(id)} ou null. */
    classif(ch) {
      if (!ch || !Cl.active(ch.cps) || !ch.entries.length) return null;
      const L = courseLength(ch.course);
      const sd = Cl.standings(ch.cps, ch.entries.map((e) => ({ id: e.id, splits: Cl.entrySplits(ch.cps, e), s: L })));
      const names = new Map(ch.entries.map((e) => [e.id, e.name]));
      return { cps: ch.cps, sd, name: (id) => names.get(id) || '?' };
    },

    /**
     * Règles du défi actif (incidents, forme du jour, alimentation, relais), fixées à sa création.
     * Les défis plus anciens se jouent sans ces nouveautés, pour rester comparables.
     */
    rules() {
      const ch = CH.active();
      if (!ch || !CH.isCurrent(ch)) return null;
      return ch.rules || { events: false, form: false, fuel: false, pullSec: 30 };
    },

    /** Réglages imposés (armes égales) : cycliste et vélo du créateur. */
    machine() {
      const ch = CH.active();
      if (!ch || !ch.fair || !CH.isCurrent(ch)) return null;
      return { rider: Object.assign({}, ch.rider, { name: store.state.rider.name }), bike: ch.bike, from: ch.creator };
    },

    /* ---------- interface (panneau du mode jeu) ---------- */
    render() {
      const box = $('#challenge-box');
      if (!box) return;
      D.clear(box);
      const ch = CH.active();
      if (ch) box.appendChild(renderActive(ch));
      else {
        box.appendChild(h('p', { class: 'hint' }, 'Lance un défi sur ton parcours : ton arrivée devient un fantôme que tes amis affrontent quand ils veulent, puis ils te renvoient le leur.'));
      }
      const tools = h('div', { class: 'toolbar' },
        h('button', { class: 'btn', onclick: openCreate }, ch ? 'Nouveau défi' : 'Créer un défi sur ce parcours'),
        h('button', { class: 'btn', onclick: openImport }, 'Ouvrir un défi reçu'));
      box.appendChild(tools);
      const others = CH.list().filter((x) => !ch || x.id !== ch.id);
      if (others.length) {
        const sel = h('select', { 'aria-label': 'Défis enregistrés' }, h('option', { value: '' }, 'Reprendre un défi enregistré…'),
          ...others.map((x) => h('option', { value: x.id }, `${x.title} (${x.entries.length} résultat${x.entries.length > 1 ? 's' : ''})`)));
        sel.addEventListener('change', () => { const x = get(sel.value); if (x) { CH.load(x); D.toast(`Défi « ${x.title} » chargé.`); } });
        box.appendChild(h('div', { class: 'field' }, sel));
      }
    },

    /** Au chargement de la page : lien #defi=… */
    async checkHash() {
      const m = location.hash.match(/^#defi=([A-Za-z0-9_-]+)/);
      if (!m) return false;
      history.replaceState(null, '', location.pathname + location.search);
      try {
        const obj = await C.unpackJson(m[1]);
        const n = (obj.entries || []).length;
        if (!confirm(`Ouvrir le défi « ${obj.title} » (${n} résultat${n > 1 ? 's' : ''}) ?\nTon parcours actuel sera remplacé par celui du défi.`)) return true;
        const r = CH.importObject(obj);
        PYR.app.showTab('game');
        D.toast(r.merged ? `Défi mis à jour : ${r.added} nouveau(x) résultat(s).` : `Défi « ${r.ch.title} » chargé : à toi de jouer !`);
      } catch (e) {
        D.toast('Lien de défi illisible : ' + e.message, 'error');
      }
      return true;
    },
  };

  /* ---------- rendu du défi actif ---------- */
  function renderActive(ch) {
    const current = CH.isCurrent(ch);
    const c = ch.course;
    const km = (c.step * (c.n - 1)) / 1000;
    let up = 0;
    for (let i = 1; i < c.n; i++) { const d = c.ele[i] - c.ele[i - 1]; if (d > 0) up += d / 100; }
    const wrap = h('div', { class: 'challenge' });
    wrap.appendChild(h('div', { class: 'challenge-head' },
      h('strong', null, ch.title),
      h('span', null, ` — lancé par ${ch.creator} · ${U.fmt(km, 1)} km · D+ ${U.fmt(up, 0)} m`),
      ch.fair ? h('span', { class: 'badge' }, 'armes égales') : null,
      ...[ch.rules && ch.rules.events && 'incidents', ch.rules && ch.rules.form && 'forme du jour', ch.rules && ch.rules.fuel && 'alimentation', ch.rules && ch.rules.physio && 'modèle physiologique',
        Cl.active(ch.cps) && `classements : ${CV.cpsText(ch.cps)}`]
        .filter(Boolean).map((x) => h('span', { class: 'badge' }, x))));
    if (!current) {
      wrap.appendChild(h('div', { class: 'note warn' }, 'Le parcours ou ses réglages ont changé : ce défi est en pause. ',
        h('button', { class: 'btn small', onclick: () => CH.load(ch) }, 'Recharger le parcours du défi'),
        ' ', h('button', { class: 'btn small ghost', onclick: () => CH.deactivate() }, 'Quitter le défi')));
    } else if (ch.fair) {
      wrap.appendChild(h('p', { class: 'hint' }, `Armes égales : tout le monde roule avec le cycliste et le vélo de ${ch.creator}.`));
    }
    const entries = ch.entries.slice().sort((a, b) => a.time - b.time);
    if (!entries.length) {
      wrap.appendChild(h('p', { class: 'hint' }, 'Aucun résultat pour l\'instant : fais ta course, ton arrivée sera ajoutée au classement.'));
    } else {
      const best = entries[0].time;
      const cl = CH.classif(ch);
      const worn = cl ? CV.holders(cl.sd, true) : new Map();
      const tb = h('tbody');
      entries.forEach((e, i) => {
        tb.appendChild(h('tr', null,
          h('td', null, String(i + 1)),
          h('td', null, i < MAX_GHOSTS ? h('span', { class: 'dot', style: { background: COLORS[i % COLORS.length] } }) : null, e.name, ' ', ...CV.jerseysOf(worn, e.id), e.auto ? h('span', { class: 'badge', title: 'Pilote automatique utilisé' }, 'auto') : null),
          h('td', null, U.fmtClock(e.time)),
          h('td', null, i ? U.fmtDelta(e.time - best) : '–'),
          h('td', null, U.fmt(e.avgP, 0) + ' W'),
          h('td', null, e.date ? new Date(e.date).toLocaleDateString() : '')));
      });
      wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'simple num leaderboard' },
        h('thead', null, h('tr', null, ...['#', 'Cycliste', 'Temps', 'Écart', 'P moy.', 'Date'].map((x) => h('th', null, x)))), tb)));
      // classements annexes : points (sprints et arrivée) et montagne, sur tous les résultats
      if (cl) {
        const det = h('details', { class: 'classif-details' }, h('summary', null, 'Classements par points et de la montagne'));
        det.appendChild(CV.block(cl.cps, cl.sd, { name: cl.name, full: true }));
        wrap.appendChild(det);
      }
    }
    wrap.appendChild(h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => openShare(ch) }, 'Partager le défi'),
      h('button', { class: 'btn ghost', onclick: () => CH.deactivate() }, 'Quitter'),
      h('button', { class: 'btn ghost danger', onclick: () => { if (confirm(`Supprimer le défi « ${ch.title} » et ses résultats ?`)) CH.remove(ch.id); } }, 'Supprimer')));
    return wrap;
  }

  /* ---------- fenêtres ---------- */
  function openCreate() {
    if (!store.profile) { D.toast('Trace d\'abord un parcours (onglet Parcours).', 'error'); return; }
    const title = h('input', { type: 'text', value: `Défi de ${riderName()}`, maxlength: '60' });
    const fair = h('input', { type: 'checkbox' });
    D.modal({
      title: 'Créer un défi',
      body: [
        h('p', { class: 'hint' }, 'Le parcours actuel (avec ses portions de vent et de revêtement, la température et les options de course) est figé : tous les participants rouleront exactement dans les mêmes conditions. Tes réglages de course du mode jeu (incidents, forme du jour, alimentation, durée des relais) s\'appliquent aussi à tous.'),
        h('div', { class: 'field' }, h('label', null, 'Nom du défi'), title),
        h('label', { class: 'check' }, fair, ' Armes égales : tout le monde roule avec mon cycliste et mon vélo'),
        store.state.rider.name ? null : h('div', { class: 'note warn' }, 'Astuce : donne-toi un nom (onglet Cycliste ou ci-dessous dans le mode jeu) pour qu\'il apparaisse au classement.'),
      ],
      actions: [
        { label: 'Annuler' },
        {
          label: 'Créer le défi', primary: true, onClick: () => {
            try {
              const ch = CH.create({ title: title.value, fair: fair.checked });
              D.toast(`Défi « ${ch.title} » créé : fais ta course, puis partage-le.`);
            } catch (e) { D.toast(e.message, 'error'); return false; }
            return true;
          },
        },
      ],
    });
  }

  function openImport() {
    const area = h('textarea', { rows: '4', placeholder: 'Colle ici le lien ou le code du défi' });
    const file = h('input', { type: 'file', accept: '.json,application/json' });
    const status = h('div', { class: 'status-line' });
    const m = D.modal({
      title: 'Ouvrir un défi reçu',
      body: [
        h('p', { class: 'hint' }, 'Ton parcours actuel sera remplacé par celui du défi. Si tu connais déjà ce défi, les nouveaux résultats sont ajoutés au classement.'),
        h('div', { class: 'field' }, h('label', null, 'Lien ou code'), area),
        h('div', { class: 'field' }, h('label', null, 'ou fichier .pyr.json'), file),
        status,
      ],
      actions: [
        { label: 'Annuler' },
        {
          label: 'Ouvrir', primary: true, onClick: async () => {
            try {
              let r;
              if (file.files[0]) r = CH.importObject(JSON.parse(await D.readFile(file.files[0])));
              else r = await CH.importText(area.value);
              D.toast(r.merged ? `Défi mis à jour : ${r.added} nouveau(x) résultat(s).` : `Défi « ${r.ch.title} » chargé.`);
              return true;
            } catch (e) {
              status.textContent = 'Import impossible : ' + e.message;
              status.classList.add('error');
              return false;
            }
          },
        },
      ],
    });
    return m;
  }

  async function openShare(ch) {
    const code = await CH.code(ch);
    const link = await CH.link(ch);
    const text = link || code;
    const out = h('textarea', { rows: '4', readonly: true }, text);
    const size = h('p', { class: 'hint' });
    size.textContent = link
      ? `Lien de ${U.fmt(text.length / 1000, 1)} k caractères. Si ta messagerie le coupe, envoie plutôt le fichier.`
      : 'L\'application est ouverte depuis un fichier local : envoie ce code (à coller dans « Ouvrir un défi reçu ») ou le fichier. Pour partager un lien cliquable, héberge l\'application (GitHub Pages, par exemple).';
    D.modal({
      title: `Partager « ${ch.title} »`,
      body: [
        h('p', { class: 'hint' }, `Le défi contient le parcours et ${ch.entries.length} résultat${ch.entries.length > 1 ? 's' : ''}. Tes amis l'ouvrent, font leur course, puis te renvoient le défi : les classements fusionnent.`),
        out, size,
      ],
      actions: [
        { label: 'Fermer' },
        { label: 'Télécharger le fichier', onClick: () => { CH.download(ch); return false; } },
        { label: link ? 'Copier le lien' : 'Copier le code', primary: true, onClick: async () => { await D.copy(text); D.toast('Copié dans le presse-papiers.'); return false; } },
      ],
    });
  }

  store.on('challenge', () => CH.render());
  ['profile', 'surfaces', 'winds', 'env', 'road', 'perf'].forEach((e) => store.on(e, () => CH.render()));

  PYR.challenges = CH;
})(globalThis.PYR = globalThis.PYR || {});
