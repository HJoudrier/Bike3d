/* author : Hugo Joudrier-Faure */
/* PaceYourRide — petits utilitaires DOM (navigateur uniquement). */
(function (PYR) {
  'use strict';

  const D = {};

  D.$ = (sel, root) => (root || document).querySelector(sel);
  D.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /**
   * Crée un élément : h('div', {class: 'x', onclick: fn}, 'texte', autreElement).
   * Les chaînes deviennent des nœuds texte (jamais d'innerHTML sur des données).
   */
  D.h = function (tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  };

  /** Crée un élément SVG. */
  D.svg = function (tag, attrs, ...children) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
    for (const c of children.flat()) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  };

  D.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  D.fillSelect = function (select, options, value) {
    D.clear(select);
    for (const o of options) select.appendChild(D.h('option', { value: o.id }, o.label));
    if (value !== undefined) select.value = value;
  };

  D.stat = function (label, value, unit) {
    return D.h('div', { class: 'stat' }, D.h('span', null, label), D.h('strong', null, value), unit ? D.h('em', null, unit) : null);
  };

  D.toast = function (msg, type, ms) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const t = D.h('div', { class: 'toast' + (type ? ' ' + type : '') }, msg);
    box.appendChild(t);
    while (box.children.length > 4) box.firstElementChild.remove(); // jamais plus de 4 à l'écran
    setTimeout(() => t.remove(), ms || (type === 'error' ? 6000 : 3500));
  };

  D.download = function (filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = D.h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  D.readFile = function (file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });
  };

  /**
   * Fenêtre modale (élément <dialog>).
   * actions : [{label, primary, onClick}] — onClick peut renvoyer false (ou une promesse de false)
   * pour garder la fenêtre ouverte ; sans onClick, le bouton ferme.
   */
  D.modal = function ({ title, body, actions, onClose, wide }) {
    const dlg = D.h('dialog', { class: 'modal' + (wide ? ' wide' : '') });
    const head = D.h('h3', null, title || '');
    const content = D.h('div', { class: 'modal-body' });
    const bar = D.h('div', { class: 'modal-actions' });
    let closed = false;
    const api = {
      el: dlg, body: content,
      close() {
        if (closed) return;
        closed = true;
        if (dlg.open) dlg.close();
        dlg.remove();
        if (onClose) onClose();
      },
      setTitle(t) { head.textContent = t; },
      setBody(nodes) { D.clear(content); for (const n of [].concat(nodes || [])) if (n) content.appendChild(n); },
      setActions(list) {
        D.clear(bar);
        for (const a of list || [{ label: 'Fermer' }]) {
          const b = D.h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), type: 'button' }, a.label);
          b.addEventListener('click', async () => {
            if (!a.onClick) { api.close(); return; }
            b.disabled = true;
            try { const r = await a.onClick(api); if (r !== false) api.close(); } finally { b.disabled = false; }
          });
          bar.appendChild(b);
        }
      },
      get closed() { return closed; },
    };
    api.setBody(body);
    api.setActions(actions);
    dlg.append(head, content, bar);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); api.close(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    return api;
  };

  /** Copie un texte dans le presse-papiers (avec repli si l'API n'est pas disponible). */
  D.copy = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const host = document.querySelector('dialog[open]') || document.body;
      const ta = D.h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
      ta.value = text;
      host.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  };

  /** Valeur CSS d'une variable de thème (--nom). */
  D.cssVar = function (name, el) {
    return getComputedStyle(el || document.documentElement).getPropertyValue(name).trim();
  };

  PYR.dom = D;
})(globalThis.PYR = globalThis.PYR || {});
