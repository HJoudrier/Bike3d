/* author : Hugo Joudrier-Faure */
/* PaceYourRide — page Équipements (PaceYourRide/equipement.html) : vélo (masse, aérodynamisme, roulement, transmission), tenue et position du cycliste + synthèse. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, store = PYR.store, Ph = PYR.physics;
  const { h, $ } = D;

  const T = {
    init() {
      const b = store.state.bike, r = store.state.rider;
      D.fillSelect($('#r-position'), Ph.POSITIONS, r.position);
      D.fillSelect($('#r-helmet'), Ph.HELMETS, r.helmet);
      D.fillSelect($('#r-clothing'), Ph.CLOTHING, r.clothing);
      D.fillSelect($('#r-glasses'), Ph.GLASSES, r.glasses);
      D.fillSelect($('#r-socks'), Ph.SOCKS, r.socks);
      D.fillSelect($('#r-shave'), Ph.SHAVE, r.shave);
      D.fillSelect($('#b-frame'), Ph.FRAMES, b.frame);
      D.fillSelect($('#b-wheels'), Ph.WHEELS, b.wheels);
      D.fillSelect($('#b-tire'), Ph.TIRES.map((t) => ({ id: t.id, label: t.crr ? `${t.label} — Crr ${U.fmt(t.crr, 4)}` : t.label })), b.tire);
      D.fillSelect($('#b-drivetrain'), Ph.DRIVETRAINS.map((t) => ({ id: t.id, label: t.eff ? `${t.label} — ${U.fmt(t.eff * 100, 1)} %` : t.label })), b.drivetrain);
      D.fillSelect($('#b-shoes'), Ph.SHOES.map((x) => ({ id: x.id, label: `${x.label} — ${U.fmt(x.k * 100, 1)} % transmis` })), b.shoes);
      $('#btn-save-bike').addEventListener('click', () => T.saveToLibrary('bike'));
      $('#btn-save-outfit').addEventListener('click', () => T.saveToLibrary('outfit'));
      store.on('bike', () => T.render());
      store.on('rider', () => T.render());
      T.render();
    },

    /** « Enregistrer » : le vélo ou la tenue du projet entre dans la bibliothèque de l'accueil sous son nom (sans nom : un nom par défaut) ;
     *  si ce nom existe déjà, on demande avant d'écraser. Tant qu'on n'enregistre pas, la bibliothèque ne bouge pas. */
    saveToLibrary(kind) {
      const Lib = PYR.library, st = store.state;
      const field = kind === 'bike' ? { obj: st.bike, key: 'name', input: $('#b-name'), dflt: 'Mon vélo' } : { obj: st.rider, key: 'outfitName', input: $('#r-outfit-name'), dflt: 'Ma tenue' };
      let name = String(field.obj[field.key] || '').trim();
      if (!name) { name = field.dflt; field.obj[field.key] = name; field.input.value = name; store.save(); }
      try {
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(Lib.STORAGE_KEY)); } catch (e) { /* bibliothèque illisible : on repart d'une vide */ }
        const lib = Lib.normalize(raw), data = Lib.extract(kind, st);
        let r = Lib.save(lib, kind, name, data);
        if (r.exists) {
          if (!confirm(`« ${r.exists.name} » existe déjà dans ta bibliothèque. Veux-tu vraiment l'écraser ?`)) return;
          r = Lib.save(lib, kind, name, data, Date.now(), true);
        }
        localStorage.setItem(Lib.STORAGE_KEY, JSON.stringify(lib));
        D.toast(`« ${r.item.name} » ${r.replaced ? 'mis à jour dans' : 'enregistré dans'} ta bibliothèque (page d'accueil › Sélectionner ${kind === 'bike' ? 'un vélo' : 'une tenue'}).`);
      } catch (e) { D.toast('Enregistrement impossible : stockage du navigateur indisponible.', 'error'); }
    },

    render() {
      const b = store.state.bike;
      $('#b-crr-field').hidden = b.tire !== 'custom';
      $('#b-eff-field').hidden = b.drivetrain !== 'custom';
      const s = Ph.buildSetup(store.state.rider, b);

      // CdA du cycliste d'après sa position
      const pos = Ph.POSITIONS.find((p) => p.id === store.state.rider.position) || Ph.POSITIONS[3];
      const note = $('#rider-aero-note');
      D.clear(note);
      note.appendChild(h('div', null,
        `Surface frontale de référence ${U.fmt(s.aRef, 3)} m² × ${U.fmt(pos.factor, 2)} (position) → CdA cycliste `,
        h('strong', null, U.fmt(s.cdaParts[0].v, 3) + ' m²'),
        `. CdA total avec le vélo : ${U.fmt(s.cda, 3)} m²${s.cdaOverride ? ' (valeur mesurée)' : ''}.`));

      const stats = $('#setup-stats');
      D.clear(stats);
      stats.appendChild(D.stat('Masse totale', U.fmt(s.mass, 1), 'kg'));
      stats.appendChild(D.stat('Masse équivalente (inertie)', U.fmt(s.massEff, 1), 'kg'));
      stats.appendChild(D.stat('CdA total', U.fmt(s.cda, 3), 'm²'));
      stats.appendChild(D.stat('Crr (asphalte)', U.fmt(s.crr, 4)));
      stats.appendChild(D.stat('Rendement transmission', U.fmt(s.eta * 100, 1), '%'));
      stats.appendChild(D.stat('Pédalage jusqu\'à', U.fmt(s.vSpin * 3.6, 0), 'km/h'));

      // détail du CdA
      const cda = $('#cda-table');
      D.clear(cda);
      cda.appendChild(h('thead', null, h('tr', null, h('th', null, 'Contribution aérodynamique'), h('th', { style: { textAlign: 'right' } }, 'CdA (m²)'))));
      const tb = h('tbody');
      for (const p of s.cdaParts) {
        tb.appendChild(h('tr', null, h('td', null, p.label), h('td', { style: { textAlign: 'right' } }, (p.v > 0 && p !== s.cdaParts[0] ? '+' : '') + U.fmt(p.v, 3))));
      }
      tb.appendChild(h('tr', null, h('td', null, h('strong', null, s.cdaOverride ? 'Total estimé (remplacé par ta mesure)' : 'Total')), h('td', { style: { textAlign: 'right' } }, h('strong', null, U.fmt(s.cdaEstimated, 3)))));
      cda.appendChild(tb);

      // puissance → vitesse (air calme, 20 °C, altitude 200 m)
      const rho = Ph.airDensity(200, 20);
      const ath = PYR.physio.buildAthlete(store.state.rider);
      const powers = [150, 200, 250, 300].concat(Math.round(ath.ftp)).filter((x, i, a) => a.indexOf(x) === i).sort((x, y) => x - y);
      const grades = [[0, 'Plat'], [0.03, '3 %'], [0.06, '6 %'], [0.09, '9 %']];
      const st = $('#speed-table');
      D.clear(st);
      st.classList.add('num');
      st.appendChild(h('thead', null, h('tr', null, h('th', null, 'Vitesse (km/h)'), ...grades.map((g) => h('th', null, g[1])))));
      const body = h('tbody');
      for (const P of powers) {
        body.appendChild(h('tr', null, h('td', null, `${P} W${P === Math.round(ath.ftp) ? ' (FTP)' : ''}`),
          ...grades.map((g) => h('td', null, U.fmt(Ph.steadySpeed(s, P, g[0], 1, rho, 0, 0) * 3.6, 1)))));
      }
      st.appendChild(body);
    },
  };

  PYR.tabBike = T;
})(globalThis.PYR = globalThis.PYR || {});
