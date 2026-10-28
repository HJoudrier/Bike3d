/* author : Hugo Joudrier-Faure */
/* PaceYourRide — QR codes : génération (qrcode-generator) et lecture (caméra ou image, jsQR). */
(function (PYR) {
  'use strict';

  const D = PYR.dom;
  const { h } = D;
  const QUIET = 4;

  function build(text, ec) {
    const qr = qrcode(0, ec || 'M');
    qr.addData(text, 'Byte');
    qr.make();
    return qr;
  }

  /** QR code en SVG (net à toutes les tailles). */
  function svg(text, label) {
    const qr = build(text);
    const n = qr.getModuleCount(), size = n + 2 * QUIET;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QUIET},${r + QUIET}h1v1h-1z`;
    }
    return D.svg('svg', { class: 'qr', viewBox: `0 0 ${size} ${size}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': label || 'QR code' },
      D.svg('rect', { width: size, height: size, fill: '#ffffff' }),
      D.svg('path', { d, fill: '#000000' }));
  }

  /** QR code en image PNG (pour l'envoyer par messagerie). */
  function png(text, scale) {
    const qr = build(text);
    const n = qr.getModuleCount(), k = scale || 8, size = (n + 2 * QUIET) * k;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + QUIET) * k, (r + QUIET) * k, k, k);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  /* ---------- lecture ---------- */
  let jsqrPromise = null;
  function loadJsQR() {
    if (typeof jsQR === 'function') return Promise.resolve();
    if (!jsqrPromise) {
      jsqrPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/jsqr/jsQR.js';
        s.onload = () => resolve();
        s.onerror = () => { jsqrPromise = null; reject(new Error('Lecteur de QR code indisponible')); };
        document.head.appendChild(s);
      });
    }
    return jsqrPromise;
  }

  function decodeCanvas(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
  }

  /** Lit un QR code dans une image (capture d'écran, photo). */
  async function decodeImage(file) {
    await loadJsQR();
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    for (const maxDim of [1400, 900, 600, 2000]) {
      const sc = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      canvas.width = Math.max(1, Math.round(bmp.width * sc));
      canvas.height = Math.max(1, Math.round(bmp.height * sc));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const t = decodeCanvas(canvas);
      if (t) return t;
    }
    return null;
  }

  /**
   * Scanne avec la caméra dans le conteneur donné. Renvoie une fonction d'arrêt.
   * onResult(texte) est appelé une seule fois.
   */
  async function scanCamera(container, onResult) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Caméra indisponible (il faut une page en https).');
    const video = h('video', { class: 'qr-video', playsinline: true, muted: true, autoplay: true });
    video.setAttribute('playsinline', '');
    container.appendChild(video);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      video.remove(); // autorisation refusée ou pas de caméra
      throw e;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    let detector = null;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) { detector = null; }
    }
    if (!detector) await loadJsQR();
    const canvas = document.createElement('canvas');
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
    };
    const tick = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2 && video.videoWidth) {
          let text = null;
          if (detector) {
            const found = await detector.detect(video);
            if (found.length) text = found[0].rawValue;
          } else {
            const sc = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * sc);
            canvas.height = Math.round(video.videoHeight * sc);
            canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
            text = decodeCanvas(canvas);
          }
          if (text) { stop(); onResult(text); return; }
        }
      } catch (e) { /* image suivante */ }
      setTimeout(tick, 180);
    };
    tick();
    return stop;
  }

  PYR.qr = { svg, png, decodeImage, scanCamera, loadJsQR };
})(globalThis.PYR = globalThis.PYR || {});
