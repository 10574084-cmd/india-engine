export type EaseFn = (t: number) => number;

const PI = Math.PI, PI2 = Math.PI / 2;
const B1 = 1 / 2.75, B2 = 2 / 2.75, B3 = 1.5 / 2.75, B4 = 2.5 / 2.75, B5 = 2.25 / 2.75, B6 = 2.625 / 2.75;
const ELASTIC_AMP = 1, ELASTIC_PERIOD = 0.4;

const bounceOut: EaseFn = t => {
  if (t < B1) return 7.5625 * t * t;
  if (t < B2) return 7.5625 * (t - B3) * (t - B3) + 0.75;
  if (t < B4) return 7.5625 * (t - B5) * (t - B5) + 0.9375;
  return 7.5625 * (t - B6) * (t - B6) + 0.984375;
};
const base: Record<string, EaseFn> = {
  linear: t => t,
  quadIn: t => t * t, quadOut: t => -t * (t - 2),
  quadInOut: t => t <= 0.5 ? t * t * 2 : 1 - (--t) * t * 2,
  cubeIn: t => t * t * t, cubeOut: t => 1 + (--t) * t * t,
  cubeInOut: t => t <= 0.5 ? t * t * t * 4 : 1 + (--t) * t * t * 4,
  quartIn: t => t * t * t * t, quartOut: t => 1 - (t -= 1) * t * t * t,
  quartInOut: t => t <= 0.5 ? t * t * t * t * 8 : (1 - (t = t * 2 - 2) * t * t * t) / 2 + 0.5,
  quintIn: t => t * t * t * t * t, quintOut: t => (t = t - 1) * t * t * t * t + 1,
  quintInOut: t => ((t *= 2) < 1) ? (t * t * t * t * t) / 2 : ((t -= 2) * t * t * t * t + 2) / 2,
  smoothStepIn: t => 2 * (t * t * (3 - 2 * t)) - t,
  smoothStepOut: t => t - (2 * (t * t * (3 - 2 * t)) - t),
  smoothStepInOut: t => t * t * (3 - 2 * t),
  smootherStepIn: t => 2 * (t * t * t * (t * (t * 6 - 15) + 10)) - t,
  smootherStepOut: t => t - (2 * (t * t * t * (t * (t * 6 - 15) + 10)) - t),
  smootherStepInOut: t => t * t * t * (t * (t * 6 - 15) + 10),
  sineIn: t => -Math.cos(PI2 * t) + 1, sineOut: t => Math.sin(PI2 * t),
  sineInOut: t => -Math.cos(PI * t) / 2 + 0.5,
  bounceIn: t => 1 - bounceOut(1 - t), bounceOut,
  bounceInOut: t => t < 0.5 ? (1 - bounceOut(1 - t * 2)) / 2 : bounceOut(t * 2 - 1) / 2 + 0.5,
  circIn: t => -(Math.sqrt(1 - t * t) - 1), circOut: t => Math.sqrt(1 - (t - 1) * (t - 1)),
  circInOut: t => t <= 0.5 ? (Math.sqrt(1 - t * t * 4) - 1) / -2 : (Math.sqrt(1 - (t * 2 - 2) * (t * 2 - 2)) + 1) / 2,
  expoIn: t => Math.pow(2, 10 * (t - 1)), expoOut: t => -Math.pow(2, -10 * t) + 1,
  expoInOut: t => t < 0.5 ? Math.pow(2, 10 * (t * 2 - 1)) / 2 : (-Math.pow(2, -10 * (t * 2 - 1)) + 2) / 2,
  backIn: t => t * t * (2.70158 * t - 1.70158),
  backOut: t => 1 - (--t) * (t) * (-2.70158 * t - 1.70158),
  backInOut: t => { t *= 2; if (t < 1) return t * t * (2.70158 * t - 1.70158) / 2; t -= 2; return (1 - t * t * (-2.70158 * t - 1.70158)) / 2 + 0.5; },
  elasticIn: t => -(ELASTIC_AMP * Math.pow(2, 10 * (t -= 1)) * Math.sin((t - (ELASTIC_PERIOD / (2 * PI) * Math.asin(1 / ELASTIC_AMP))) * (2 * PI) / ELASTIC_PERIOD)),
  elasticOut: t => ELASTIC_AMP * Math.pow(2, -10 * t) * Math.sin((t - (ELASTIC_PERIOD / (2 * PI) * Math.asin(1 / ELASTIC_AMP))) * (2 * PI) / ELASTIC_PERIOD) + 1,
  elasticInOut: t => t < 0.5
    ? -0.5 * (ELASTIC_AMP * Math.pow(2, 10 * (t = t * 2 - 1)) * Math.sin((t - (ELASTIC_PERIOD / 4)) * (2 * PI) / ELASTIC_PERIOD))
    : ELASTIC_AMP * Math.pow(2, -10 * (t = t * 2 - 1)) * Math.sin((t - (ELASTIC_PERIOD / 4)) * (2 * PI) / ELASTIC_PERIOD) * 0.5 + 1,
};
// alias usados por Psych (cubeIn en Flixel se llama "cubeIn")
base.cubicIn = base.cubeIn; base.cubicOut = base.cubeOut; base.cubicInOut = base.cubeInOut;

export function ease(name?: string): EaseFn {
  if (!name) return base.linear;
  return base[name] ?? base[name.charAt(0).toLowerCase() + name.slice(1)] ?? base.linear;
}

export interface TweenOpts {
  ease?: string | EaseFn;
  delay?: number;
  onComplete?: () => void;
  onUpdate?: (t: Tween) => void;
  tag?: string;
  loop?: 'none' | 'looping' | 'pingpong';
}

export class Tween {
  elapsed = 0;
  finished = false;
  paused = false;
  private from: number[] = [];
  private keys: string[];
  private fn: EaseFn;
  private started = false;
  private forward = true;
  tag: string;
  get progress() { return Math.min(1, Math.max(0, this.elapsed / Math.max(this.duration, 1e-6))); }
  constructor(public target: any, public to: Record<string, number>, public duration: number, public opts: TweenOpts = {}) {
    this.keys = Object.keys(to);
    this.fn = typeof opts.ease === 'function' ? opts.ease : ease(opts.ease as string);
    this.tag = opts.tag ?? '';
    this.elapsed = -(opts.delay ?? 0);
  }
  update(dt: number) {
    if (this.finished || this.paused) return;
    this.elapsed += dt;
    if (this.elapsed < 0) return;
    if (!this.started) { this.started = true; this.from = this.keys.map(k => +this.target[k] || 0); }
    const dur = Math.max(this.duration, 1e-6);
    let p = Math.min(1, this.elapsed / dur);
    const e = this.fn(this.forward ? p : 1 - p);
    this.keys.forEach((k, i) => { this.target[k] = this.from[i] + (this.to[k] - this.from[i]) * e; });
    this.opts.onUpdate?.(this);
    if (p >= 1) {
      if (this.opts.loop === 'looping') { this.elapsed = 0; }
      else if (this.opts.loop === 'pingpong') { this.elapsed = 0; this.forward = !this.forward; }
      else { this.finished = true; this.opts.onComplete?.(); }
    }
  }
  cancel() { this.finished = true; }
}

export class Timer {
  elapsed = 0; loopsLeft: number; finished = false; paused = false;
  constructor(public time: number, public loops: number, public cb: (t: Timer) => void, public tag = '') { this.loopsLeft = loops; }
  get elapsedLoops() { return this.loops - this.loopsLeft; }
  update(dt: number) {
    if (this.finished || this.paused) return;
    this.elapsed += dt;
    while (this.elapsed >= this.time && !this.finished) {
      this.elapsed -= this.time;
      if (this.loops > 0) { this.loopsLeft--; if (this.loopsLeft <= 0) this.finished = true; }
      this.cb(this);
    }
  }
  cancel() { this.finished = true; }
}

export class TweenManager {
  tweens: Tween[] = [];
  timers: Timer[] = [];
  tween(target: any, to: Record<string, number>, duration: number, opts: TweenOpts = {}) {
    const t = new Tween(target, to, duration, opts); this.tweens.push(t); return t;
  }
  timer(time: number, loops: number, cb: (t: Timer) => void, tag = '') {
    const t = new Timer(time, loops, cb, tag); this.timers.push(t); return t;
  }
  update(dt: number) {
    for (const t of [...this.tweens]) t.update(dt);
    for (const t of [...this.timers]) t.update(dt);
    this.tweens = this.tweens.filter(t => !t.finished);
    this.timers = this.timers.filter(t => !t.finished);
  }
  cancelTag(tag: string) { for (const t of this.tweens) if (t.tag === tag) t.cancel(); }
  cancelTimer(tag: string) { for (const t of this.timers) if (t.tag === tag) t.cancel(); }
  hasTween(tag: string) { return this.tweens.some(t => t.tag === tag && !t.finished); }
  setPaused(p: boolean) { for (const t of this.tweens) t.paused = p; for (const t of this.timers) t.paused = p; }
  clear() { this.tweens = []; this.timers = []; }
}
