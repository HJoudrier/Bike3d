/* author : Hugo Joudrier-Faure */
/* Tests des encodages de partage (node --test tests/). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PYR, makeProfile } = require('./helpers.js');
require(path.join(__dirname, '..', 'js/core/codec.js'));
require(path.join(__dirname, '..', 'js/core/race-data.js'));
require(path.join(__dirname, '..', 'js/ui/relay.js'));
const qrcode = require(path.join(__dirname, '..', 'vendor/qrcode-generator/qrcode.js'));
const jsQR = require(path.join(__dirname, '..', 'vendor/jsqr/jsQR.js'));

const C = PYR.codec, R = PYR.raceData;

const CHROME_OFFER = [
  'v=0', 'o=- 361984107981372990 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=candidate:2973616865 1 udp 2113937151 291dc188-63a2-45c8-8786-bff4a8a9120f.local 42863 typ host generation 0 network-cost 999',
  'a=candidate:1034856361 1 udp 1677729535 203.0.113.45 61234 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:3555353377 1 tcp 1518283007 291dc188-63a2-45c8-8786-bff4a8a9120f.local 9 typ host tcptype active generation 0',
  'a=candidate:1111111111 1 udp 2113939711 2001:db8:85a3::8a2e:370:7334 50000 typ host generation 0',
  'a=ice-ufrag:E2wa', 'a=ice-pwd:WNEqQAqmIQKTPQgnD0l05Aog', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 D0:67:C6:0B:4E:FC:CF:15:E8:95:D5:AC:F7:8C:A9:7B:D6:02:72:94:C2:87:07:7E:C2:9A:D4:2C:96:A2:9D:63',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
].join('\r\n');

const FIREFOX_ANSWER = [
  'v=0', 'o=mozilla...THIS_IS_SDPARTA-99.0 5012196325474196853 0 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=sendrecv',
  'a=fingerprint:sha-256 3C:94:1C:A6:2A:4F:1D:2D:9E:26:1A:36:44:71:9C:2A:5A:5C:52:F5:7A:1D:5E:7F:FE:10:2E:4A:12:21:05:6B',
  'a=group:BUNDLE 0', 'a=ice-options:trickle', 'a=msid-semantic:WMS *',
  'm=application 55417 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 203.0.113.7',
  'a=candidate:0 1 UDP 2122252543 e7c7d4b1-7b2f-4a0e-8e2d-2f0f6a3b9c11.local 55417 typ host',
  'a=candidate:2 1 TCP 2105524479 e7c7d4b1-7b2f-4a0e-8e2d-2f0f6a3b9c11.local 9 typ host tcptype active',
  'a=candidate:1 1 UDP 1686052863 203.0.113.7 55417 typ srflx raddr 0.0.0.0 rport 0',
  'a=end-of-candidates', 'a=ice-pwd:1b7a3c5d9e2f4a6b8c0d1e2f3a4b5c6d', 'a=ice-ufrag:9f8e7d6c',
  'a=mid:0', 'a=setup:active', 'a=sctp-port:5000', 'a=max-message-size:1073741823', '',
].join('\r\n');

function essentials(sdp) {
  const keep = sdp.split(/\r?\n/).filter((l) => /^a=(ice-ufrag|ice-pwd|fingerprint|setup|mid|sctp-port|max-message-size):/.test(l)).sort();
  const cands = sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:')).map((l) => {
    const t = l.slice(12).split(/\s+/);
    return t[2].toLowerCase() === 'udp' ? `${t[3]} ${t[4].toLowerCase()} ${t[5]} ${t[7]}` : null;
  }).filter(Boolean);
  return { keep, cands };
}

test('code WebRTC : aller-retour d\'une offre Chrome (candidats mDNS, IPv4, IPv6)', () => {
  const code = C.sdpToCode(CHROME_OFFER, 'offer', 0xdeadbeef);
  assert.ok(code.startsWith('PYR.'));
  assert.ok(code.length < 220, `code trop long : ${code.length}`);
  const back = C.codeToSdp(code);
  assert.equal(back.kind, 'offer');
  assert.equal(back.invite, 0xdeadbeef);
  const a = essentials(CHROME_OFFER), b = essentials(back.sdp);
  assert.deepEqual(b.keep, a.keep);
  // les candidats UDP sont conservés (le TCP est ignoré), IPv6 réécrit en forme longue
  assert.equal(b.cands.length, 3);
  assert.ok(b.cands.some((c) => c.includes('291dc188-63a2-45c8-8786-bff4a8a9120f.local 42863 host')));
  assert.ok(b.cands.some((c) => c.includes('203.0.113.45 61234 srflx')));
  assert.ok(b.cands.some((c) => c.includes('2001:db8:85a3:0:0:8a2e:370:7334 50000 host')));
});

test('code WebRTC : aller-retour d\'une réponse au format Firefox', () => {
  const code = C.sdpToCode(FIREFOX_ANSWER, 'answer', 42);
  const back = C.codeToSdp('  ' + code.slice(0, 20) + '\n' + code.slice(20) + '  ');
  assert.equal(back.kind, 'answer');
  assert.equal(back.invite, 42);
  assert.ok(back.sdp.includes('a=setup:active'));
  assert.ok(back.sdp.includes('a=max-message-size:1073741823'));
  assert.ok(back.sdp.includes('a=ice-pwd:1b7a3c5d9e2f4a6b8c0d1e2f3a4b5c6d'));
  assert.equal(essentials(back.sdp).cands.length, 2);
  // extraction depuis un lien
  assert.equal(C.codeToSdp(`https://exemple.fr/index.html#live=${code}`).invite, 42);
  assert.throws(() => C.codeToSdp('pas un code !'));
});

test('JSON compressé : aller-retour', async () => {
  const obj = { a: 1, b: 'éèà', arr: Array.from({ length: 2000 }, (_, i) => i % 7) };
  const s = await C.packJson(obj);
  assert.ok(/^[01][A-Za-z0-9_-]+$/.test(s));
  assert.deepEqual(await C.unpackJson(s), obj);
});

test('parcours canonique : quantification, empreinte, empaquetage et trace', () => {
  const prof = makeProfile([{ len: 3000, grade: 0.04 }, { len: 2000, grade: -0.03 }]);
  const state = { surfaces: [{ startKm: 1, endKm: 2, surface: 'cobbles', factor: 2.2, id: 'x' }], winds: [], env: { temperature: 18 }, perf: { cornering: 'normal', vmaxKmh: 80, startSpeedKmh: 0 } };
  const course = R.canonicalCourse(prof, state);
  const sig = R.courseSignature(course);
  const packed = JSON.parse(JSON.stringify(R.packCourse(course)));
  const back = R.unpackCourse(packed);
  assert.deepEqual(back.lat, course.lat);
  assert.deepEqual(back.ele, course.ele);
  assert.equal(R.courseSignature(back), sig);
  // l'état reconstitué à partir du parcours a la même empreinte
  const st2 = { route: { fixed: R.courseGeometry(back) }, surfaces: back.surfaces, winds: back.winds, env: back.env, perf: back.opts };
  assert.equal(R.currentSignature(st2), sig);
  // une portion modifiée change l'empreinte
  st2.surfaces = [Object.assign({}, back.surfaces[0], { endKm: 2.5 })];
  assert.notEqual(R.currentSignature(st2), sig);
  // profil reconstruit ≈ profil d'origine
  const p2 = R.geometryProfile(back);
  assert.ok(Math.abs(p2.ele[100] - prof.ele[100]) < 0.01);
  assert.ok(Math.abs(p2.length - prof.length) < 1e-3);
  // trace
  const entry = { name: 'Test', time: 3.5, s: [0, 4.23, 9.87, 15.02, 21.4], P: [300, 300, 310, 0] };
  const e2 = R.unpackEntry(JSON.parse(JSON.stringify(R.packEntry(entry))));
  assert.deepEqual(e2.P, entry.P);
  e2.s.forEach((x, i) => assert.ok(Math.abs(x - entry.s[i]) <= 0.05));
  assert.ok(Math.abs(R.traceTimeAt(e2.s, 12) - 2.4) < 0.05);
  assert.ok(Math.abs(R.tracePosAt(e2.s, 1.5) - 7.05) < 0.05);
});

test('QR code : génération puis lecture d\'un code d\'invitation', () => {
  const text = C.sdpToCode(CHROME_OFFER, 'offer', 7);
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount(), scale = 4, margin = 4, size = (n + 2 * margin) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const o = (((r + margin) * scale + y) * size + (c + margin) * scale + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 0;
    }
  }
  const res = jsQR(data, size, size);
  assert.ok(res, 'QR non décodé');
  assert.equal(res.data, text);
  assert.ok(n <= 61, `QR trop dense : ${n} modules`);
});

test('code de salle : aller-retour, lien, relais personnel et reconnaissance du type', () => {
  const room = C.newRoom();
  const code = C.roomToCode(room);
  assert.ok(code.startsWith('PYR.') && code.length < 45, code);
  const r = C.readCode(`https://exemple.github.io/PaceYourRide/#live=${code}`);
  assert.equal(r.type, 'room');
  assert.deepEqual(Array.from(r.id), Array.from(room.id));
  assert.deepEqual(Array.from(r.key), Array.from(room.key));
  assert.equal(r.relay, null);
  assert.match(r.topic, /^pyr_[A-Za-z0-9_-]{12}$/);
  const custom = C.readCode(C.roomToCode(Object.assign({}, room, { relay: 'https://ntfy.exemple.org' })));
  assert.equal(custom.relay, 'https://ntfy.exemple.org');
  // une offre reste une offre, et un code de salle n'est pas une offre
  assert.equal(C.readCode(C.sdpToCode(CHROME_OFFER, 'offer', 7)).type, 'offer');
  assert.throws(() => C.codeToSdp(code), /code de salle/);
  assert.throws(() => C.readCode(''), /Colle/);
  assert.throws(() => C.readCode('PYR.abc'), /illisible/);
});

test('relais : messages chiffrés (aller-retour, altération, mauvaise clé)', async () => {
  const room = C.newRoom();
  const key = await PYR.relay._importKey(room.key);
  const msg = { t: 'offer', to: 'abc123', code: C.sdpToCode(CHROME_OFFER, 'offer', 42) };
  const sealed = await PYR.relay._seal(key, msg);
  assert.ok(!sealed.includes('offer') && !sealed.includes('PYR.'), 'le texte clair ne doit pas apparaître');
  assert.deepEqual(await PYR.relay._unseal(key, sealed), msg);
  // deux chiffrements du même message diffèrent (vecteur d'initialisation aléatoire)
  assert.notEqual(await PYR.relay._seal(key, msg), sealed);
  const bytes = C.fromB64u(sealed);
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(PYR.relay._unseal(key, C.toB64u(bytes)));
  const other = await PYR.relay._importKey(C.newRoom().key);
  await assert.rejects(PYR.relay._unseal(other, sealed));
  assert.ok(sealed.length < 1000, 'bien en dessous de la limite de 4 Ko du relais');
});
