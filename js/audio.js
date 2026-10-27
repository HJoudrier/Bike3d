/* Bike3D — sons procéduraux (Web Audio) : vent, roulement et « woum » des roues carbone à chaque
   coup de pédale, roue libre, foule qui applaudit, meuglements et clarines des vaches. */
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
      for (const g of [this.windGain, this.crowdGain, this.rollGain, this.humGain]) g.gain.setTargetAtTime(0, t, 0.1);
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
