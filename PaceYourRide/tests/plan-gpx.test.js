/* author : Hugo Joudrier-Faure */
/* Tests de l'export du plan optimal en GPX (compteur vélo). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor } = require('./helpers.js');

const G = PYR.planGpx;

async function makePlan() {
  const prof = makeProfile([{ len: 3000, grade: 0 }, { len: 2000, grade: 0.06 }, { len: 2000, grade: -0.05 }, { len: 3000, grade: 0 }]);
  const { course, setup, athlete } = setupFor(prof);
  const res = await PYR.optimizer.optimize({ course, setup, athlete, v0: 0 });
  assert.ok(res.ok, res.error);
  res.course = course;
  res.inputs = { length: course.length };
  return res;
}

test('tronçons : contigus, couvrent tout le parcours, en nombre limité', async () => {
  const plan = await makePlan();
  const secs = G.sections(plan);
  assert.ok(secs.length >= 2 && secs.length <= 100, `${secs.length} tronçons`);
  assert.equal(secs[0].a, 0);
  assert.equal(secs[secs.length - 1].b, plan.inputs.length);
  for (let i = 1; i < secs.length; i++) assert.equal(secs[i].a, secs[i - 1].b);
  for (const g of secs) assert.ok(g.t1 >= g.t0 && g.P > 0);
  assert.ok(Math.abs(secs[secs.length - 1].t1 - plan.tFinish) < 1e-6);
});

test('plan très variable : au plus 100 tronçons', async () => {
  const plan = await makePlan();
  assert.ok(G.sections(plan, { tol: 0.01, window: 10, max: 40 }).length <= 40);
});

test('TCX : un tour et un point de parcours par tronçon, avec puissance, vitesse et temps', async () => {
  const plan = await makePlan();
  const start = Date.UTC(2026, 5, 1, 8, 0, 0);
  const { tcx, sections } = G.buildTcx(plan, { name: 'Test <plan> & co', start });
  assert.match(tcx, /^<\?xml/);
  assert.ok(tcx.includes('Test &lt;plan&gt;'), 'nom échappé');
  assert.equal((tcx.match(/<Lap>/g) || []).length, sections.length);
  assert.equal((tcx.match(/<CoursePoint>/g) || []).length, sections.length + 1);
  const total = [...tcx.matchAll(/<TotalTimeSeconds>([\d.]+)</g)].reduce((a, m) => a + Number(m[1]), 0);
  assert.ok(Math.abs(total - plan.tFinish) < sections.length * 0.1 + 0.5, 'les tours couvrent la durée du plan');
  const dist = [...tcx.matchAll(/<Lap>[\s\S]*?<DistanceMeters>([\d.]+)</g)].reduce((a, m) => a + Number(m[1]), 0);
  assert.ok(Math.abs(dist - plan.inputs.length) < 1, 'les tours couvrent la distance');
  for (const m of tcx.matchAll(/<CoursePoint>\s*<Name>([^<]*)</g)) assert.ok(m[1].length <= 10, 'nom de point ≤ 10 caractères');
  assert.ok(/<Notes>Km [^<]*cible \d+ W · moy\. [\d,.]+ km\/h/.test(tcx), 'notes : puissance cible et vitesse moyenne');
  assert.equal((tcx.match(/<Track>/g) || []).length, 1);
  const times = [...tcx.split('<Track>')[1].split('</Track>')[0].matchAll(/<Time>([^<]+)</g)].map((m) => Date.parse(m[1]));
  assert.equal(times[0], start);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
  assert.ok(Math.abs(times[times.length - 1] - (start + plan.tFinish * 1000)) <= 1000);
});

test('GPX : un repère par tronçon et l\'arrivée, trace datée et croissante', async () => {
  const plan = await makePlan();
  const start = Date.UTC(2026, 5, 1, 8, 0, 0);
  const { gpx, sections } = G.build(plan, { name: 'Test <plan> & co', start });
  assert.match(gpx, /^<\?xml/);
  assert.ok(gpx.includes('Test &lt;plan&gt; &amp; co'), 'nom échappé');
  const wpts = gpx.match(/<wpt /g) || [];
  assert.equal(wpts.length, sections.length + 1);
  assert.ok(gpx.includes('<name>Arrivée</name>'));
  assert.ok(/<name>\d+ W<\/name>/.test(gpx));
  for (const m of gpx.matchAll(/<name>(\d+) W<\/name>/g)) assert.equal(Number(m[1]) % 5, 0, 'puissance arrondie à 5 W');
  const times = [...gpx.split('<trk>')[1].matchAll(/<trkpt [^>]*><ele>[-\d.]+<\/ele><time>([^<]+)<\/time>/g)].map((m) => Date.parse(m[1]));
  assert.ok(times.length > 10);
  assert.equal(times[0], start);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
  assert.ok(Math.abs(times[times.length - 1] - (start + plan.tFinish * 1000)) <= 1000, 'arrivée à l\'heure prévue');
  assert.equal((gpx.match(/<trk>/g) || []).length, 1);
  assert.equal((gpx.match(/<\/trk>/g) || []).length, 1);
});

test('limites choisies : tronçons contigus, puissance moyenne pondérée, limites invalides ignorées', async () => {
  const plan = await makePlan();
  const L = plan.inputs.length;
  const secs = G.sections(plan, { cuts: [6000, 2500, 2500.4, -5, L, L + 10, 4000] });
  assert.deepEqual(secs.map((g) => [g.a, g.b]), [[0, 2500], [2500, 4000], [4000, 6000], [6000, L]]);
  assert.ok(Math.abs(secs[secs.length - 1].t1 - plan.tFinish) < 1e-6);
  for (let i = 1; i < secs.length; i++) assert.equal(secs[i].t0, secs[i - 1].t1);
  // l'énergie des tronçons retrouve celle du plan
  const work = secs.reduce((a, g) => a + g.P * (g.t1 - g.t0), 0);
  let total = 0;
  for (let t = 0; t < plan.series.P.length; t++) total += plan.series.P[t] * Math.max(0, Math.min(t + 1, plan.tFinish) - t);
  assert.ok(Math.abs(work - total) / total < 1e-6, `${work} / ${total}`);
  assert.equal(G.sections(plan, { cuts: [] }).length, 1);
});

test('limites choisies : reprises par les exports GPX et TCX', async () => {
  const plan = await makePlan();
  const cuts = [2000, 5000];
  assert.equal(G.build(plan, { cuts }).sections.length, 3);
  const { tcx, sections } = G.buildTcx(plan, { cuts });
  assert.equal(sections.length, 3);
  assert.equal((tcx.match(/<Lap>/g) || []).length, 3);
});
