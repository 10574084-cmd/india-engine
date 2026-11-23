/** Audio con WebAudio. El reloj de la canción usa ctx.currentTime para no desincronizarse. */

export class Track {
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode;
  private _vol = 1;
  private _rate = 1;
  playing = false;
  /** instante (ctx.currentTime) en que la posición 0 del buffer suena */
  anchor = 0;
  onEnded?: () => void;
  constructor(private audio: AudioSys, public buffer: AudioBuffer | null, public loop = false) {
    this.gain = audio.ctx.createGain();
    this.gain.connect(audio.master);
  }
  get duration() { return this.buffer?.duration ?? 0; }
  get volume() { return this._vol; }
  set volume(v: number) { this._vol = v; this.gain.gain.value = v; }
  get pitch() { return this._rate; }
  set pitch(r: number) {
    // cambiar la velocidad en caliente mantiene la posición actual
    if (this.playing) { const t = this.time; this._rate = r; if (this.src) this.src.playbackRate.value = r; this.anchor = this.audio.ctx.currentTime - t / r; }
    else this._rate = r;
  }
  /** posición actual en segundos del buffer */
  get time() { return this.playing ? (this.audio.ctx.currentTime - this.anchor) * this._rate : 0; }

  /** Empieza a sonar en `when` (tiempo de ctx) desde `offset` segundos del buffer. */
  start(when: number, offset = 0) {
    this.stop();
    if (!this.buffer) return;
    const s = this.audio.ctx.createBufferSource();
    s.buffer = this.buffer; s.loop = this.loop; s.playbackRate.value = this._rate;
    s.connect(this.gain);
    s.onended = () => { if (this.src === s) { this.playing = false; this.src = null; this.onEnded?.(); } };
    const now = this.audio.ctx.currentTime;
    if (offset < 0) { when = Math.max(when, now) + (-offset) / this._rate; offset = 0; }
    if (when < now) { offset += (now - when) * this._rate; when = now; }
    if (offset >= this.buffer.duration && !this.loop) return;
    s.start(when, offset);
    this.anchor = when - offset / this._rate;
    this.src = s; this.playing = true;
  }
  play(offset = 0) { this.start(this.audio.ctx.currentTime, offset); }
  stop() {
    if (this.src) { const s = this.src; this.src = null; s.onended = null; try { s.stop(); } catch { /* ya parado */ } s.disconnect(); }
    this.playing = false;
  }
  fade(to: number, seconds: number, from = this._vol) {
    const g = this.gain.gain, t = this.audio.ctx.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(from, t); g.linearRampToValueAtTime(to, t + Math.max(0.001, seconds));
    this._vol = to;
  }
  destroy() { this.stop(); this.gain.disconnect(); }
}

export class AudioSys {
  ctx: AudioContext;
  master: GainNode;
  constructor() {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }
  async resume() { if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* sin gesto de usuario aún */ } } }
  async decode(buf: ArrayBuffer): Promise<AudioBuffer> {
    return await this.ctx.decodeAudioData(buf.slice(0));
  }
  track(buffer: AudioBuffer | null, loop = false) { return new Track(this, buffer, loop); }
  /** sonido corto de un solo uso */
  playSound(buffer: AudioBuffer | null, volume = 1, pitch = 1): Track | null {
    if (!buffer) return null;
    const t = new Track(this, buffer, false);
    t.volume = volume; t.pitch = pitch;
    t.onEnded = () => t.destroy();
    t.play(0);
    return t;
  }
}
