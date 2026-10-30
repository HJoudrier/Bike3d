/* author : Hugo Joudrier-Faure */
/* PaceYourRide — synchronisation du projet et de la bibliothèque avec un compte Dropbox (navigateur uniquement, sans serveur).
 * C'est le seul lien entre les applications : PaceYourRide écrit (sync, pushSoon : projet en cours, plan optimal et bibliothèque des parcours,
 * athlètes, vélos et tenues), les jeux et le compteur lisent (pull) et gardent une copie dans leur propre stockage local.
 * Connexion OAuth 2 avec PKCE (pas de secret côté navigateur), puis un seul fichier /paceyourride.json dans le dossier de l'application
 * (type d'accès « App folder » : Dropbox › Applications › <nom de l'app>). Il faut une application Dropbox (gratuite) : sa clé (« App key »)
 * se saisit dans la fenêtre de synchronisation de l'accueil, ou se fixe ici dans DEFAULT_APP_KEY.
 *
 * Fonctionnement : sync() télécharge le fichier, garde le projet le plus récent (date : paceyourride.v1.mtime, tenue par store.js), fusionne
 * les bibliothèques (library.merge), écrit le résultat ici puis le renvoie sur Dropbox si quelque chose a changé. L'envoi vise la version lue
 * (« rev ») : si un autre appareil est passé entre-temps, Dropbox refuse et la synchronisation recommence. Le projet écrasé sur cet appareil
 * est gardé dans paceyourride.v1.backup. Le stockage est celui de l'accueil : l'éditeur ouvert pendant ce temps ne voit pas le changement. */
(function (PYR) {
  'use strict';

  const L = PYR.library;

  const DEFAULT_APP_KEY = 'pgb4vvut22lmgbr';                       // clé de l'application Dropbox, si elle doit être la même pour tous les utilisateurs
  const CFG_KEY = 'paceyourride.cloud.v1';          // la connexion est commune aux applications du site (même origine) : on se connecte une fois
  const NS = PYR.storageNs || 'paceyourride';
  const PROJECT_KEY = NS + '.v1';                    // mêmes clés que Commun/js/core/store.js et library.js
  const MTIME_KEY = NS + '.v1.mtime';
  const BACKUP_KEY = NS + '.v1.backup';
  const PKCE_KEY = 'paceyourride.cloud.pkce';
  const FILE = '/paceyourride.json';
  const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
  const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';

  const listeners = [];
  const S = { busy: false, error: '', pulls: 0 };             // état visible de l'interface

  const emit = () => { for (const fn of listeners) { try { fn(status()); } catch (e) { console.error(e); } } };
  const readJSON = (k) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } };
  const writeJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const cfg = () => { const c = readJSON(CFG_KEY); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; };
  const saveCfg = (patch) => { writeJSON(CFG_KEY, Object.assign(cfg(), patch)); };

  const appKey = () => cfg().appKey || DEFAULT_APP_KEY;
  /** Adresse où Dropbox renvoie après la connexion : le portail, à la racine du site (index.html), à déclarer telle quelle dans la console de
   *  l'application Dropbox. Une seule adresse pour toutes les applications : le portail enregistre la connexion puis renvoie à la page d'où l'on vient. */
  const redirectUri = () => (PYR.root ? new URL('index.html', PYR.root).href : location.origin + location.pathname);

  function status() {
    const c = cfg();
    return { appKey: appKey(), needsKey: !DEFAULT_APP_KEY, connected: !!(c.refresh || c.access), busy: S.busy, error: S.error, lastSync: c.lastSync || 0, pulls: S.pulls, redirectUri: redirectUri() };
  }

  // ---------- Connexion (OAuth 2 + PKCE) ----------

  const b64url = (bytes) => btoa(String.fromCharCode.apply(null, Array.from(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };

  function setKey(key) { saveCfg({ appKey: String(key || '').trim() }); emit(); }

  /** Envoie l'utilisateur sur Dropbox pour qu'il autorise l'application ; il revient sur cette page avec ?code=… (voir completeLogin). */
  async function login() {
    const key = appKey();
    if (!key) throw new Error("Saisis d'abord la clé (App key) de ton application Dropbox.");
    if (!(globalThis.crypto && crypto.subtle)) throw new Error('La connexion à Dropbox demande une page en HTTPS (ou localhost).');
    const verifier = randomString(48), state = randomString(16);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, redirect: redirectUri(), returnTo: location.href.split('#')[0] }));
    location.href = AUTH_URL + '?' + new URLSearchParams({ client_id: key, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
      token_access_type: 'offline', redirect_uri: redirectUri(), state }).toString();
  }

  /** Au retour de Dropbox : échange le code contre les jetons. Renvoie 'connected', 'error' (message dans le statut) ou '' (pas un retour de Dropbox). */
  async function completeLogin() {
    const q = new URLSearchParams(location.search);
    if (!q.has('state') || !(q.has('code') || q.has('error'))) return '';
    history.replaceState(null, '', location.pathname + location.hash);
    const pk = readJSON(PKCE_KEY);
    try { localStorage.removeItem(PKCE_KEY); } catch (e) { /* stockage indisponible */ }
    if (!pk || pk.state !== q.get('state')) return '';
    if (q.has('error')) { S.error = q.get('error') === 'access_denied' ? 'Connexion refusée.' : 'Connexion impossible : ' + (q.get('error_description') || q.get('error')); emit(); return 'error'; }
    try {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), code_verifier: pk.verifier, redirect_uri: pk.redirect });
      saveCfg({ access: t.access_token, refresh: t.refresh_token || '', expiresAt: Date.now() + (t.expires_in || 14400) * 1000, lastSync: 0 });
      // un projet jamais synchronisé et sans date (créé avant la synchronisation) compte comme le plus récent pour ne pas être écrasé par un ancien du nuage
      if (!localStorage.getItem(MTIME_KEY) && L.routeLength(readJSON(PROJECT_KEY) || {}) > 0) localStorage.setItem(MTIME_KEY, String(Date.now()));
      S.error = ''; emit();
      // le retour de Dropbox arrive sur le portail : on revient à l'application d'où l'on est parti
      if (pk.returnTo && pk.returnTo !== location.href.split('#')[0] && /^https?:/.test(pk.returnTo)) { location.replace(pk.returnTo); return 'redirected'; }
      return 'connected';
    } catch (e) { S.error = e.message; emit(); return 'error'; }
  }

  async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({ client_id: appKey() }, params)).toString() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error === 'invalid_grant' ? 'Autorisation expirée ou révoquée : reconnecte-toi.' : 'Dropbox a refusé la connexion (' + (body.error_description || body.error || res.status) + ').'); e.code = body.error; throw e; }
    return body;
  }

  /** Oublie les jetons de cet appareil (la clé de l'application et les données restent ; le fichier Dropbox aussi). */
  function logout() { saveCfg({ access: '', refresh: '', expiresAt: 0, lastSync: 0 }); S.error = ''; emit(); }

  /** Jeton d'accès valable (renouvelé avec le jeton de rafraîchissement s'il est périmé). */
  async function accessToken() {
    const c = cfg();
    if (c.access && (!c.refresh || Date.now() < (c.expiresAt || 0) - 60000)) return c.access;
    if (!c.refresh) throw new Error('Session Dropbox expirée : reconnecte-toi.');
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh });
      saveCfg({ access: t.access_token, expiresAt: Date.now() + (t.expires_in || 14400) * 1000 });
      return t.access_token;
    } catch (e) { if (e.code === 'invalid_grant') saveCfg({ access: '', refresh: '' }); throw e; }
  }

  // ---------- Fichier sur Dropbox ----------

  /** Contenu et version du fichier, ou null s'il n'existe pas encore. */
  async function download() {
    const res = await fetch(DOWNLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + await accessToken(), 'Dropbox-API-Arg': JSON.stringify({ path: FILE }) } });
    if (res.status === 409) return null;                           // path/not_found
    if (!res.ok) throw new Error('Lecture sur Dropbox impossible (' + res.status + ').');
    let rev = '';
    try { rev = JSON.parse(res.headers.get('dropbox-api-result') || '{}').rev || ''; } catch (e) { /* pas de version : l'envoi écrasera */ }
    return { text: await res.text(), rev };
  }

  /** Envoie le fichier ; renvoie false si un autre appareil l'a modifié depuis la lecture (ou créé entre-temps). */
  async function upload(text, rev, exists) {
    const mode = rev ? { '.tag': 'update', update: rev } : exists ? { '.tag': 'overwrite' } : { '.tag': 'add' };
    const res = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: FILE, mode, autorename: false, mute: true }) }, body: text });
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(res.status === 507 ? 'Ton Dropbox est plein.' : 'Envoi sur Dropbox impossible (' + res.status + ').');
    return true;
  }

  // ---------- Fusion ----------

  const hasProject = (p) => !!p && typeof p === 'object' && L.routeLength(p) > 0;
  const mtime = () => { const v = Number(localStorage.getItem(MTIME_KEY)); return Number.isFinite(v) && v > 0 ? v : 0; };
  const fingerprint = (o) => JSON.stringify([o.savedAt, o.project, o.library]);

  /** Une passe de synchronisation. Renvoie { changed (cet appareil a reçu du nouveau), done (le nuage est à jour) }. `pushOnly` : n'écrit rien sur cet appareil (éditeur ouvert), envoie seulement ce qui est plus récent. */
  async function pass(pushOnly) {
    const remote = await download();
    let snap = null;
    if (remote) {
      try { snap = JSON.parse(remote.text); } catch (e) { throw new Error('Le fichier sur Dropbox est illisible : renomme-le ou supprime-le dans Dropbox.'); }
      if (!snap || typeof snap !== 'object' || snap.app !== 'PaceYourRide') throw new Error("Le fichier sur Dropbox n'est pas un fichier PaceYourRide.");
    }
    let project = readJSON(PROJECT_KEY), savedAt = hasProject(project) ? mtime() : 0, changed = false;
    if (!pushOnly && snap && hasProject(snap.project) && Number(snap.savedAt) > savedAt) {
      if (hasProject(project)) localStorage.setItem(BACKUP_KEY, JSON.stringify(project));
      project = snap.project; savedAt = Number(snap.savedAt);
      writeJSON(PROJECT_KEY, project); localStorage.setItem(MTIME_KEY, String(savedAt));
      changed = true;
    }
    const lib = L.normalize(readJSON(L.STORAGE_KEY)), merged = snap ? L.merge(lib, snap.library) : lib;
    if (!pushOnly && JSON.stringify(merged) !== JSON.stringify(lib)) { writeJSON(L.STORAGE_KEY, merged); changed = true; }
    // envoi seul : un projet du nuage plus récent n'est pas repris ici (l'éditeur est ouvert) mais n'est pas écrasé non plus
    if (pushOnly && snap && hasProject(snap.project) && Number(snap.savedAt) > savedAt) { project = snap.project; savedAt = Number(snap.savedAt); }
    const out = { app: 'PaceYourRide', kind: 'cloud', version: 1, savedAt, project: hasProject(project) ? project : null, library: merged };
    if (snap && fingerprint(out) === fingerprint({ savedAt: Number(snap.savedAt) || 0, project: hasProject(snap.project) ? snap.project : null, library: L.normalize(snap.library) })) return { changed, done: true };
    return { changed, done: await upload(JSON.stringify(out), remote ? remote.rev : '', !!remote) };
  }

  let running = null, again = false, timer = 0;

  /** Synchronise maintenant. Les appels simultanés n'en font qu'une (plus une seconde si une demande est arrivée pendant la première). */
  function sync(pushOnly) {
    if (running) { again = true; return running; }
    S.busy = true; S.error = ''; emit();
    running = (async () => {
      let changed = false;
      try {
        for (let i = 0; i < 4; i++) {
          const r = await pass(pushOnly);
          changed = changed || r.changed;
          if (r.done) break;
          if (i === 3) throw new Error('Un autre appareil modifie le fichier en même temps : réessaie dans un instant.');
        }
        saveCfg({ lastSync: Date.now() });
        if (changed) S.pulls++;                                    // l'interface relit le projet et la bibliothèque
      } catch (e) { S.error = e instanceof TypeError ? 'Dropbox est injoignable (connexion ?).' : (e && e.message) || 'Synchronisation impossible.'; }
      S.busy = false; running = null; emit();
      if (again && !S.error) { again = false; return sync(pushOnly).then((r) => changed || r); }
      again = false;
      return changed;
    })();
    return running;
  }

  /** Synchronise dans un instant (regroupe plusieurs modifications de suite). Sans effet si l'appareil n'est pas connecté. */
  function syncSoon(ms) {
    if (!status().connected) return;
    clearTimeout(timer);
    timer = setTimeout(sync, ms || 1500);
  }

  /** Envoie dans un instant ce que l'éditeur vient d'enregistrer, sans rien reprendre du nuage (pages de PaceYourRide, projet ouvert). */
  let pushTimer = 0;
  function pushSoon(ms) {
    if (!status().connected) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => sync(true), ms || 4000);
  }

  /**
   * Lecture seule, pour les jeux et le compteur : ce que PaceYourRide a mis dans Dropbox, sans toucher au stockage de cette application.
   * Renvoie { library (normalisée), project (le projet en cours de PaceYourRide, avec son plan optimal, ou null), savedAt, pulledAt }, ou null
   * si Dropbox ne contient encore rien. Lève une erreur lisible si la connexion échoue.
   */
  async function pull() {
    S.busy = true; S.error = ''; emit();
    try {
      const remote = await download();
      if (!remote) return null;
      let snap = null;
      try { snap = JSON.parse(remote.text); } catch (e) { throw new Error('Le fichier sur Dropbox est illisible.'); }
      if (!snap || typeof snap !== 'object' || snap.app !== 'PaceYourRide') throw new Error("Le fichier sur Dropbox n'est pas un fichier PaceYourRide.");
      saveCfg({ lastSync: Date.now() });
      return { library: L.normalize(snap.library), project: hasProject(snap.project) ? snap.project : null, savedAt: Number(snap.savedAt) || 0, pulledAt: Date.now() };
    } catch (e) {
      S.error = e instanceof TypeError ? 'Dropbox est injoignable (connexion ?).' : (e && e.message) || 'Lecture impossible.';
      throw new Error(S.error);
    } finally { S.busy = false; emit(); }
  }

  PYR.cloud = { status, setKey, login, completeLogin, logout, sync, syncSoon, pushSoon, pull, onChange: (fn) => listeners.push(fn) };
})(globalThis.PYR = globalThis.PYR || {});
