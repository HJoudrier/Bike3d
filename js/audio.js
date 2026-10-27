/* Bike3D — sons procéduraux (Web Audio) : vent, roulement et « woum » des roues carbone à chaque
   coup de pédale, roue libre, foule qui applaudit, meuglements et clarines des vaches, cris des animaux
   (canards, chevaux, moutons, marmottes, aigles, corbeaux, oies, mouettes, pigeons), chants d'oiseaux,
   grenouilles et cigales, signaux de course (sifflet, fanfare, musette). */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  class Sound {
    constructor() {
      this.ctx = null;
      this.muted = false;
      this.nextTick = 0;
      this.clapAcc = 0;
      this.whistleT = 0;
    }

    // ctxOverride : contexte fourni (ex. OfflineAudioContext pour les tests)
    start(ctxOverride) {
      if (this.ctx) { if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC && !ctxOverride) return;
      const ctx = this.ctx = ctxOverride || new AC();
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(ctx.destination);
      const loop = (rate) => {
        const s = ctx.createBufferSource();
        s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
        s.start();
        return s;
      };
      // vent
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      loop(1).connect(bp); bp.connect(this.windGain); this.windGain.connect(this.master);
      this.windFilter = bp;
      // roulement des boyaux sur l'asphalte
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.8;
      this.rollGain = ctx.createGain();
      this.rollGain.gain.value = 0;
      loop(0.5).connect(lp); lp.connect(this.rollGain); this.rollGain.connect(this.master);
      // vrombissement des jantes carbone (bourdon grave qui suit la vitesse des roues)
      this.hum = ctx.createOscillator();
      this.hum.type = 'triangle';
      this.hum.frequency.value = 40;
      const humLp = ctx.createBiquadFilter();
      humLp.type = 'lowpass'; humLp.frequency.value = 220;
      this.humGain = ctx.createGain();
      this.humGain.gain.value = 0;
      this.hum.connect(humLp); humLp.connect(this.humGain); this.humGain.connect(this.master);
      this.hum.start();
      // rumeur de la foule
      const bp2 = ctx.createBiquadFilter();
      bp2.type = 'bandpass'; bp2.frequency.value = 1100; bp2.Q.value = 1.4;
      this.crowdGain = ctx.createGain();
      this.crowdGain.gain.value = 0;
      loop(0.7).connect(bp2); bp2.connect(this.crowdGain); this.crowdGain.connect(this.master);
      // cigales : souffle aigu haché par un trémolo rapide
      const bp3 = ctx.createBiquadFilter();
      bp3.type = 'bandpass'; bp3.frequency.value = 5200; bp3.Q.value = 4;
      const chop = ctx.createGain();
      chop.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.type = 'square'; lfo.frequency.value = 46;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 0.5;
      lfo.connect(lfoG); lfoG.connect(chop.gain); lfo.start();
      this.cicadaGain = ctx.createGain();
      this.cicadaGain.gain.value = 0;
      loop(1.3).connect(bp3); bp3.connect(chop); chop.connect(this.cicadaGain); this.cicadaGain.connect(this.master);
    }

    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
    }

    // Sortie stéréo : renvoie le nœud d'entrée d'une chaîne gain -> panoramique -> master.
    _out(vol, pan, t, attack, decay) {
      const ctx = this.ctx;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan || 0));
        g.connect(p); p.connect(this.master);
      } else g.connect(this.master);
      return g;
    }

    _noise(t, dur, offset) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.start(t, offset !== undefined ? offset : Math.random() * 1.5, dur);
      return src;
    }

    click() {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 3500;
      this._noise(t, 0.03).connect(hp);
      hp.connect(this._out(0.12, 0, t, 0.002, 0.025));
    }

    // Roues carbone : souffle grave et « woum » de la jante haute, à chaque coup de pédale.
    pedalStroke(speed, effort) {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const v = Math.min(1, speed / 14);
      const amp = (0.05 + 0.3 * v) * (0.45 + 0.55 * Math.min(1, effort));
      if (amp < 0.02) return;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 140 + speed * 10; bp.Q.value = 3.2;
      const src = this._noise(t, 0.45);
      src.playbackRate.value = 0.6 + 0.5 * v;
      src.connect(bp);
      bp.connect(this._out(amp * 5, 0, t, 0.08, 0.32));
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f = 70 + speed * 5;
      osc.frequency.setValueAtTime(f * 1.15, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.85, t + 0.35);
      osc.connect(this._out(amp * 1.1, 0, t, 0.08, 0.3));
      osc.start(t); osc.stop(t + 0.42);
    }

    // « Meuh ! » : dent de scie grave, vibrato et filtre qui s'ouvre (m... ouuuh).
    moo(vol, pan) {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const f0 = 95 + Math.random() * 45;
      const dur = 1.1 + Math.random() * 0.6;
      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.exponentialRampToValueAtTime(vol, t + 0.18);
      out.gain.setValueAtTime(vol, t + dur * 0.7);
      out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 7;
      lp.frequency.setValueAtTime(220, t);
      lp.frequency.linearRampToValueAtTime(950, t + 0.35);
      lp.frequency.linearRampToValueAtTime(480, t + dur);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5 + Math.random() * 2;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 3;
      lfo.connect(lfoG);
      for (const [mult, type, a] of [[1, 'sawtooth', 1], [2.01, 'square', 0.18]]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(f0 * 0.82 * mult, t);
        osc.frequency.linearRampToValueAtTime(f0 * 1.12 * mult, t + 0.3);
        osc.frequency.linearRampToValueAtTime(f0 * 0.78 * mult, t + dur);
        lfoG.connect(osc.frequency);
        const g = ctx.createGain();
        g.gain.value = a;
        osc.connect(g); g.connect(lp);
        osc.start(t); osc.stop(t + dur + 0.05);
      }
      lfo.start(t); lfo.stop(t + dur + 0.05);
      lp.connect(out);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan || 0));
        out.connect(p); p.connect(this.master);
      } else out.connect(this.master);
    }

    // Clarine : quelques partiels inharmoniques qui s'éteignent.
    bell(vol, pan) {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const base = 480 + Math.random() * 200;
      for (const [ratio, a, dur] of [[1, 1, 1.1], [2.76, 0.45, 0.55], [5.4, 0.22, 0.28]]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = base * ratio;
        osc.connect(this._out(vol * a, pan, t, 0.004, dur));
        osc.start(t); osc.stop(t + dur + 0.05);
      }
    }

    // Enveloppe avec tenue : montée, palier, extinction, puis panoramique.
    _env(vol, pan, t, attack, dur) {
      const ctx = this.ctx;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
      g.gain.setValueAtTime(Math.max(0.0002, vol), t + Math.max(attack, dur * 0.65));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan || 0));
        g.connect(p); p.connect(this.master);
      } else g.connect(this.master);
      return g;
    }

    // Cri animal générique : oscillateur avec glissando (f0 -> fMid -> f1), vibrato, trémolo et formant.
    _call(o) {
      const ctx = this.ctx, t = ctx.currentTime + (o.delay || 0), dur = o.dur;
      const osc = ctx.createOscillator();
      osc.type = o.type || 'sawtooth';
      osc.frequency.setValueAtTime(o.f0, t);
      if (o.fMid) osc.frequency.linearRampToValueAtTime(o.fMid, t + dur * (o.midAt || 0.3));
      osc.frequency.linearRampToValueAtTime(o.f1 || o.f0, t + dur);
      const nodes = [osc];
      if (o.vib) {
        const lfo = ctx.createOscillator(); lfo.frequency.value = o.vib[0];
        const g = ctx.createGain(); g.gain.value = o.vib[1];
        lfo.connect(g); g.connect(osc.frequency);
        nodes.push(lfo);
      }
      let node = osc;
      if (o.bp) {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = o.bp[0]; bp.Q.value = o.bp[1];
        node.connect(bp); node = bp;
      }
      const out = this._env(o.vol, o.pan, t, o.attack || 0.02, dur);
      if (o.trem) {
        const tg = ctx.createGain(); tg.gain.value = 0.55;
        const tl = ctx.createOscillator(); tl.frequency.value = o.trem;
        const td = ctx.createGain(); td.gain.value = o.tremDepth || 0.45;
        tl.connect(td); td.connect(tg.gain);
        node.connect(tg); tg.connect(out);
        nodes.push(tl);
      } else node.connect(out);
      for (const n of nodes) { n.start(t); n.stop(t + dur + 0.05); }
    }

    // Bruit filtré bref (souffle, froissement, battement d'ailes).
    _burst(t, dur, f, q, vol, pan, type) {
      const ctx = this.ctx;
      const bp = ctx.createBiquadFilter();
      bp.type = type || 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      this._noise(t, dur + 0.02).connect(bp);
      bp.connect(this._out(vol, pan, t, Math.min(0.02, dur * 0.3), dur));
    }

    // ------------------------------------------------------------ animaux
    animal(kind, vol, pan) {
      if (!this.ctx || this.muted || vol < 0.004) return;
      const ctx = this.ctx, t = ctx.currentTime, R = Math.random;
      switch (kind) {
        case 'duck': { // coin-coin nasillard
          const n = 2 + Math.floor(R() * 3), f = 240 + R() * 60;
          for (let k = 0; k < n; k++) this._call({ type: 'sawtooth', f0: f * 1.15, f1: f * 0.85, dur: 0.12, bp: [1150, 4], vol: vol * 1.8, pan, delay: k * (0.17 + R() * 0.05), attack: 0.01 });
          break;
        }
        case 'horse': { // hennissement : trille aiguë qui descend, puis ébrouement
          this._call({ type: 'sawtooth', f0: 820, fMid: 1080, midAt: 0.15, f1: 380, dur: 1.35, vib: [12, 75], trem: 9, bp: [1500, 2.2], vol, pan, attack: 0.05 });
          this._burst(t + 1.35, 0.3, 380, 0.9, vol * 0.8, pan);
          break;
        }
        case 'sheep': { // bêêê chevrotant
          const f = 190 + R() * 70;
          this._call({ type: 'sawtooth', f0: f * 1.05, f1: f * 0.92, dur: 0.6 + R() * 0.35, vib: [6, 5], trem: 7.5, tremDepth: 0.5, bp: [880, 3], vol, pan, attack: 0.04 });
          break;
        }
        case 'marmot': { // sifflement d'alerte, parfois répété
          const n = R() < 0.5 ? 1 : 2 + Math.floor(R() * 2);
          for (let k = 0; k < n; k++) this._call({ type: 'sine', f0: 2900, fMid: 2950, midAt: 0.1, f1: 2300, dur: 0.26, vol, pan, delay: k * 0.42, attack: 0.008 });
          break;
        }
        case 'eagle': { // « kiii-ya » rauque
          this._call({ type: 'triangle', f0: 1900, fMid: 2500, midAt: 0.2, f1: 1400, dur: 0.75, vib: [34, 90], vol, pan, attack: 0.03 });
          this._call({ type: 'sine', f0: 3800, fMid: 5000, midAt: 0.2, f1: 2800, dur: 0.6, vol: vol * 0.35, pan, attack: 0.03 });
          break;
        }
        case 'crow': { // croa croa
          const n = 2 + Math.floor(R() * 2);
          for (let k = 0; k < n; k++) {
            this._call({ type: 'sawtooth', f0: 640, f1: 470, dur: 0.24, bp: [1250, 2.5], vib: [55, 40], vol, pan, delay: k * 0.33, attack: 0.012 });
            this._burst(t + k * 0.33, 0.22, 1600, 1.5, vol * 0.5, pan);
          }
          break;
        }
        case 'goose': { // cacardements du vol en V
          const n = 3 + Math.floor(R() * 4);
          for (let k = 0; k < n; k++) this._call({ type: 'square', f0: 430 + R() * 60, f1: 360, dur: 0.15, bp: [950, 3], vol: vol * (0.6 + R() * 0.4), pan: pan + (R() - 0.5) * 0.3, delay: k * (0.22 + R() * 0.2), attack: 0.01 });
          break;
        }
        case 'gull': { // kyaaa
          this._call({ type: 'sawtooth', f0: 1350, fMid: 1750, midAt: 0.25, f1: 850, dur: 0.55, bp: [1800, 2], vib: [20, 45], vol, pan, attack: 0.03 });
          if (R() < 0.6) this._call({ type: 'sawtooth', f0: 1300, fMid: 1600, f1: 900, dur: 0.4, bp: [1800, 2], vib: [20, 45], vol: vol * 0.8, pan, delay: 0.6, attack: 0.03 });
          break;
        }
        case 'flutter': { // envol de pigeons : battements d'ailes
          const n = 10 + Math.floor(R() * 6);
          for (let k = 0; k < n; k++) this._burst(t + k * 0.055 + R() * 0.01, 0.045, 900 + R() * 900, 0.8, vol * 2 * (1 - k / n * 0.6), pan + (R() - 0.5) * 0.4);
          break;
        }
        case 'songbird': { // petite phrase de passereau
          const n = 3 + Math.floor(R() * 6), base = 2600 + R() * 2400;
          let d = 0;
          for (let k = 0; k < n; k++) {
            const f = base * (0.8 + R() * 0.5), len = 0.04 + R() * 0.07;
            this._call({ type: 'sine', f0: f, f1: f * (0.75 + R() * 0.6), dur: len, vol: vol * (0.6 + R() * 0.4), pan, delay: d, attack: 0.005 });
            d += len + 0.02 + R() * 0.06;
          }
          break;
        }
        case 'blackbird': { // merle : notes flûtées plus graves
          const n = 3 + Math.floor(R() * 4);
          let d = 0;
          for (let k = 0; k < n; k++) {
            const f = 1400 + R() * 1500, len = 0.1 + R() * 0.15;
            this._call({ type: 'sine', f0: f, fMid: f * (1 + (R() - 0.5) * 0.3), f1: f * (0.9 + R() * 0.25), dur: len, vib: [9, 25], vol, pan, delay: d, attack: 0.02 });
            d += len + 0.03 + R() * 0.08;
          }
          break;
        }
        case 'swallow': { // gazouillis d'hirondelle
          const n = 4 + Math.floor(R() * 5);
          for (let k = 0; k < n; k++) {
            const f = 4200 + R() * 2600;
            this._call({ type: 'sine', f0: f, f1: f * (0.7 + R() * 0.6), dur: 0.03, vol, pan, delay: k * (0.05 + R() * 0.04), attack: 0.004 });
          }
          break;
        }
        case 'frog': { // ribbit : deux trains d'impulsions
          const f = 120 + R() * 60;
          this._call({ type: 'square', f0: f, f1: f * 0.95, dur: 0.18, bp: [650, 4], trem: 32, tremDepth: 0.55, vol: vol * 1.6, pan, attack: 0.01 });
          this._call({ type: 'square', f0: f * 1.2, f1: f * 1.1, dur: 0.22, bp: [820, 4], trem: 28, tremDepth: 0.55, vol: vol * 1.6, pan, delay: 0.22, attack: 0.01 });
          break;
        }
        default: break;
      }
    }

    // ------------------------------------------------------------ signaux de course
    raceCue(kind) {
      if (!this.ctx || this.muted) return;
      const ctx = this.ctx, t = ctx.currentTime;
      if (kind === 'go') {
        // deux coups de sifflet d'arbitre
        for (const [t0, dur] of [[0, 0.14], [0.22, 0.38]]) {
          const osc = ctx.createOscillator();
          osc.type = 'square'; osc.frequency.value = 2850;
          const lfo = ctx.createOscillator(); lfo.frequency.value = 36;
          const lg = ctx.createGain(); lg.gain.value = 160;
          lfo.connect(lg); lg.connect(osc.frequency);
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4200;
          osc.connect(lp); lp.connect(this._env(0.045, 0, t + t0, 0.01, dur));
          for (const n of [osc, lfo]) { n.start(t + t0); n.stop(t + t0 + dur + 0.05); }
        }
      } else if (kind === 'win' || kind === 'line') {
        // petite fanfare (victoire) ou deux notes (ligne franchie)
        const notes = kind === 'win' ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 880];
        notes.forEach((f, k) => {
          const t0 = t + k * 0.12, dur = k === notes.length - 1 ? 0.6 : 0.14;
          for (const [type, mult, a] of [['square', 1, 0.035], ['triangle', 2, 0.03], ['sawtooth', 0.5, 0.015]]) {
            const osc = ctx.createOscillator();
            osc.type = type; osc.frequency.value = f * mult;
            osc.connect(this._env(a, 0, t0, 0.01, dur));
            osc.start(t0); osc.stop(t0 + dur + 0.05);
          }
        });
        if (kind === 'win') { this.whistle(0.06); this.clapAcc += 20; }
      } else if (kind === 'musette') {
        // musette arrachée au vol : souffle, froissement, puis « ding » du boost
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(2600, t + 0.25);
        this._noise(t, 0.3).connect(bp);
        bp.connect(this._out(0.35, 0.3, t, 0.04, 0.25));
        for (let k = 0; k < 7; k++) this._burst(t + 0.1 + k * 0.035 + Math.random() * 0.02, 0.03, 3000 + Math.random() * 2500, 1, 0.1, 0.3, 'highpass');
        for (const [f, d] of [[1318.5, 0.3], [1975.5, 0.42]]) {
          const osc = ctx.createOscillator();
          osc.type = 'sine'; osc.frequency.value = f;
          osc.connect(this._out(0.06, 0, t + d, 0.005, 0.5));
          osc.start(t + d); osc.stop(t + d + 0.6);
        }
      }
    }

    clap(vol) {
      const ctx = this.ctx, t = ctx.currentTime + Math.random() * 0.03;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1300 + Math.random() * 1400; bp.Q.value = 1.3;
      this._noise(t, 0.08).connect(bp);
      bp.connect(this._out(vol, (Math.random() - 0.5) * 1.6, t, 0.003, 0.06 + Math.random() * 0.04));
    }

    whistle(vol) {
      const ctx = this.ctx, t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f = 1300 + Math.random() * 700;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.6, t + 0.18);
      osc.frequency.exponentialRampToValueAtTime(f * 1.1, t + 0.4);
      osc.connect(this._out(vol, (Math.random() - 0.5) * 1.4, t, 0.03, 0.4));
      osc.start(t); osc.stop(t + 0.5);
    }

    silence() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      for (const g of [this.windGain, this.crowdGain, this.rollGain, this.humGain, this.cicadaGain]) g.gain.setTargetAtTime(0, t, 0.1);
    }

    // niveau des cigales (0..1), avec des phrases qui enflent et retombent
    setCicadas(level) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const swell = 0.6 + 0.4 * Math.sin(t * 0.37) * Math.sin(t * 0.23 + 1);
      this.cicadaGain.gain.setTargetAtTime(level * 0.09 * swell, t, 0.4);
    }

    // speed en m/s ; freewheel = roue libre ; crowd = 0..1 (densité de spectateurs proches)
    update(dt, speed, freewheel, crowd) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const w = Math.min(1, speed / 22);
      this.windGain.gain.setTargetAtTime(0.02 + w * w * 0.26, t, 0.2);
      this.windFilter.frequency.setTargetAtTime(300 + w * 900, t, 0.3);
      this.rollGain.gain.setTargetAtTime(Math.min(1, speed / 10) * 0.16, t, 0.15);
      this.hum.frequency.setTargetAtTime(38 + speed * 4.5, t, 0.2);
      this.humGain.gain.setTargetAtTime(w * w * 0.12, t, 0.2);
      this.crowdGain.gain.setTargetAtTime(crowd * 0.22 * (0.75 + 0.25 * Math.sin(t * 3.1) * Math.sin(t * 1.7)), t, 0.15);
      // applaudissements et sifflets
      if (crowd > 0.05) {
        this.clapAcc += dt * 34 * crowd;
        let n = 0;
        while (this.clapAcc >= 1 && n++ < 6) { this.clap(0.05 + 0.07 * crowd * Math.random()); this.clapAcc -= 1; }
        this.whistleT -= dt;
        if (crowd > 0.3 && this.whistleT <= 0) { this.whistle(0.05 * crowd); this.whistleT = 0.8 + Math.random() * 2.5 / crowd; }
      } else this.clapAcc = 0;
      if (freewheel && speed > 1) {
        this.nextTick -= dt;
        if (this.nextTick <= 0) {
          this.click();
          this.nextTick = 1 / Math.min(30, speed * 2.2);
        }
      }
    }
  }

  B3D.Sound = Sound;
})(typeof window !== 'undefined' ? window : globalThis);
