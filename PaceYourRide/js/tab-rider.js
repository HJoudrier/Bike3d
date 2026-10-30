/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Athlète (athlete.html) : morphologie, intestin, seuils, courbe de puissance record, zones de
 * puissance et niveau par rapport à des valeurs de référence publiées (la courbe remplace la carte). */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, Ph = PYR.physics, Pz = PYR.physio;
  const { h, $ } = D;

  let chart = null;
  const inputs = {};

  const T = {
    init() {
      // le nom du cycliste tient lieu de titre de la page ; le crayon le transforme en champ de saisie (Entrée ou clic ailleurs : terminé, Échap : annuler)
      const nameIn = $('#r-name'), title = $('#rider-title'), pen = $('#btn-rename-rider');
      let before = '';
      const showTitle = () => { title.textContent = String(store.state.rider.name || '').trim() || 'Profil du cycliste'; };
      const edit = (on) => { nameIn.hidden = !on; title.hidden = on; pen.hidden = on; };
      pen.addEventListener('click', () => { before = nameIn.value; edit(true); nameIn.focus(); nameIn.select(); });
      nameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') nameIn.blur();
        else if (e.key === 'Escape') { nameIn.value = before; nameIn.blur(); }
      });
      nameIn.addEventListener('blur', () => { edit(false); showTitle(); });
      ['name', 'rider'].forEach((e) => store.on(e, showTitle));
      showTitle();

      // photo d'avatar : choisie, recadrée au centre en carré (js/core/avatar.js), enregistrée dans le profil sans relancer les calculs
      const avPrev = $('#r-avatar-preview'), avFile = $('#r-avatar-file'), avDel = $('#btn-avatar-del'), avBtn = $('#btn-avatar');
      const showAvatar = () => {
        const url = PYR.avatar.get();
        avPrev.style.backgroundImage = url ? `url("${url}")` : '';
        avPrev.classList.toggle('has-photo', !!url);
        avPrev.textContent = url ? '' : '🚴';
        avDel.hidden = !url;
        avBtn.textContent = url ? 'Changer la photo' : 'Ajouter une photo';
      };
      avBtn.addEventListener('click', () => avFile.click());
      avPrev.addEventListener('click', () => avFile.click());
      avFile.addEventListener('change', async () => {
        const f = avFile.files && avFile.files[0];
        avFile.value = '';
        if (!f) return;
        try { store.set('rider.avatar', await PYR.avatar.fromFile(f), true); showAvatar(); D.toast('Photo enregistrée : elle apparaît dans le mode course.'); }
        catch (e) { D.toast(e.message || 'Photo illisible.', 'error'); }
      });
      avDel.addEventListener('click', () => { store.set('rider.avatar', '', true); showAvatar(); });
      store.on('rider', showAvatar);
      showAvatar();

      // date de naissance : l'âge s'en déduit (et se recalcule à chaque ouverture) ; sans date, l'âge enregistré reste utilisé
      const birth = $('#r-birth'), ageNote = $('#r-age-note');
      const d = new Date(), p2 = (x) => String(x).padStart(2, '0');
      birth.max = `${d.getFullYear() - 8}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      const showAge = () => {
        const r = store.state.rider, a = U.ageFrom(r.birthDate);
        ageNote.textContent = a !== null ? `${a} an${a > 1 ? 's' : ''}` : `Âge supposé : ${Number(r.age) || 35} ans — renseigne ta date de naissance.`;
      };
      store.on('rider', showAge);
      showAge();

      // « Enregistrer » : l'athlète du projet entre dans la bibliothèque de l'accueil sous son nom (sans nom : « Athlète #date-heure ») ;
      // si ce nom existe déjà, on demande avant d'écraser. Tant qu'on n'enregistre pas, la bibliothèque ne bouge pas.
      $('#btn-save-rider').addEventListener('click', () => {
        const Lib = PYR.library;
        let name = String(store.state.rider.name || '').trim();
        if (!name) { name = Lib.defaultAthleteName(); nameIn.value = name; store.set('rider.name', name); showTitle(); }
        try {
          let raw = null;
          try { raw = JSON.parse(localStorage.getItem(Lib.STORAGE_KEY)); } catch (e) { /* bibliothèque illisible : on repart d'une vide */ }
          const lib = Lib.normalize(raw), data = Lib.extract('athlete', store.state);
          let r = Lib.save(lib, 'athlete', name, data);
          if (r.exists) {
            if (!confirm(`« ${r.exists.name} » existe déjà dans ta bibliothèque. Veux-tu vraiment l'écraser ?`)) return;
            r = Lib.save(lib, 'athlete', name, data, Date.now(), true);
          }
          localStorage.setItem(Lib.STORAGE_KEY, JSON.stringify(lib));
          D.toast(`« ${r.item.name} » ${r.replaced ? 'mis à jour dans' : 'enregistré dans'} ta bibliothèque (page d'accueil › Sélectionner un athlète).`);
        } catch (e) { D.toast('Enregistrement impossible : stockage du navigateur indisponible.', 'error'); }
      });

      D.fillSelect($('#r-gut'), PYR.fuel.GUT_LEVELS.map((l) => ({ id: String(l.value), label: l.label })), String(store.state.rider.gut));

      // tableau des records
      const tbody = $('#records-table tbody');
      for (const d of Pz.DURATIONS) {
        const inp = h('input', { type: 'number', min: '10', max: '3000', step: '1', class: 'estimated', 'aria-label': `Record ${Pz.durationLabel(d)} (W)` });
        inp.addEventListener('change', () => {
          const v = Number(inp.value);
          const rec = store.state.rider.records;
          if (inp.value === '' || !(v > 0)) delete rec[d]; else rec[d] = Math.round(v);
          store.emit('rider', { path: 'rider.records' });
          store.save();
        });
        inputs[d] = inp;
        tbody.appendChild(h('tr', { 'data-d': d },
          h('td', null, Pz.durationLabel(d)), h('td', null, inp), h('td', { class: 'wkg' }), h('td', { class: 'model' })));
      }

      // échelle des durées de la courbe : logarithmique (défaut) ou linéaire (vraie échelle de temps), mémorisée
      const scale = store.state.ui.curveScale === 'lin' ? 'lin' : 'log';
      const yscale = store.state.ui.curveYScale === 'lin' ? 'lin' : 'log';
      chart = new PYR.charts.CurveChart($('#curve-chart'), { scale, yscale });
      // sélecteurs d'échelle : durées (attribut data-curvescale) et puissances (data-curveyscale)
      const bindScale = (attr, current, apply, key) => {
        const buttons = D.$$(`[${attr}]`), prop = attr.slice(5);   // data-curvescale → curvescale
        const press = (mode) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[prop] === mode)));
        press(current);
        buttons.forEach((b) => b.addEventListener('click', () => {
          apply(b.dataset[prop]);
          press(b.dataset[prop]);
          store.set(key, b.dataset[prop], true);
        }));
      };
      bindScale('data-curvescale', scale, (m) => chart.setScale(m), 'ui.curveScale');
      bindScale('data-curveyscale', yscale, (m) => chart.setYScale(m), 'ui.curveYScale');

      $('#btn-fit-cp').addEventListener('click', () => {
        const r = store.state.rider;
        const curve = Pz.buildCurve(r.records, Number(r.ftp) || 0);
        const fit = Pz.fitCpWprime(curve.fn);
        store.set('rider.cp', Math.round(fit.cp), true);
        store.set('rider.wPrime', +(fit.wPrime / 1000).toFixed(1));
        $('#r-cp').value = store.state.rider.cp;
        $('#r-wprime').value = store.state.rider.wPrime;
        D.toast(`CP2 ${Math.round(fit.cp)} W et W′ ${U.fmt(fit.wPrime / 1000, 1)} kJ calculés depuis la courbe (modèle travail–temps, 3 à 20 min).`);
      });
      $('#btn-curve-from-ftp').addEventListener('click', () => {
        const ftp = Number(store.state.rider.ftp);
        if (!(ftp > 0)) { D.toast('Renseigne d\'abord ta FTP', 'error'); return; }
        const has = Object.keys(store.state.rider.records).length;
        if (has && !confirm('Remplacer les records saisis par une courbe type calculée depuis la FTP ?')) return;
        store.state.rider.records = Pz.curveFromFtp(ftp);
        store.emit('rider', { path: 'rider.records' });
        store.save();
      });
      $('#btn-clear-records').addEventListener('click', () => {
        if (!Object.keys(store.state.rider.records).length) return;
        if (!confirm('Effacer tous les records saisis ?')) return;
        store.state.rider.records = {};
        store.emit('rider', { path: 'rider.records' });
        store.save();
      });

      // profil : export vers un fichier et chargement d'un profil enregistré
      $('#btn-export-rider').addEventListener('click', () => {
        const slug = String(store.state.rider.name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        D.download(`profil-${slug || 'cycliste'}.pyr-profil.json`, store.exportRider(), 'application/json');
        D.toast('Profil enregistré dans un fichier.');
      });
      $('#input-import-rider').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
          const obj = JSON.parse(await D.readFile(f));
          const who = obj && obj.rider && typeof obj.rider.name === 'string' && obj.rider.name ? ` « ${obj.rider.name.slice(0, 30)} »` : '';
          if (!(obj && obj.rider && typeof obj.rider === 'object')) throw new Error('Fichier de profil invalide');
          if (!confirm(`Charger le profil${who} ? Il remplace le profil actuel (le parcours et le vélo sont conservés).`)) return;
          store.importRider(obj);
          PYR.app.refreshBindings();
          D.toast(`Profil${who} chargé.`);
        } catch (err) { D.toast('Chargement impossible : ' + (err instanceof SyntaxError ? 'ce n\'est pas un fichier JSON' : err.message), 'error'); }
      });

      if (PYR.riderPhysio) PYR.riderPhysio.init();   // modèle physiologique : carte athlète, substrats, recrutement, sortie simulée
      store.on('rider', () => T.render());
      T.render();
    },

    onShow() { if (chart) chart.surface.request(); if (PYR.riderPhysio) PYR.riderPhysio.onShow(); },

    render() {
      const r = store.state.rider;
      const ath = Pz.buildAthlete(r);
      const w = Number(r.weight) || 72;
      const mc = PYR.metabo.card(r, ath);   // signature du modèle physiologique : CP1, CP2, W′, Pmax
      const model = (d) => (mc.Pmax > mc.CP2 ? mc.CP2 + ath.w0 / (d + ath.w0 / (mc.Pmax - mc.CP2)) : ath.cp + ath.w0 / d);
      // tableau
      Pz.DURATIONS.forEach((d, i) => {
        const inp = inputs[d];
        const user = r.records[d];
        if (document.activeElement !== inp) inp.value = user ? user : '';
        inp.placeholder = String(Math.round(ath.curve.values[i]));
        const row = inp.closest('tr');
        const p = user || ath.curve.values[i];
        row.querySelector('.wkg').textContent = U.fmt(p / w, 2);
        row.querySelector('.model').textContent = U.fmt(model(d), 0) + ' W';
      });
      const bench = T.benchmarks(r, ath, w);
      chart.setData({
        durations: Pz.DURATIONS,
        user: Pz.DURATIONS.map((d) => Number(r.records[d]) || null),
        curve: ath.mmp, cp: ath.cp, cp1: mc.CP1, pmax: mc.Pmax, w0: ath.w0, ftp: ath.ftp,
        weight: w, zones: bench.zones,
        markers: bench.efforts.map((x) => ({ s: x.e.dur, p: x.p, title: `${x.e.label} · ${U.fmt(x.wkg, 2)} W/kg`, sub: x.c.level.label, color: x.c.level.color })),
      });
      T.renderZones(bench.zones, ath, w);
      T.renderLevels(bench.efforts, w);
      T.renderReference(bench, w);
      $('#bench-sex').textContent = bench.sex === 'f' ? 'Références : femmes (à changer dans le profil)' : 'Références : hommes (à changer dans le profil)';
      // seuils : valeur estimée en gris et source sous chaque champ, comme CP1 et les autres champs de la carte athlète
      const ftpEst = Pz.estimateFtp(r.records) || ath.mmp(3600);
      [['cp', ath.fit.cp, 0, ath.cpSource], ['wprime', ath.fit.wPrime / 1000, 1, ath.w0Source],
        ['pmax', ath.mmp(1), 0, ath.pmaxSource], ['ftp', ftpEst, 0, ath.ftpSource]].forEach(([k, est, dec, src]) => {
        const inp = $('#r-' + k);
        inp.placeholder = U.fmt(est, dec);
        inp.classList.toggle('estimated', src !== 'saisie');
        $(`#r-${k}-src`).textContent = src === 'saisie' ? 'saisie' : `estimée : ${U.fmt(est, dec)}`;
      });
      // note du modèle
      const note = $('#rider-model-note');
      D.clear(note);
      note.appendChild(h('div', null, 'En W/kg : ',
        h('strong', null, `CP1 ${U.fmt(mc.CP1 / w, 2)}`), ' · ', h('strong', null, `CP2 ${U.fmt(ath.cp / w, 2)}`), ' · ',
        h('strong', null, `Pmax ${U.fmt(ath.pmax / w, 1)}`), ' · ', h('strong', null, `FTP ${U.fmt(ath.ftp / w, 2)}`), '.'));
      note.appendChild(h('div', null, `Récupération du W′ : ×${U.fmt(ath.recF, 2)} (âge ${Number(r.age) || 35} ans). ${ath.curve.nUser} record${ath.curve.nUser > 1 ? 's' : ''} saisi${ath.curve.nUser > 1 ? 's' : ''}.`));
      const warn = [];
      if (ath.cp > ath.mmp(1200) * 1.02) warn.push('ta CP2 dépasse ton record sur 20 min');
      if (ath.pmax < ath.cp * 1.5) warn.push('ta Pmax est à peine supérieure à ta CP2');
      if (model(300) < ath.mmp(300) * 0.9) warn.push('le modèle CP1/CP2/W′/Pmax sous-estime nettement ton record 5 min');
      if (ath.ftp > ath.mmp(1200)) warn.push('ta FTP dépasse ton record 20 min');
      note.classList.toggle('warn', warn.length > 0);
      if (warn.length) note.appendChild(h('div', null, 'À vérifier : ' + warn.join(' ; ') + '. La simulation retient toujours la contrainte la plus stricte.'));
      T.renderGut();
      if (PYR.riderPhysio) PYR.riderPhysio.render();
    },

    /** Zones de puissance (d'après la FTP) et niveau de chaque effort de référence. */
    benchmarks(r, ath, w) {
      const B = PYR.bench, sex = r.sex === 'f' ? 'f' : 'm', heat = PYR.map.HEAT;
      const zones = B.zones(ath.ftp, ath.pmax).map((z, i) => Object.assign(z, { color: heat[i] }));
      const efforts = B.EFFORTS.map((e) => {
        const p = e.id === 'ftp' ? ath.ftp : ath.mmp(e.dur);
        const wkg = p / w;
        return { e, p, wkg, c: B.classify(sex, e.id, wkg), estimated: e.id !== 'ftp' && !r.records[e.dur] };
      });
      return { sex, zones, efforts };
    },

    renderZones(zones, ath, w) {
      const tb = $('#zone-table tbody');
      D.clear(tb);
      for (const z of zones) {
        const last = z.to === Infinity;
        const pct = last ? `> ${U.fmt(z.from * 100, 0)} %` : `${U.fmt(z.from * 100, 0)}–${U.fmt(z.to * 100, 0)} %`;
        const watts = last ? `> ${U.fmt(z.lo, 0)}` : `${U.fmt(z.lo, 0)}–${U.fmt(z.hi, 0)}`;
        const kg = last ? `> ${U.fmt(z.lo / w, 1)}` : `${U.fmt(z.lo / w, 1)}–${U.fmt(z.hi / w, 1)}`;
        tb.appendChild(h('tr', null,
          h('td', null, h('i', { class: 'swatch', style: { background: z.color } }), `${z.id} ${z.label}`),
          h('td', null, pct), h('td', null, watts + ' W'), h('td', null, kg), h('td', null, z.use)));
      }
    },

    renderLevels(efforts, w) {
      const box = $('#level-cards');
      D.clear(box);
      for (const x of efforts) {
        const { c, e } = x;
        const next = c.next
          ? `Encore ${U.fmt(c.next.wkg - x.wkg, 2)} W/kg (+${U.fmt((c.next.wkg - x.wkg) * w, 0)} W) pour « ${c.next.level.label} »`
          : 'Niveau le plus élevé de la table';
        box.appendChild(h('div', { class: 'level-card', style: { '--lvl': c.level.color } },
          h('div', { class: 'lc-head' }, h('b', null, e.label), h('span', null, e.what)),
          h('div', { class: 'lc-value' }, U.fmt(x.wkg, 2), ' ', h('small', null, 'W/kg')),
          h('div', { class: 'lc-watts' }, `${U.fmt(x.p, 0)} W `, x.estimated ? h('span', { class: 'tag-est' }, '(estimé, pas de record saisi)') : null),
          h('div', { class: 'lc-level' }, c.level.label),
          h('div', { class: 'lc-who' }, c.level.who),
          h('div', { class: 'lc-bar', title: next }, h('i', { style: { width: Math.round(c.progress * 100) + '%' } })),
          h('div', { class: 'lc-next' }, next)));
      }
    },

    /** Tableau des seuils de chaque niveau, avec ta ligne et la case de ton niveau en évidence. */
    renderReference(bench, w) {
      const B = PYR.bench;
      const head = $('#ref-table thead'), body = $('#ref-table tbody');
      D.clear(head); D.clear(body);
      head.appendChild(h('tr', null, h('th', { scope: 'col' }, 'Niveau'),
        ...B.EFFORTS.map((e) => h('th', { scope: 'col' }, e.label + (e.derived ? ' *' : '')))));
      body.appendChild(h('tr', { class: 'me-row' }, h('td', null, `Toi (${U.fmt(w, 0)} kg)`),
        ...bench.efforts.map((x) => h('td', { class: 'me' }, U.fmt(x.wkg, 2), h('small', null, x.c.level.label)))));
      const ths = B.EFFORTS.map((e) => B.thresholds(bench.sex, e.id));
      B.LEVELS.forEach((lv, i) => {
        body.appendChild(h('tr', null,
          h('td', null, lv.label, h('small', null, lv.who)),
          ...ths.map((th, k) => h('td', { class: bench.efforts[k].c.index === i ? 'me' : '' }, '≥ ' + U.fmt(th[i], 2), h('small', null, U.fmt(th[i] * w, 0) + ' W')))));
      });
      const el = $('#bench-sources');
      D.clear(el);
      el.appendChild(h('span', null,
        'Seuils : Hunter Allen et Andrew Coggan, « Training and Racing with a Power Meter » (VeloPress, 2010), profil de puissance sur 5 s, 1 min, 5 min et FTP, ',
        bench.sex === 'f' ? 'femmes' : 'hommes', '. * Valeurs déduites, absentes de la table : 15 s interpolée entre les seuils à 5 s et à 1 min ; 3 min interpolée entre ceux à 1 min et à 5 min ; 20 min = FTP ÷ 0,95. ',
        'Les correspondances avec les catégories de course sont indicatives. Repère chez les professionnels (Valenzuela et al., Int J Sports Physiol Perform, 2022 ; 144 coureurs de 7 équipes WorldTour et ProTeam) : de 5,5 à 6,6 W/kg sur 20 min (du 10ᵉ au 90ᵉ centile).'));
    },

    /** Plafonds d'absorption de l'intestin choisi. */
    renderGut() {
      const c = PYR.fuel.caps(store.state.rider.gut);
      $('#r-gut-hint').textContent = `Glucose seul : ${U.fmt(c.glucose, 0)} g/h au plus (voie SGLT1) ; avec du fructose en plus (gels et boissons double source) : ${U.fmt(c.mix, 0)} g/h (voie GLUT5 : ${U.fmt(c.fructose, 0)} g/h).`;
    },
  };

  PYR.tabRider = T;
})(globalThis.PYR = globalThis.PYR || {});
