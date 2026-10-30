/* author : Hugo Joudrier-Faure */
/* Prototype : allure optimale par programmation lineaire (GAMS + HiGHS), rejouee dans le vrai simulateur.
 *
 *   node PaceYourRide/tools/lp/run.js [parcours] [--seg 100] [--iters 6] [--compare]
 *
 * Boucle de programmation lineaire sequentielle :
 *   1. les donnees du troncon (pente, vent, densite, roulement, limite de vitesse) viennent du contexte du simulateur ;
 *   2. GAMS resout le LP (pacing.gms) : durees tau(i) et energies E(i) qui minimisent le temps ;
 *   3. le plan (puissance moyenne E/tau par troncon) est rejoue dans le simulateur seconde par seconde : c'est le
 *      temps REEL, avec tous les ecretages ;
 *   4. le rejeu fournit les temps de passage (membres des fenetres glissantes) et le deficit de W' (rendement de
 *      recuperation), qui linearisent la tour d'iteration suivante.
 * Aucun paquet npm requis ; GAMS doit etre installe (variable GAMS_EXE, defaut C:\GAMS\54\gams.exe). */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..', '..');
const { PYR, makeProfile, setupFor } = require(path.join(ROOT, 'tests', 'helpers.js'));

const G = 9.80665;
const GAMS_EXE = process.env.GAMS_EXE || 'C:\\GAMS\\54\\gams.exe';
const V_MAX = 30, V_MIN = 1.0;     // m/s — bornes de la vitesse moyenne d'un troncon
const N_GRID = 48;                 // points d'echantillonnage de g_i(tau) pour l'enveloppe convexe
const WIN_MIN = 30;                // s — fenetres plus courtes ignorees (couvertes par le limiteur du simulateur)
const NP_STEP = 10;                // s — pas des fenetres de 30 s qui servent a la puissance normalisee
// points de tangence de x^4 (en 100 W) : l'ecart entre deux tangentes sous-estime x^4 de ~ 6 (h/2)^2 / x^2 ; pas de 0,04 sur la plage utile
const NP_CUTS = [0.3, 0.6, 0.8].concat(Array.from({ length: 101 }, (_, k) => 1.0 + 0.04 * k), [4.3, 4.6, 5, 5.5, 6, 7, 8.5, 10, 12]);

/* ---------- Parcours d'essai (les memes que les tests) ---------- */
function smooth(fn, length, seg = 50, width = 400) {
  const n = Math.round(length / seg), k = Math.max(1, Math.round(width / seg));
  const raw = Array.from({ length: n }, (_, i) => fn((i + 0.5) * seg));
  return raw.map((_, i) => { let s = 0, c = 0; for (let j = i - k; j <= i + k; j++) if (j >= 0 && j < n) { s += raw[j]; c++; } return { len: seg, grade: s / c }; });
}
const COURSES = {
  rolling: () => smooth((s) => 0.045 * Math.sin(s / 900) + 0.02 * Math.sin(s / 310), 30000, 50, 150),
  hilly: () => smooth((s) => (s < 10000 ? 0 : s < 15000 ? 0.06 : s < 20000 ? -0.06 : 0), 30000),
  short: () => smooth((s) => (s < 3000 ? 0 : s < 4500 ? 0.07 : s < 5500 ? -0.05 : 0.005), 9000, 25, 100),
  flat: () => [{ len: 20000, grade: 0 }],
};

/* ---------- Troncons : donnees physiques moyennees ---------- */
function buildSegments(ctx, segLen) {
  const C = ctx.course, S = ctx.setup, L = C.length, N = Math.ceil(L / segLen), cond = {};
  const segs = [];
  for (let i = 0; i < N; i++) {
    const s0 = i * segLen, s1 = Math.min(L, (i + 1) * segLen), ds = s1 - s0;
    let n = 0, sin = 0, cos = 0, crr = 0, rho = 0, wh = 0, wc = 0, vl = Infinity;
    for (let s = s0 + C.step / 2; s < s1 + 1e-9; s += C.step) {
      PYR.sim.conditions(ctx, Math.min(s, L - 1e-6), 0, cond);
      sin += cond.sinT; cos += cond.cosT; crr += cond.crr; rho += cond.rho; wh += cond.whM; wc += cond.wcM;
      if (cond.vlim < vl) vl = cond.vlim;
      n++;
    }
    const seg = { ds, sin: sin / n, cos: cos / n, crr: crr / n, rho: rho / n, wh: wh / n, wc: wc / n, vlim: Math.min(vl, V_MAX) };
    // energie aux pedales pour parcourir le troncon en tau secondes (vitesse moyenne ds/tau, regime quasi-statique)
    seg.g = (tau) => {
      const x = ds / tau + seg.wh, va = Math.sqrt(x * x + seg.wc * seg.wc);
      const Fa = 0.5 * seg.rho * S.cda * va * x;
      return (S.mass * G * seg.sin + seg.crr * S.mass * G * seg.cos + Fa) * ds / S.eta;
    };
    seg.tauLo = ds / seg.vlim; seg.tauUp = ds / V_MIN;
    segs.push(seg);
  }
  return segs;
}

/** Facettes (a, b) de l'enveloppe convexe inferieure de g_i : E >= a*tau + b. */
function facets(seg, dke) {
  const pts = [];
  const r = Math.pow(seg.tauUp / seg.tauLo, 1 / (N_GRID - 1));
  for (let k = 0, t = seg.tauLo; k < N_GRID; k++, t *= r) pts.push([t, seg.g(t) + dke]);
  const hull = [];
  for (const p of pts) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2], b = hull[hull.length - 1];
      if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 0) hull.pop(); else break;
    }
    hull.push(p);
  }
  const out = [];
  for (let k = 0; k + 1 < hull.length; k++) {
    const a = (hull[k + 1][1] - hull[k][1]) / (hull[k + 1][0] - hull[k][0]);
    out.push([a, hull[k][1] - a * hull[k][0]]);
  }
  return out;
}

/* ---------- Ecriture des donnees GAMS ---------- */
const num = (x) => Number(x).toPrecision(12);

function writeData(file, ctx, segs, st) {
  const N = segs.length, fl = segs.map((s, i) => facets(s, st.dke[i])), KF = Math.max(...fl.map((f) => f.length));
  const kr = ctx.recF / ctx.w0;
  const o = [];
  o.push(`Scalars cp /${num(ctx.cp)}/, w0 /${num(ctx.w0)}/, pmax /${num(ctx.capTot[0])}/;`);
  o.push(`Set i / i1*i${N} /;`, `Set k / k1*k${KF} /;`);
  const par = (name, f, dom = 'i') => { o.push(`Parameter ${name}(${dom}) /`); for (let i = 0; i < N; i++) o.push(`  i${i + 1} ${num(f(i))}`); o.push('/;'); };
  // region de confiance : la duree de chaque troncon reste proche de celle de l'iteration precedente (st.trust = ecart relatif)
  const tprevSeg = (i) => st.tc[i + 1] - st.tc[i];
  par('taulo', (i) => Math.max(segs[i].tauLo, tprevSeg(i) * (1 - st.trust)));
  par('tauup', (i) => Math.max(Math.min(segs[i].tauUp, tprevSeg(i) * (1 + st.trust)), segs[i].tauLo * 1.0001));
  par('kap', (i) => Math.min(1, Math.max(0, kr * st.deficit[i])));
  for (const [name, idx] of [['fa', 0], ['fb', 1]]) {
    o.push(`Parameter ${name}(i,k) /`);
    for (let i = 0; i < N; i++) for (let j = 0; j < KF; j++) o.push(`  i${i + 1}.k${j + 1} ${num(fl[i][Math.min(j, fl[i].length - 1)][idx])}`);
    o.push('/;');
  }
  // fenetres glissantes : appartenance des troncons fixee par le rejeu precedent (temps de passage st.tc)
  const rows = [], T = st.tc[N];
  for (let j = 1; j < ctx.nWin; j++) {
    const d = ctx.win[j];
    if (d < WIN_MIN || d >= T - 1) continue;
    const step = Math.max(10, d / 20);
    for (let t0 = 0; t0 + d <= T + 1e-9; t0 += step) {
      const w = [];
      for (let i = 0; i < N; i++) {
        const a = Math.max(st.tc[i], t0), b = Math.min(st.tc[i + 1], t0 + d);
        if (b - a > 1e-6) w.push([i + 1, (b - a) / (st.tc[i + 1] - st.tc[i])]);
      }
      if (w.length) rows.push({ rate: ctx.capTot[j] / d, w });   // record de d secondes, en W (puissance moyenne tolerable)
    }
  }
  const M = Math.max(1, rows.length);
  o.push(`Set w / w1*w${M} /;`);
  o.push('Parameter wrate(w) /'); if (rows.length) rows.forEach((r, m) => o.push(`  w${m + 1} ${num(r.rate)}`)); else o.push('  w1 1e6'); o.push('/;');
  o.push('Parameter ww(w,i) /'); rows.forEach((r, m) => r.w.forEach(([i, v]) => o.push(`  w${m + 1}.i${i} ${num(v)}`))); o.push('/;');
  // energie totale : T*mmp(T) lineaire autour de la duree precedente
  const mm = (t) => t * ctx.athlete.mmp(t) * ctx.marginK;
  if (T >= 120) o.push(`Scalars wtot0 /${num(mm(T))}/, dwtot /${num((mm(T + 5) - mm(T - 5)) / 10)}/, tprev /${num(T)}/;`);
  else o.push('Scalars wtot0 /1e12/, dwtot /0/, tprev /0/;');
  // puissance normalisee (NP) : fenetres de 30 s finissant toutes les NP_STEP secondes, au-dela de LONG_WINDOW
  const np = [];
  if (T >= PYR.sim.LONG_WINDOW) {
    for (let t1 = 30; t1 <= T; t1 += NP_STEP) {
      const t0 = t1 - 30, w = [];
      for (let i = 0; i < N; i++) {
        const a = Math.max(st.tc[i], t0), b = Math.min(st.tc[i + 1], t1);
        if (b - a > 1e-6) w.push([i + 1, (b - a) / (st.tc[i + 1] - st.tc[i])]);
      }
      if (w.length) np.push(w);
    }
  }
  const NQ = Math.max(1, np.length), cuts = NP_CUTS;
  o.push(`Set q / q1*q${NQ} /;`, `Set c / c1*c${cuts.length} /;`);
  o.push('Parameter npw(q,i) /'); np.forEach((w, m) => w.forEach(([i, v]) => o.push(`  q${m + 1}.i${i} ${num(v)}`))); o.push('/;');
  o.push('Parameter npa(c) /'); cuts.forEach((c, m) => o.push(`  c${m + 1} ${num(4 * c * c * c)}`)); o.push('/;');
  o.push('Parameter npb(c) /'); cuts.forEach((c, m) => o.push(`  c${m + 1} ${num(-3 * c * c * c * c)}`)); o.push('/;');
  // st.npScale : etalonnage de la NP du LP sur celle du simulateur (mesuree au rejeu precedent), au 4e pouvoir
  const rec4 = (t) => st.npScale * Math.pow(ctx.athlete.mmp(t) * ctx.marginK / 100, 4);
  if (np.length) o.push(`Scalars nq /${np.length}/, nprhs0 /${num(rec4(T))}/, dnprhs /${num((rec4(T + 5) - rec4(T - 5)) / 10)}/;`);
  else o.push('Scalars nq /0/, nprhs0 /1/, dnprhs /0/;');
  fs.writeFileSync(file, o.join('\n') + '\n');
  return { rows: rows.length, KF, nnz: rows.reduce((a, r) => a + r.w.length, 0) };
}

/* ---------- GAMS ---------- */
function solveLP(work) {
  const t0 = Date.now();
  // chemins relatifs et dossier courant : GAMS gere mal les espaces et les accents en ligne de commande
  fs.copyFileSync(path.join(__dirname, 'pacing.gms'), path.join(work, 'pacing.gms'));
  for (const f of ['status.txt', 'sol.csv']) fs.rmSync(path.join(work, f), { force: true });
  const r = cp.spawnSync(GAMS_EXE, ['pacing.gms', 'lo=2', 'o=pacing.lst'], { cwd: work, encoding: 'utf8' });
  if (r.error) throw r.error;
  const stFile = path.join(work, 'status.txt');
  if (!fs.existsSync(stFile)) throw new Error('GAMS : aucune solution.\n' + (r.stdout || '').slice(-1500));
  const stLines = fs.readFileSync(stFile, 'utf8').trim().split(/\r?\n/);
  const [model, solver, z, slack] = stLines[0].split(',').map(Number);
  const npDiag = (stLines[1] || '').split(',').map(Number);
  const rows = fs.readFileSync(path.join(work, 'sol.csv'), 'utf8').trim().split(/\r?\n/).map((l) => l.split(',').map(Number));
  return { model, solver, z, slack, npDiag, tau: rows.map((x) => x[1]), E: rows.map((x) => x[2]), wb: rows.map((x) => x[3]), ms: Date.now() - t0 };
}

/* ---------- Rejeu dans le simulateur reel ---------- */
function replayPlan(ctx, segLen, P) {
  const L = ctx.course.length, N = P.length;
  const sch = PYR.gradient.makeSchedule(L, ctx.course.step, (s) => P[Math.min(N - 1, Math.floor(s / segLen))]);
  return replayBuilt(ctx, sch);
}
function replayBuilt(ctx, sch) {
  const rep = PYR.optimizer.replay(ctx, PYR.gradient.scheduleCommand(sch), 0, true);
  const st = rep.st;
  return { sch, rep, T: st.finished ? st.tFinish : Infinity, u: st.finished ? PYR.sim.enduranceUse(ctx, st.hist, st.tFinish) : 9 };
}

/** Temps de passage aux limites des troncons et deficit de W' moyen par troncon, d'apres un rejeu. */
function passages(ctx, segLen, N, rp) {
  const R = rp.rep.R, n = Math.ceil(rp.rep.st.tFinish), L = ctx.course.length;
  const tAt = (b) => {
    if (b >= L) return rp.rep.st.tFinish;
    let t = 0;
    while (t + 1 <= n && R.s[t + 1] < b) t++;
    const d = R.s[t + 1] - R.s[t];
    return t + (d > 1e-9 ? (b - R.s[t]) / d : 0);
  };
  const tc = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) tc[i] = tAt(Math.min(L, i * segLen));
  // variation d'energie cinetique par troncon (J aux pedales), d'apres les vitesses du rejeu aux limites des troncons
  const vAt = (t) => { const a = Math.min(n, Math.max(0, Math.floor(t))), b = Math.min(n, a + 1); return R.v[a] + (R.v[b] - R.v[a]) * (t - a); };
  const dke = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const v0 = vAt(tc[i]), v1 = i + 1 < N ? vAt(tc[i + 1]) : vAt(tc[i + 1]);
    dke[i] = 0.5 * ctx.setup.massEff * (v1 * v1 - v0 * v0) / ctx.setup.eta;
  }
  const deficit = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = Math.floor(tc[i]), b = Math.max(a + 1, Math.min(n, Math.floor(tc[i + 1])));
    let s = 0, c = 0;
    for (let t = a; t <= b && t <= n; t++) { s += ctx.w0 - R.w[t]; c++; }
    deficit[i] = s / Math.max(1, c);
  }
  return { tc, deficit, dke, trust: 0.35, npScale: 1 };
}

/** Decomposition du taux d'utilisation de la courbe record (copie de PYR.sim.enduranceUse, avec le detail). */
function useBreakdown(ctx, H, tFinish) {
  const n = Math.floor(tFinish), out = { win: 0, winD: 0, avg: 0, np: 0 };
  for (let j = ctx.nWinShort; j < ctx.nWin; j++) {
    const d = ctx.win[j];
    if (d > n) break;
    let best = 0;
    for (let t = d; t <= n; t++) { const w = H[t] - H[t - d]; if (w > best) best = w; }
    if (best / ctx.capTot[j] > out.win) { out.win = best / ctx.capTot[j]; out.winD = d; }
  }
  const mm = ctx.athlete.mmp(tFinish) * ctx.marginK;
  out.avg = (H[n] / n) / mm;
  if (tFinish >= PYR.sim.LONG_WINDOW && n > 30) {
    let s4 = 0, cnt = 0;
    for (let t = 30; t <= n; t++) { const a = (H[t] - H[t - 30]) / 30; s4 += a * a * a * a; cnt++; }
    out.np = Math.pow(s4 / cnt, 0.25) / mm;
  }
  return out;
}

/** Remet un plan a l'echelle tant que la courbe record est depassee (comme le fait la descente de gradient). */
function restoreEndurance(ctx, rp) {
  let cur = rp;
  for (let k = 0; k < 4 && cur.u > 1.0005 && cur.u < 1.2; k++) {
    const f = 1 / cur.u, P = Float64Array.from(cur.sch.P, (p) => p * f);
    cur = replayBuilt(ctx, { ds: cur.sch.ds, K: cur.sch.K, P });
  }
  return cur;
}

/* ---------- Programme principal ---------- */
async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
  const name = args.find((a) => COURSES[a]) || 'short';
  const segLen = Number(opt('seg', 100)), iters = Number(opt('iters', 6)), compare = args.includes('--compare');
  const work = path.join(__dirname, 'work', name);
  fs.mkdirSync(work, { recursive: true });
  const { course, setup, athlete } = setupFor(makeProfile(COURSES[name]()));
  const ctx = PYR.sim.createContext(course, setup, athlete, {});
  const segs = buildSegments(ctx, segLen), N = segs.length;
  console.log(`parcours ${name} : ${(course.length / 1000).toFixed(1)} km, ${N} troncons de ${segLen} m, CP ${ctx.cp.toFixed(1)} W, W' ${(ctx.w0 / 1000).toFixed(1)} kJ`);

  const base = await PYR.optimizer.bestConstant(ctx, 0, { async tick() {} });
  console.log(`reference : puissance constante ${base.power.toFixed(1)} W -> ${base.time.toFixed(2)} s`);

  // point de depart : plan a puissance constante, rejoue dans le simulateur (faisable). Region de confiance sur les durees :
  // un pas du LP n'est accepte que s'il ameliore le temps REEL (apres remise a l'echelle de la courbe record) ; sinon on
  // reduit la region et on recommence depuis le meilleur plan, dont le rejeu fournit les donnees de linearisation.
  let cur = restoreEndurance(ctx, replayBuilt(ctx, PYR.gradient.makeSchedule(course.length, course.step, () => base.power)));
  let best = { T: cur.T, rp: cur, P: new Array(N).fill(base.power) };
  let delta = Number(opt('trust', 0.25));
  let state = passages(ctx, segLen, N, cur);
  for (let it = 1; it <= iters && delta >= 0.01; it++) {
    state.trust = delta;
    const info = writeData(path.join(work, 'data.inc'), ctx, segs, state);
    const lp = solveLP(work);
    if (lp.model !== 1 && lp.model !== 8) { console.log(`  it ${it} : GAMS modelstat=${lp.model} solvestat=${lp.solver} (infaisable ou non borne)`); break; }
    const P = lp.E.map((e, i) => e / lp.tau[i]);
    let rp = replayPlan(ctx, segLen, P);
    const raw = rp;
    rp = restoreEndurance(ctx, rp);
    const wmin = Math.min(...rp.rep.R.w.slice(0, Math.ceil(rp.T) + 1));
    if (args.includes('--debug')) {
      const [mz, mx4, rhs, xmax] = lp.npDiag;
      console.log(`      NP vu par le LP : moyenne z ${mz.toFixed(3)} | moyenne x^4 ${mx4.toFixed(3)} | second membre ${rhs.toFixed(3)} | NP/record ${(Math.pow(mx4 / rhs, 0.25)).toFixed(4)} | pointe 30 s ${(xmax * 100).toFixed(0)} W`);
      const b = useBreakdown(ctx, raw.rep.st.hist, raw.rep.st.tFinish);
      // NP de l'LP lui-meme (segments constants, memes fenetres de 30 s)
      let s4 = 0, cnt = 0, tcl = 0; const tcs = [0]; for (let i = 0; i < N; i++) tcs.push(tcs[i] + lp.tau[i]);
      for (let t1 = 30; t1 <= tcs[N]; t1 += 1) {
        let e = 0; for (let i = 0; i < N; i++) { const a = Math.max(tcs[i], t1 - 30), c = Math.min(tcs[i + 1], t1); if (c > a) e += lp.E[i] * (c - a) / lp.tau[i]; }
        s4 += Math.pow(e / 30, 4); cnt++;
      }
      const mmT = ctx.athlete.mmp(tcs[N]) * ctx.marginK;
      console.log(`      decomposition reel : fenetre ${b.win.toFixed(4)} (${b.winD} s) | moyenne ${b.avg.toFixed(4)} | NP ${b.np.toFixed(4)}   ||  LP lui-meme : moyenne ${(lp.E.reduce((a, x) => a + x, 0) / tcs[N] / mmT).toFixed(4)} | NP ${(Math.pow(s4 / cnt, 0.25) / mmT).toFixed(4)}  (T_LP ${tcs[N].toFixed(1)} s)`);
    }
    const ok = rp.T < best.T - 1e-3;
    // etalonnage de la NP : si le simulateur mesure NP/record = r alors que le LP visait 1, on resserre (ou on desserre) de r^-4
    const npReal = useBreakdown(ctx, raw.rep.st.hist, raw.rep.st.tFinish).np;
    const npScaleNext = npReal > 0.5 ? Math.min(1.05, Math.max(0.9, state.npScale / Math.pow(npReal, 4))) : state.npScale;
    console.log(`  it ${it} : region ${(delta * 100).toFixed(0)} % | LP ${lp.z.toFixed(2)} s (ecart fenetres ${lp.slack.toFixed(0)} J) | reel ${raw.T.toFixed(2)} s (u=${raw.u.toFixed(4)})${rp !== raw ? ` -> apres remise a l'echelle ${rp.T.toFixed(2)} s (u=${rp.u.toFixed(4)})` : ''} | W' min ${wmin.toFixed(0)} J | ${ok ? 'ACCEPTE' : 'refuse'} | ${info.rows} fenetres, GAMS ${lp.ms} ms`);
    if (ok) {
      best = { T: rp.T, rp, P };
      state = passages(ctx, segLen, N, rp);
      delta = Math.min(0.4, delta * 1.25);
    } else delta *= 0.5;
    state.npScale = npScaleNext;
  }
  fs.writeFileSync(path.join(work, 'plan.json'), JSON.stringify({ course: name, segLen, T: best.T, P: best.P }));
  console.log(`\nLP : meilleur temps reel ${best.T.toFixed(2)} s (gain sur la constante ${(base.time - best.T).toFixed(2)} s, ${((base.time - best.T) / base.time * 100).toFixed(2)} %)`);

  if (compare) {
    const R = best.rp.rep.R, st = best.rp.rep.st;
    const g = await PYR.gradient.solve(ctx, { T: st.tFinish, s: R.s, P: R.P, n: Math.ceil(st.tFinish) }, { v0: 0 });
    console.log(`LP + descente de gradient : ${g.ok ? g.T.toFixed(2) : '-'} s`);
    for (const algo of ['analytic', 'gradient', 'hybrid']) {
      const r = await PYR.optimizer.optimize({ course, setup, athlete, v0: 0, margin: 0, algo });
      console.log(`${algo.padEnd(10)} : ${r.tFinish.toFixed(2)} s (${r.strategy})`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
