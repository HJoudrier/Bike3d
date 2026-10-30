/* author : Hugo Joudrier-Faure */
/* PaceYourRide — affichage des classements annexes (mode jeu, défis, course en direct) :
 * maillots, pastilles des points de passage, tableau des passages, classements par points et de la montagne. */
(function (PYR) {
  'use strict';

  const U = PYR.util, D = PYR.dom, Cl = PYR.classif;
  const { h } = D;

  const JERSEYS = {
    yellow: 'Maillot jaune : en tête de la course',
    green: 'Maillot vert : premier du classement par points',
    kom: 'Maillot à pois : meilleur grimpeur',
  };

  const ordinal = (r) => (r === 1 ? '1ᵉʳ' : `${r}ᵉ`);
  const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
  /** Écart de passage : au dixième sous 10 s, puis en minutes. */
  const gapText = (g) => (g < 0.05 ? '' : g < 10 ? `+${U.fmt(g, 1)} s` : U.fmtDelta(g));

  /** Pastille de maillot. */
  function jersey(kind) {
    return h('span', { class: 'jersey ' + kind, title: JERSEYS[kind], role: 'img', 'aria-label': JERSEYS[kind] });
  }

  /** Pastille d'un point de passage : S (sprint), 4…1 ou HC (côte), A (arrivée). */
  function cpBadge(cp) {
    const text = cp.type === 'sprint' ? 'S' : cp.type === 'kom' ? (cp.cat === 'hc' ? 'HC' : cp.cat) : 'A';
    return h('span', { class: 'cp-badge ' + cp.type, 'aria-hidden': 'true' }, text);
  }

  /** Maillots portés : id → ['yellow', 'green', 'kom'] (le jaune au premier du général, si demandé). */
  function holders(sd, withYellow) {
    const m = new Map();
    const add = (id, k) => { if (!m.has(id)) m.set(id, []); m.get(id).push(k); };
    if (withYellow && sd.general.length) add(sd.general[0].id, 'yellow');
    if (sd.points.length) add(sd.points[0].id, 'green');
    if (sd.kom.length) add(sd.kom[0].id, 'kom');
    return m;
  }

  /** Pastilles des maillots d'un coureur. */
  function jerseysOf(map, id) { return (map.get(id) || []).map(jersey); }

  /** Leaders des classements par points et de la montagne, et ta place. name(id) → nom. */
  function leaders(cps, sd, name, meId) {
    const part = (list, kind, label) => {
      const lead = list[0], me = list.find((x) => x.id === meId);
      return h('div', { class: 'classif-lead' }, jersey(kind), h('span', null, `${label} : `),
        lead ? h('strong', null, `${name(lead.id)}, ${pts(lead.pts)}`) : h('span', { class: 'muted' }, 'personne pour l\'instant'),
        me && me !== lead ? h('span', { class: 'muted' }, ` · toi ${ordinal(me.rank)}, ${pts(me.pts)}`) : null);
    };
    return h('div', { class: 'classif-leads' },
      part(sd.points, 'green', 'Points'),
      cps.some((c) => c.type === 'kom') ? part(sd.kom, 'kom', 'Montagne') : null);
  }

  /**
   * Tableau des passages : pour chaque point, le premier passé puis ton rang, ton écart et tes points
   * (ou, sans « toi », le deuxième et son écart).
   */
  function passages(cps, sd, name, meId) {
    const withMe = meId !== undefined && meId !== null;
    const tb = h('tbody');
    cps.forEach((cp, k) => {
      const ps = sd.passages[k], first = ps[0];
      const other = withMe ? ps.find((p) => p.id === meId) : ps[1];
      const cell = other ? [withMe ? ordinal(other.rank) : name(other.id), gapText(other.gap), withMe && other.pts ? pts(other.pts) : ''].filter(Boolean).join(' · ') : '–';
      tb.appendChild(h('tr', { title: Cl.longLabel(cp, cps) + (cp.type === 'kom' ? ' : ' + Cl.climbText(cp) : '') },
        h('td', null, cpBadge(cp), ' ', Cl.shortLabel(cp, cps)),
        h('td', null, U.fmt(cp.s / 1000, 1)),
        h('td', null, first ? `${name(first.id)}${first.pts ? ` (${first.pts})` : ''}` : '–'),
        h('td', null, cell)));
    });
    return h('div', { class: 'table-wrap' }, h('table', { class: 'simple num classif-table' },
      h('thead', null, h('tr', null, ...['Point', 'km', 'En tête', withMe ? 'Toi' : '2ᵉ'].map((x) => h('th', null, x)))), tb));
  }

  /** Classement complet (points ou montagne). */
  function table(list, name, meId, kind) {
    if (!list.length) return h('p', { class: 'hint' }, 'Aucun point marqué.');
    const tb = h('tbody');
    for (const x of list) {
      tb.appendChild(h('tr', { class: x.id === meId ? 'me' : '' },
        h('td', null, String(x.rank)),
        h('td', null, x.rank === 1 ? jersey(kind) : null, name(x.id), x.id === meId ? ' (toi)' : ''),
        h('td', null, String(x.pts))));
    }
    return scrollable(h('div', { class: 'table-wrap' }, h('table', { class: 'simple num leaderboard' },
      h('thead', null, h('tr', null, ...['#', 'Cycliste', 'Points'].map((x) => h('th', null, x)))), tb)), list.length);
  }

  /** Longue liste (gros peloton) : le tableau défile dans son cadre ; la ligne « toi » est amenée en vue. */
  function scrollable(wrap, rows) {
    if (rows <= 12) return wrap;
    wrap.classList.add('scroll');
    requestAnimationFrame(() => {
      const me = wrap.querySelector('tr.me');
      if (me && me.offsetTop > wrap.clientHeight - 40) wrap.scrollTop = me.offsetTop - wrap.clientHeight / 2;
    });
    return wrap;
  }

  /**
   * Bloc complet : leaders, passages et, si demandé, les classements détaillés.
   * opts : {name(id), meId (facultatif), full}
   */
  function block(cps, sd, opts) {
    const wrap = h('div', { class: 'classif' });
    wrap.appendChild(leaders(cps, sd, opts.name, opts.meId));
    wrap.appendChild(passages(cps, sd, opts.name, opts.meId));
    if (opts.full) {
      wrap.appendChild(h('h4', null, jersey('green'), ' Classement par points'));
      wrap.appendChild(table(sd.points, opts.name, opts.meId, 'green'));
      if (cps.some((c) => c.type === 'kom')) {
        wrap.appendChild(h('h4', null, jersey('kom'), ' Grand prix de la montagne'));
        wrap.appendChild(table(sd.kom, opts.name, opts.meId, 'kom'));
      }
    }
    return wrap;
  }

  /** Points de passage réellement placés sur le parcours : « 1 sprint, 2 côtes » ('' s'il n'y en a pas). */
  function cpsText(cps) {
    if (!cps) return '';
    const ns = cps.filter((c) => c.type === 'sprint').length, nk = cps.filter((c) => c.type === 'kom').length;
    return [ns && `${ns} sprint${ns > 1 ? 's' : ''}`, nk && `${nk} côte${nk > 1 ? 's' : ''}`].filter(Boolean).join(', ');
  }

  PYR.classifView = { scrollable, ordinal, pts, gapText, jersey, cpBadge, holders, jerseysOf, leaders, passages, table, block, cpsText };
})(globalThis.PYR = globalThis.PYR || {});
