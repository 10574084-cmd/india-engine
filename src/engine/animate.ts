/** Atlas de Adobe Animate (Animation.json + spritemapN.json/png), al estilo FlxAnimate. */
import type { Assets } from './assets';
import type { Camera, Drawable } from './display';

interface Mat { a: number; b: number; c: number; d: number; tx: number; ty: number }
interface Elem { sym?: string; sprite?: string; m: Mat; type: string; first: number; loop: string }
interface Frame { index: number; duration: number; elements: Elem[] }
interface Layer { frames: Frame[] }
interface Timeline { layers: Layer[]; length: number }
interface SpriteRect { x: number; y: number; w: number; h: number; img: CanvasImageSource }

const mat = (m: any): Mat => !m ? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
  : Array.isArray(m) ? { a: m[0], b: m[1], c: m[4], d: m[5], tx: m[12], ty: m[13] }
  : { a: m.m00, b: m.m01, c: m.m10, d: m.m11, tx: m.m30, ty: m.m31 };
const LOOPS: Record<string, string> = { LP: 'loop', PO: 'play once', SF: 'single frame' };
const TYPES: Record<string, string> = { G: 'graphic', MC: 'movieclip', B: 'button' };

function parseTimeline(t: any): Timeline {
  const layers: Layer[] = []; let length = 0;
  for (const L of t?.LAYERS ?? t?.L ?? []) {
    const frames: Frame[] = [];
    for (const f of L.Frames ?? L.FR ?? []) {
      const elements: Elem[] = [];
      for (const e of f.elements ?? f.E ?? []) {
        if (e.SYMBOL_Instance) {
          const s = e.SYMBOL_Instance;
          elements.push({ sym: s.SYMBOL_name, m: mat(s.Matrix3D), type: s.symbolType ?? 'graphic', first: s.firstFrame ?? 0, loop: s.loop ?? 'loop' });
        } else if (e.SI) {
          const s = e.SI;
          elements.push({ sym: s.SN, m: mat(s.M3D), type: TYPES[s.ST] ?? 'graphic', first: s.FF ?? 0, loop: LOOPS[s.LP] ?? 'loop' });
        } else if (e.ATLAS_SPRITE_instance || e.ASI) {
          const s = e.ATLAS_SPRITE_instance ?? e.ASI;
          elements.push({ sprite: String(s.name ?? s.N), m: mat(s.Matrix3D ?? s.M3D), type: 'graphic', first: 0, loop: 'loop' });
        }
      }
      const idx = f.index ?? f.I, du = f.duration ?? f.DU;
      frames.push({ index: idx, duration: du, elements });
      length = Math.max(length, idx + du);
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
    a.mainName = an?.SYMBOL_name ?? an?.SN ?? an?.name ?? an?.N ?? '';
    a.main = parseTimeline(an?.TIMELINE ?? an?.TL);
    a.fps = j.metadata?.framerate ?? j.MD?.FRT ?? 24;
    for (const s of j.SYMBOL_DICTIONARY?.Symbols ?? j.SD?.S ?? []) a.symbols.set(s.SYMBOL_name ?? s.SN, parseTimeline(s.TIMELINE ?? s.TL));
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

  /** caja envolvente aproximada de un frame (para flip / tamaño) */
  measure(tl: Timeline, frame: number, m: Mat = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, depth = 0, box = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }) {
    if (depth > 12) return box;
    for (const L of tl.layers) {
      const fr = L.frames.find(f => frame >= f.index && frame < f.index + f.duration); if (!fr) continue;
      for (const e of fr.elements) {
        const n: Mat = { a: m.a * e.m.a + m.c * e.m.b, b: m.b * e.m.a + m.d * e.m.b, c: m.a * e.m.c + m.c * e.m.d, d: m.b * e.m.c + m.d * e.m.d,
          tx: m.a * e.m.tx + m.c * e.m.ty + m.tx, ty: m.b * e.m.tx + m.d * e.m.ty + m.ty };
        if (e.sprite !== undefined) {
          const sp = this.sprites.get(e.sprite); if (!sp) continue;
          for (const [px, py] of [[0, 0], [sp.w, 0], [0, sp.h], [sp.w, sp.h]]) {
            const X = n.a * px + n.c * py + n.tx, Y = n.b * px + n.d * py + n.ty;
            box.x0 = Math.min(box.x0, X); box.y0 = Math.min(box.y0, Y); box.x1 = Math.max(box.x1, X); box.y1 = Math.max(box.y1, Y);
          }
        } else if (e.sym) {
          const child = this.symbols.get(e.sym);
          if (child && child.length > 0) this.measure(child, e.loop === 'loop' ? (e.first + frame - fr.index) % child.length : Math.min(e.first + frame - fr.index, child.length - 1), n, depth + 1, box);
        }
      }
    }
    return box;
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
