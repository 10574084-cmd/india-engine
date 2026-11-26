/** Atlas de Adobe Animate (Animation.json + spritemapN.json/png), al estilo FlxAnimate. */
import type { Assets } from './assets';
import type { Camera, Drawable } from './display';

interface Mat { a: number; b: number; c: number; d: number; tx: number; ty: number }
interface Elem { sym?: string; sprite?: string; m: Mat; type: string; first: number; loop: string }
interface Frame { index: number; duration: number; elements: Elem[] }
interface Layer { frames: Frame[] }
interface Timeline { layers: Layer[]; length: number }
interface SpriteRect { x: number; y: number; w: number; h: number; img: CanvasImageSource }

const mat = (m: any): Mat => m ? { a: m.m00, b: m.m01, c: m.m10, d: m.m11, tx: m.m30, ty: m.m31 } : { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function parseTimeline(t: any): Timeline {
  const layers: Layer[] = []; let length = 0;
  for (const L of t?.LAYERS ?? []) {
    const frames: Frame[] = [];
    for (const f of L.Frames ?? []) {
      const elements: Elem[] = [];
      for (const e of f.elements ?? []) {
        if (e.SYMBOL_Instance) {
          const s = e.SYMBOL_Instance;
          elements.push({ sym: s.SYMBOL_name, m: mat(s.Matrix3D), type: s.symbolType ?? 'graphic', first: s.firstFrame ?? 0, loop: s.loop ?? 'loop' });
        } else if (e.ATLAS_SPRITE_instance) {
          const s = e.ATLAS_SPRITE_instance;
          elements.push({ sprite: String(s.name), m: mat(s.Matrix3D), type: 'graphic', first: 0, loop: 'loop' });
        }
      }
      frames.push({ index: f.index, duration: f.duration, elements });
      length = Math.max(length, f.index + f.duration);
    }
    layers.push({ frames });
  }
  return { layers, length };
}

export class AnimateAtlas {
  symbols = new Map<string, Timeline>();
  sprites = new Map<string, SpriteRect>();
  main!: Timeline; mainName = ''; fps = 24;

  static async load(assets: Assets, folder: string): Promise<AnimateAtlas | null> {
    const dir = `images/${folder.replace(/\/+$/, '')}`;
    const j = await assets.json<any>(`${dir}/Animation.json`);
    if (!j) return null;
    const a = new AnimateAtlas();
    const an = j.ANIMATION ?? j.AN;
    a.mainName = an?.SYMBOL_name ?? an?.name ?? '';
    a.main = parseTimeline(an?.TIMELINE);
    a.fps = j.metadata?.framerate ?? 24;
    for (const s of j.SYMBOL_DICTIONARY?.Symbols ?? []) a.symbols.set(s.SYMBOL_name, parseTimeline(s.TIMELINE));
    a.symbols.set(a.mainName, a.main);
    for (let i = 1; i < 20; i++) {
      const raw = await assets.text(`${dir}/spritemap${i}.json`); if (!raw) break;
      const sm = JSON.parse(raw.replace(/^﻿/, ''));
      const img = await assets.image(`${folder.replace(/\/+$/, '')}/spritemap${i}`);
      if (!img) continue;
      for (const s of sm.ATLAS?.SPRITES ?? []) { const r = s.SPRITE; a.sprites.set(String(r.name), { x: r.x, y: r.y, w: r.w, h: r.h, img: img.img as any }); }
    }
    return a;
  }

  length(symbol?: string) { return (symbol ? this.symbols.get(symbol) : this.main)?.length ?? 0; }

  draw(ctx: CanvasRenderingContext2D, tl: Timeline, frame: number, depth = 0) {
    if (depth > 24) return;
    for (let li = tl.layers.length - 1; li >= 0; li--) {
      const fr = tl.layers[li].frames.find(f => frame >= f.index && frame < f.index + f.duration);
      if (!fr) continue;
      for (const e of fr.elements) {
        ctx.save();
        ctx.transform(e.m.a, e.m.b, e.m.c, e.m.d, e.m.tx, e.m.ty);
        if (e.sprite !== undefined) {
          const s = this.sprites.get(e.sprite);
          if (s) ctx.drawImage(s.img, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
        } else if (e.sym) {
          const child = this.symbols.get(e.sym);
          if (child && child.length > 0) {
            const rel = frame - fr.index;
            let cf = e.first;
            if (e.loop === 'loop') cf = (e.first + rel) % child.length;
            else if (e.loop === 'play once') cf = Math.min(e.first + rel, child.length - 1);
            this.draw(ctx, child, cf, depth + 1);
          }
        }
        ctx.restore();
      }
    }
  }
}

interface NamedAnim { symbol: string | null; indices: number[] | null; fps: number; loop: boolean }

export class AnimateSprite implements Drawable {
  x = 0; y = 0; alpha = 1; visible = true; angle = 0; camera = 'game';
  scale = { x: 1, y: 1 }; scrollFactor = { x: 1, y: 1 }; offset = { x: 0, y: 0 }; origin = { x: 0, y: 0 };
  flipX = false; antialiasing = true; blend = '';
  atlas: AnimateAtlas | null = null;
  anims = new Map<string, NamedAnim>();
  curName = ''; private cur: NamedAnim | null = null;
  private t = 0; private paused = false; private _fps = 24; private _finished = false; private extraFrame: number | null = null;
  private symbol: string | null = null;

  get frameCount() { return this.cur?.indices ? this.cur.indices.length : (this.atlas?.length(this.cur?.symbol ?? this.symbol ?? undefined) ?? 0); }
  get curFrame(): number { return this.extraFrame ?? Math.min(Math.floor(this.t * this._fps), Math.max(0, this.frameCount - 1)); }
  set curFrame(v: number) { this.t = v / this._fps; this.extraFrame = null; this._finished = false; }
  get finished() { return this._finished; }
  get width() { return 0; } get height() { return 0; }

  /** facade estilo FlxAnimate / FlxAnimation para Lua */
  get anim() {
    const s = this;
    return {
      get curFrame() { return s.curFrame; }, set curFrame(v: number) { s.curFrame = v; },
      get length() { return s.frameCount; }, get numFrames() { return s.frameCount; },
      get framerate() { return s._fps; }, set framerate(v: number) { const f = s.curFrame; s._fps = v || 24; s.t = f / s._fps; },
      get finished() { return s._finished; }, get paused() { return s.paused; },
      get curAnim() { return { name: s.curName, get curFrame() { return s.curFrame; }, set curFrame(v: number) { s.curFrame = v; }, get numFrames() { return s.frameCount; }, finish() { s.curFrame = Math.max(0, s.frameCount - 1); s._finished = true; } }; },
      pause() { s.paused = true; }, resume() { s.paused = false; }, play(n?: string, force = false) { if (n) s.play(n, force); else s.paused = false; },
      stop() { s.paused = true; s.curFrame = 0; },
      get(n: string) { return s.anims.get(n); },
      exists(n: string) { return s.anims.has(n); },
    };
  }
  get animation() { return this.anim; }

  addBySymbol(name: string, symbol: string, fps = 24, loop = false) { this.anims.set(name, { symbol, indices: null, fps, loop }); }
  addBySymbolIndices(name: string, symbol: string, indices: number[], fps = 24, loop = false) { this.anims.set(name, { symbol, indices, fps, loop }); }
  addByIndices(name: string, indices: number[], fps = 24, loop = false) { this.anims.set(name, { symbol: null, indices, fps, loop }); }
  play(name: string, force = false) {
    const a = this.anims.get(name); if (!a) return false;
    if (!force && this.curName === name && !this._finished) return true;
    this.cur = a; this.curName = name; this._fps = a.fps || 24; this.t = 0; this._finished = false; this.paused = false; this.extraFrame = null;
    return true;
  }
  update(dt: number) {
    if (this.paused || !this.atlas) return;
    const n = this.frameCount; if (n <= 0) return;
    this.t += dt;
    const f = this.t * this._fps;
    if (f >= n) {
      if (this.cur?.loop ?? true) this.t = (f % n) / this._fps;
      else { this.t = (n - 1) / this._fps; this._finished = true; this.paused = true; }
    }
  }
  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    const at = this.atlas; if (!at || !this.visible || this.alpha <= 0) return;
    let tl: Timeline | undefined, frame = this.curFrame;
    const sym = this.cur?.symbol ?? this.symbol;
    tl = sym ? at.symbols.get(sym) : at.main;
    if (!tl) return;
    if (this.cur?.indices) frame = this.cur.indices[Math.min(this.curFrame, this.cur.indices.length - 1)] ?? 0;
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, this.alpha)) * cam.alpha;
    ctx.imageSmoothingEnabled = this.antialiasing;
    ctx.translate(this.x - cam.scroll.x * this.scrollFactor.x, this.y - cam.scroll.y * this.scrollFactor.y);
    if (this.angle) ctx.rotate(this.angle * Math.PI / 180);
    ctx.scale(this.scale.x * (this.flipX ? -1 : 1), this.scale.y);
    at.draw(ctx, tl, frame);
    ctx.restore();
  }
  updateHitbox() {}
  screenCenter() {}
}
