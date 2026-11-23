// Test stub for Tone.js: slow start() (first-tap race); logs instruments, clicks, parts and transport.
// window.__samplerMode: 'load' (default) | 'error' | 'slow' | 'hang'
(function () {
  const log = window.__synthLog = [];
  window.__parts = []; window.__clicks = [];
  let started = false;
  const T = window.Tone = {
    start: () => started ? Promise.resolve() : new Promise(r => setTimeout(() => { started = true; r(); }, 150)),
    now: () => performance.now() / 1000,
    Frequency: m => ({ toNote: () => 'M' + m }),
    Time: () => ({ toSeconds: () => 0.1 }),
    Draw: { schedule: fn => setTimeout(fn, 0) },
    Transport: { PPQ: 192, ticks: 0, state: 'stopped', loop: false, loopStart: 0, loopEnd: 0, bpm: { value: 100, rampTo(v) { this.value = v; } },
      start(time, offset) { this.state = 'started'; window.__tstart = { time, offset, now: T.now(), bpm: this.bpm.value, loop: this.loop, loopStart: this.loopStart, loopEnd: this.loopEnd }; },
      stop() { this.state = 'stopped'; }, cancel() {}, scheduleOnce() { return 1; } },
    Part: function (cb, events) { window.__parts.push({ cb, events }); this.start = () => this; this.dispose = () => {}; },
    Synth: function () {
      this.volume = { value: 0 };
      this.toDestination = () => this;
      this.triggerAttackRelease = (n, d, t, v) => window.__clicks.push({ note: n, time: t, accent: n === 'C6' });
    },
    PolySynth: function () {
      this.toDestination = () => this;
      this.triggerAttack = n => log.push('synth attack ' + n);
      this.triggerRelease = n => log.push('synth release ' + n);
      this.triggerAttackRelease = n => log.push('synth ar ' + n);
      this.releaseAll = () => {};
    },
    Sampler: function (opts) {
      window.__samplerOpts = { urls: Object.keys(opts.urls).length, baseUrl: opts.baseUrl };
      const mode = window.__samplerMode || 'load';
      if (mode === 'load') setTimeout(() => opts.onload && opts.onload(), 300);
      if (mode === 'slow') setTimeout(() => opts.onload && opts.onload(), 1500);
      if (mode === 'error') setTimeout(() => opts.onerror && opts.onerror(new Error('404')), 100);
      this.toDestination = () => this;
      this.triggerAttack = n => log.push('piano attack ' + n);
      this.triggerRelease = n => log.push('piano release ' + n);
      this.triggerAttackRelease = n => log.push('piano ar ' + n);
      this.releaseAll = () => {};
    }
  };
})();
