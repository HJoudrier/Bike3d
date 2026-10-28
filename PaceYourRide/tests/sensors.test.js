/* author : Hugo Joudrier-Faure */
/* Tests des capteurs Bluetooth : lecture des profils (puissance, home-trainer, cardio) et connexion avec un faux appareil. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PYR } = require('./helpers.js');

const Sx = PYR.sensors;

/** DataView à partir d'octets. */
const dv = (...bytes) => new DataView(Uint8Array.from(bytes).buffer);
const u16 = (x) => [x & 255, (x >> 8) & 255];
const s16 = (x) => u16(x < 0 ? x + 65536 : x);

test('profil puissance : puissance instantanée, négatif ramené à 0, champs facultatifs sautés', () => {
  assert.equal(Sx.parsePower(dv(...u16(0), ...s16(250)), {}).w, 250);
  assert.equal(Sx.parsePower(dv(...u16(0), ...s16(-8)), {}).w, 0);
  assert.equal(Sx.parsePower(dv(0, 0)), null, 'paquet trop court');
  // équilibre (bit 0) + couple cumulé (bit 2) + roue (bit 4) avant la manivelle (bit 5) : la cadence est lue au bon endroit
  const flags = 0x01 | 0x04 | 0x10 | 0x20;
  const st = {};
  const pkt = (revs, time) => dv(...u16(flags), ...s16(300), 50, ...u16(1234), 1, 0, 0, 0, ...u16(77), ...u16(revs), ...u16(time));
  const a = Sx.parsePower(pkt(100, 1000), st);
  assert.equal(a.w, 300);
  assert.ok(Number.isNaN(a.cad), 'une seule mesure de manivelle : pas encore de cadence');
  const b = Sx.parsePower(pkt(101, 1000 + 1024), st);
  assert.ok(Math.abs(b.cad - 60) < 1e-9, `${b.cad}`);
  const c = Sx.parsePower(pkt(103, 1000 + 1024 + 1365), st);   // 2 tours en 1,333 s : 90 tr/min
  assert.ok(Math.abs(c.cad - 90) < 0.1, `${c.cad}`);
});

test('profil puissance : le compteur de tours et l\'horloge repartent de 0 sans fausser la cadence', () => {
  const st = {};
  const pkt = (revs, time) => dv(...u16(0x20), ...s16(200), ...u16(revs), ...u16(time));
  Sx.parsePower(pkt(65535, 65000), st);
  const r = Sx.parsePower(pkt(1, (65000 + 1536) % 65536), st);    // 2 tours en 1,5 s : 80 tr/min
  assert.ok(Math.abs(r.cad - 80) < 0.1, `${r.cad}`);
});

test('profil home-trainer (FTMS) : vitesse, cadence, puissance et cardio lues dans l\'ordre des drapeaux', () => {
  // bit 0 à 0 : vitesse présente ; bit 2 : cadence ; bit 6 : puissance
  const a = Sx.parseFtms(dv(...u16(0x04 | 0x40), ...u16(3150), ...u16(170), ...s16(215)));
  assert.equal(a.kmh, 31.5);
  assert.equal(a.cad, 85);
  assert.equal(a.w, 215);
  // bit 0 à 1 : pas de vitesse ; distance (bit 4), résistance (bit 5), puissance (bit 6), énergie (bit 8), cardio (bit 9)
  const b = Sx.parseFtms(dv(...u16(0x01 | 0x10 | 0x20 | 0x40 | 0x100 | 0x200), 1, 2, 3, ...s16(12), ...s16(180), ...u16(50), ...u16(60), 5, 142));
  assert.ok(Number.isNaN(b.kmh));
  assert.equal(b.w, 180);
  assert.equal(b.hr, 142);
  // sans puissance
  assert.ok(Number.isNaN(Sx.parseFtms(dv(...u16(0x01 | 0x04), ...u16(120))).w));
  assert.equal(Sx.parseFtms(dv(0)), null);
});

test('profil cardio : valeur sur 8 ou 16 bits', () => {
  assert.equal(Sx.parseHr(dv(0, 148)).hr, 148);
  assert.equal(Sx.parseHr(dv(1, ...u16(301))).hr, 301);
  assert.equal(Sx.parseHr(dv(0)), null);
});

/* ---------- faux Bluetooth ---------- */

/** Faux appareil : services = { nom_du_service: { caractéristique: true } } ; renvoie aussi de quoi émettre. */
function fakeDevice(services, name = 'Faux capteur') {
  const listeners = {}, chars = {};
  const dev = {
    id: 'dev-' + name, name,
    gatt: {
      connected: false, connectCalls: 0,
      async connect() { dev.gatt.connected = true; dev.gatt.connectCalls++; return server; },
      disconnect() { dev.gatt.connected = false; (listeners.gattserverdisconnected || []).forEach((f) => f()); },
    },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
  };
  const server = {
    async getPrimaryService(s) {
      if (!services[s]) throw new Error('Service introuvable : ' + s);
      return {
        async getCharacteristic(c) {
          if (!services[s][c]) throw new Error('Caractéristique introuvable : ' + c);
          const ls = [];
          const ch = chars[c] = { async startNotifications() {}, addEventListener(t, f) { ls.push(f); }, removeEventListener(t, f) { ls.splice(ls.indexOf(f), 1); }, emit(view) { ls.slice().forEach((f) => f({ target: { value: view } })); } };
          return ch;
        },
      };
    },
  };
  dev.chars = chars;
  dev.drop = () => { dev.gatt.connected = false; (listeners.gattserverdisconnected || []).forEach((f) => f()); };
  return dev;
}

function withBluetooth(devices, fn) {
  const calls = [];
  Sx.navigator = {
    bluetooth: {
      async requestDevice(opts) { calls.push(opts); return devices.shift(); },
      async getDevices() { return all; },
    },
  };
  const all = devices.slice();
  Sx.reconnectMs = 5;
  if (typeof localStorage === 'undefined') {
    const mem = {};
    globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  }
  return Promise.resolve(fn(calls)).finally(() => { Sx.navigator = null; Sx.reconnectMs = 0; Sx.power.forget(); Sx.hr.forget(); });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('connexion : un capteur « Cycling Power » donne puissance et cadence ; la liste est filtrée sur le profil', async () => {
  const dev = fakeDevice({ cycling_power: { cycling_power_measurement: true } });
  await withBluetooth([dev], async (calls) => {
    const got = [], states = [];
    const name = await Sx.power.connect('service', (v) => got.push(v), (s) => states.push(s));
    assert.equal(name, 'Faux capteur');
    assert.equal(Sx.power.state, 'on');
    assert.match(Sx.power.profile, /Cycling Power/);
    assert.deepEqual(calls[0].filters.map((f) => f.services[0]).sort(), ['cycling_power', 'fitness_machine']);
    assert.ok(!calls[0].acceptAllDevices);
    assert.ok(calls[0].optionalServices.includes('cycling_power'));
    dev.chars.cycling_power_measurement.emit(dv(...u16(0), ...s16(264)));
    assert.equal(got.length, 1);
    assert.equal(got[0].w, 264);
    assert.equal(Sx.power.last.v.w, 264);
    assert.equal(Sx.power.count, 1);
    assert.deepEqual(states, ['connecting', 'on']);
    assert.deepEqual(Sx.power.known, { id: 'dev-Faux capteur', name: 'Faux capteur' }, 'appareil retenu pour la prochaine fois');
    Sx.power.disconnect();
    assert.equal(Sx.power.state, 'off');
  });
});

test('connexion : un home-trainer (FTMS) est reconnu quand l\'appareil n\'a pas le profil « Cycling Power »', async () => {
  const dev = fakeDevice({ fitness_machine: { indoor_bike_data: true } }, 'Trainer');
  await withBluetooth([dev], async () => {
    const got = [];
    await Sx.power.connect('service', (v) => got.push(v), () => {});
    assert.match(Sx.power.profile, /FTMS/);
    dev.chars.indoor_bike_data.emit(dv(...u16(0x04 | 0x40), ...u16(2800), ...u16(176), ...s16(190)));
    assert.equal(got[0].w, 190);
    assert.equal(got[0].cad, 88);
    Sx.power.disconnect();
  });
});

test('connexion : « autre appareil » liste tout, un appareil sans profil utile est refusé avec un message clair', async () => {
  const dev = fakeDevice({ battery_service: { battery_level: true } }, 'Montre');
  await withBluetooth([dev], async (calls) => {
    await assert.rejects(() => Sx.power.connect('any', () => {}, () => {}));
    assert.equal(calls[0].acceptAllDevices, true);
    assert.ok(calls[0].optionalServices.includes('fitness_machine'));
    assert.equal(Sx.power.state, 'off');
    assert.match(Sx.power.error, /ne propose pas/);
    assert.ok(!dev.gatt.connected, 'la connexion est coupée');
  });
});

test('connexion : sans Bluetooth dans le navigateur, une erreur explicite', async () => {
  Sx.navigator = {};
  try {
    assert.equal(Sx.power.supported, false);
    await assert.rejects(() => Sx.power.connect('service', () => {}, () => {}));
    assert.match(Sx.power.error, /Bluetooth/);
  } finally { Sx.navigator = null; }
});

test('connexion : après une coupure, le capteur se reconnecte tout seul et les mesures reprennent', async () => {
  const dev = fakeDevice({ cycling_power: { cycling_power_measurement: true } });
  await withBluetooth([dev], async () => {
    const got = [], states = [];
    await Sx.power.connect('service', (v) => got.push(v), (s) => states.push(s));
    dev.drop();                                  // sortie de portée
    assert.equal(Sx.power.state, 'reconnecting');
    await wait(60);
    assert.equal(Sx.power.state, 'on');
    assert.ok(dev.gatt.connectCalls >= 2);
    dev.chars.cycling_power_measurement.emit(dv(...u16(0), ...s16(140)));
    assert.equal(got.length, 1);
    assert.deepEqual(states.slice(0, 4), ['connecting', 'on', 'reconnecting', 'on']);
    Sx.power.disconnect();
    dev.drop();                                  // coupé volontairement : on ne se reconnecte pas
    await wait(30);
    assert.equal(Sx.power.state, 'off');
  });
});

test('connexion : un appareil déjà autorisé se reconnecte sans liste de choix (rechargement de la page)', async () => {
  const dev = fakeDevice({ cycling_power: { cycling_power_measurement: true } }, 'Pédales');
  await withBluetooth([dev], async (calls) => {
    await Sx.power.connect('service', () => {}, () => {});
    Sx.power.disconnect();
    assert.equal(Sx.power.canReconnect, true);
    const got = [];
    await Sx.power.reconnect((v) => got.push(v), () => {});
    assert.equal(calls.length, 1, 'aucune seconde liste de choix');
    assert.equal(Sx.power.state, 'on');
    dev.chars.cycling_power_measurement.emit(dv(...u16(0), ...s16(205)));
    assert.equal(got[0].w, 205);
    Sx.power.disconnect();
    Sx.power.forget();
    assert.equal(Sx.power.canReconnect, false);
    await assert.rejects(() => Sx.power.reconnect(() => {}, () => {}));
  });
});

test('connexion : la ceinture cardio se connecte à côté du capteur de puissance', async () => {
  const p = fakeDevice({ cycling_power: { cycling_power_measurement: true } }, 'Pédales');
  const c = fakeDevice({ heart_rate: { heart_rate_measurement: true } }, 'Ceinture');
  await withBluetooth([p, c], async () => {
    const hrs = [];
    await Sx.power.connect('service', () => {}, () => {});
    await Sx.hr.connect('service', (v) => hrs.push(v.hr), () => {});
    c.chars.heart_rate_measurement.emit(dv(0, 151));
    assert.deepEqual(hrs, [151]);
    assert.equal(Sx.power.state, 'on');
    Sx.power.disconnect(); Sx.hr.disconnect();
  });
});
