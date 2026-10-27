/* Bike3D — sons procéduraux (vent, roue libre, encouragements) via Web Audio. */
(function (root) {
  'use strict';
  const B3D = root.B3D = root.B3D || {};

  class Sound {
    constructor() {
      this.ctx = null;
      this.muted = false;
      this.nextTick = 0;
    }

    start() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC();
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(ctx.destination);
      // vent
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      src.connect(bp); bp.connect(this.windGain); this.windGain.connect(this.master);
      src.start();
      this.windFilter = bp;
      // foule
      const src2 = ctx.createBufferSource();
      src2.buffer = buf; src2.loop = true; src2.playbackRate.value = 0.7;
      const bp2 = ctx.createBiquadFilter();
      bp2.type = 'bandpass'; bp2.frequency.value = 1100; bp2.Q.value = 1.4;
      this.crowdGain = ctx.createGain();
      this.crowdGain.gain.value = 0;
      src2.connect(bp2); bp2.connect(this.crowdGain); this.crowdGain.connect(this.master);
      src2.start();
    }

    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
    }

    click() {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 3500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
      src.connect(hp); hp.connect(g); g.connect(this.master);
      src.start(t, Math.random(), 0.03);
    }

    // speed en m/s ; freewheel = roue libre ; crowd = 0..1
    update(dt, speed, freewheel, crowd) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const w = Math.min(1, speed / 22);
      this.windGain.gain.setTargetAtTime(0.02 + w * w * 0.35, t, 0.2);
      this.windFilter.frequency.setTargetAtTime(300 + w * 900, t, 0.3);
      this.crowdGain.gain.setTargetAtTime(crowd * 0.25 * (0.75 + 0.25 * Math.sin(t * 3.1) * Math.sin(t * 1.7)), t, 0.15);
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
