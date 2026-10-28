/* author : Hugo Joudrier-Faure */
/* Tests de l'export du plan en entraînement structuré (FIT, ZWO, MRC). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR, makeProfile, setupFor } = require('./helpers.js');

const W = PYR.planWorkout;

async function makePlan() {
  const prof = makeProfile([{ len: 3000, grade: 0 }, { len: 2000, grade: 0.06 }, { len: 2000, grade: -0.05 }, { len: 3000, grade: 0 }]);
  const { course, setup, athlete } = setupFor(prof);
  const res = await PYR.optimizer.optimize({ course, setup, athlete, v0: 0 });
  assert.ok(res.ok, res.error);
  res.course = course;
  res.inputs = { length: course.length };
  return res;
}

/** Relit un fichier FIT : { messages: { num → [{ champ → valeur }] } }, après vérification de l'en-tête et des CRC. */
function decodeFit(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(buf[0], 14);
  assert.equal(String.fromCharCode(...buf.slice(8, 12)), '.FIT');
  const dataSize = dv.getUint32(4, true);
  assert.equal(buf.length, 14 + dataSize + 2);
  assert.equal(dv.getUint16(12, true), W.crc16(buf, 0, 0, 12), 'CRC de l\'en-tête');
  assert.equal(dv.getUint16(14 + dataSize, true), W.crc16(buf, 0, 0, 14 + dataSize), 'CRC du fichier');
  const defs = {}, out = {};
  let p = 14;
  while (p < 14 + dataSize) {
    const h = buf[p++];
    if (h & 0x40) {
      const num = dv.getUint16(p + 2, true), n = buf[p + 4];
      const fields = [];
      for (let i = 0; i < n; i++) fields.push({ id: buf[p + 5 + i * 3], size: buf[p + 6 + i * 3], type: buf[p + 7 + i * 3] });
      defs[h & 15] = { num, fields };
      p += 5 + n * 3;
    } else {
      const d = defs[h & 15], rec = {};
      for (const f of d.fields) {
        if (f.type === 0x07) {
          let e = p; while (e < p + f.size && buf[e]) e++;
          rec[f.id] = Buffer.from(buf.slice(p, e)).toString('utf8');
        } else rec[f.id] = f.size === 1 ? buf[p] : f.size === 2 ? dv.getUint16(p, true) : dv.getUint32(p, true);
        p += f.size;
      }
      (out[d.num] = out[d.num] || []).push(rec);
    }
  }
  assert.equal(p, 14 + dataSize);
  return out;
}

test('FIT : fichier valide, une étape de distance et de puissance cible par tronçon', async () => {
  const plan = await makePlan();
  const { fit, sections } = W.buildFit(plan, { name: 'Test é', now: Date.UTC(2026, 5, 1) });
  const m = decodeFit(fit);
  assert.equal(m[0][0][0], 5, 'type entraînement');
  assert.equal(m[26][0][4], 2, 'cyclisme');
  assert.equal(m[26][0][8], 'Test é');
  assert.equal(m[26][0][6], sections.length);
  const steps = m[27];
  assert.equal(steps.length, sections.length);
  assert.ok(steps.length <= W.FIT_MAX_STEPS);
  let dist = 0;
  steps.forEach((s, i) => {
    assert.equal(s[254], i);
    assert.equal(s[1], 1, 'durée en distance');
    assert.equal(s[3], 4, 'cible en puissance');
    assert.equal(s[4], 0, 'plage personnalisée');
    assert.ok(s[5] > 1000 && s[6] > s[5], 'plage en watts (+1000)');
    const P = (s[5] + s[6]) / 2 - 1000;
    assert.ok(Math.abs(P - sections[i].P) < 10, `étape ${i} : ${P} W pour ${sections[i].P}`);
    assert.match(s[8], /W \|.*km\/h/);
    dist += s[2] / 100;
  });
  assert.ok(Math.abs(dist - plan.inputs.length) <= 1, `distance ${dist}`);
});

test('FIT : au plus 50 étapes même sur un plan très variable', async () => {
  const plan = await makePlan();
  assert.ok(W.buildFit(plan, { max: 5 }).sections.length <= 5);
});

test('ZWO : une étape par tronçon, durées entières cumulées sur le temps du plan, % de la PMA', async () => {
  const plan = await makePlan();
  const { zwo, steps } = W.buildZwo(plan, { name: 'A & B', ftp: 250 });
  assert.ok(zwo.includes('<name>A &amp; B</name>'));
  const ds = [...zwo.matchAll(/<SteadyState Duration="(\d+)" Power="([\d.]+)"/g)];
  assert.equal(ds.length, steps.length);
  assert.ok(Math.abs(ds.reduce((a, m) => a + Number(m[1]), 0) - plan.tFinish) <= 1, 'durée totale');
  for (const m of ds) assert.ok(Number(m[2]) > 0.2 && Number(m[2]) < 3);
  assert.equal((zwo.match(/<workout_file>/g) || []).length, 1);
});

test('MRC : en-tête, points contigus en minutes et % de la PMA', async () => {
  const plan = await makePlan();
  const { mrc, steps } = W.buildMrc(plan, { ftp: 200 });
  assert.match(mrc, /^\[COURSE HEADER\]/);
  assert.ok(mrc.includes('MINUTES PERCENT') && mrc.includes('[END COURSE DATA]'));
  const rows = mrc.split('[COURSE DATA]')[1].split('[END COURSE DATA]')[0].trim().split(/\r?\n/).map((l) => l.split('\t').map(Number));
  assert.equal(rows.length, steps.length * 2);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i][0] >= rows[i - 1][0]);
  assert.ok(Math.abs(rows[rows.length - 1][0] * 60 - plan.tFinish) <= 1.5);
  const first = steps[0];
  assert.ok(Math.abs(rows[0][1] - first.g.P / 200 * 100) < 0.06);
});

test('limites choisies : une étape FIT, ZWO et MRC par tronçon', async () => {
  const plan = await makePlan();
  const cuts = [1500, 4000, 7500];
  assert.equal(W.buildFit(plan, { cuts }).sections.length, 4);
  assert.equal(W.buildZwo(plan, { cuts, ftp: 250 }).steps.length, 4);
  assert.equal(W.buildMrc(plan, { cuts, ftp: 250 }).steps.length, 4);
  assert.equal(decodeFit(W.buildFit(plan, { cuts }).fit)[27].length, 4);
});
