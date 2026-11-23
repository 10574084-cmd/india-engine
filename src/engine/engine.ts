import { VFS } from './vfs';
import { AudioSys } from './audio';
import { Assets } from './assets';
import { Input } from './input';
import { TweenManager } from './tween';
import { Prefs, loadPrefs, savePrefs } from './save';
import { W, H } from './display';

export interface State {
  init?(): Promise<void>;
  update(dt: number): void;
  render(ctx: CanvasRenderingContext2D): void;
  destroy(): void;
  /** teclas crudas (para menús) */
  keyDown?(code: string, ev: KeyboardEvent): void;
}

export const ENGINE_NAME = 'India Engine';
export const ENGINE_VERSION = '0.1.0';
/** Versión de Psych que emulamos; los mods la leen desde Lua (`version`). */
export const PSYCH_COMPAT_VERSION = '0.7.3';

export class Engine {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  vfs = new VFS();
  audio = new AudioSys();
  assets: Assets;
  prefs: Prefs;
  input: Input;
  tweens = new TweenManager();
  state: State | null = null;
  private last = 0;
  private switching = false;
  fps = 0; private fpsAcc = 0; private fpsN = 0;
  /** mensajes flotantes (errores de Lua, avisos) */
  toasts: { text: string; t: number; color: string }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.prefs = loadPrefs();
    this.audio.master.gain.value = this.prefs.volume;
    this.input = new Input(this.prefs);
    this.assets = new Assets(this.vfs, this.audio);
    this.input.onRawKey = (code, down, ev) => { if (down) this.state?.keyDown?.(code, ev); };
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const aw = window.innerWidth, ah = window.innerHeight;
      const s = Math.min(aw / W, ah / H);
      const cw = Math.floor(W * s), ch = Math.floor(H * s);
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      canvas.width = Math.floor(cw * dpr); canvas.height = Math.floor(ch * dpr);
    };
    window.addEventListener('resize', resize); resize();
    // el AudioContext necesita un gesto de usuario
    const unlock = () => { this.audio.resume(); };
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
  }

  savePrefs() { savePrefs(this.prefs); }

  toast(text: string, color = '#ffffff', seconds = 4) {
    this.toasts.push({ text, t: seconds, color });
    if (this.toasts.length > 6) this.toasts.shift();
  }

  async switchState(make: State | (() => State | Promise<State>)) {
    if (this.switching) return;
    this.switching = true;
    try {
      const old = this.state;
      const next = typeof make === 'function' ? await make() : make;
      this.tweens.clear();
      if (next.init) await next.init();
      this.state = next;
      old?.destroy();
    } finally { this.switching = false; }
  }

  start() {
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.fpsAcc += dt; this.fpsN++;
      if (this.fpsAcc >= 0.5) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
      this.tick(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private tick(dt: number) {
    for (const t of this.toasts) t.t -= dt;
    this.toasts = this.toasts.filter(t => t.t > 0);
    this.tweens.update(dt);
    if (this.state && !this.switching) {
      try { this.state.update(dt); } catch (e) { console.error(e); this.toast('Error: ' + (e as Error).message, '#ff6666', 6); }
    }
    this.input.endFrame();
    const ctx = this.ctx;
    const k = this.canvas.width / W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (this.state) {
      try { this.state.render(ctx); } catch (e) { console.error(e); }
    }
    // toasts
    ctx.save();
    ctx.font = '16px "vcr", "VCR OSD Mono", monospace'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
    this.toasts.forEach((t, i) => {
      ctx.globalAlpha = Math.min(1, t.t);
      ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.strokeText(t.text, 12, 12 + i * 22);
      ctx.fillStyle = t.color; ctx.fillText(t.text, 12, 12 + i * 22);
    });
    ctx.restore();
  }
}
