import { fxFrame, type ShaderFx } from './shaderfx';
/**
 * Objetos de pantalla: atlas Sparrow, sprites animados, texto y cámaras.
 * Imita el modelo de HaxeFlixel (x/y, offset, origin, scale, scrollFactor) porque los
 * JSON de personajes de Psych y los scripts Lua dependen de esas reglas exactas.
 */

export const W = 1280;
export const H = 720;

// ------------------------------------------------------------------ atlas

export interface Frame {
  name: string;
  x: number; y: number; w: number; h: number;       // región en la imagen
  fx: number; fy: number;                            // frameX/frameY del XML (<= 0 normalmente)
  fw: number; fh: number;                            // tamaño original sin recortar
  img?: Src;                                         // imagen propia (atlas combinados)
  rotated?: boolean;
}

export type Src = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

export class Atlas {
  frames: Frame[] = [];
  private tintCache = new Map<number, HTMLCanvasElement>();
  private rgbCache = new Map<string, HTMLCanvasElement>();
  constructor(public img: Src) {}

  get width() { return (this.img as any).width as number; }
  get height() { return (this.img as any).height as number; }

  /** combina varias hojas (character.image = "a, b, c") */
  static merge(list: Atlas[]): Atlas {
    const out = new Atlas(list[0].img);
    list.forEach((a, i) => { for (const f of a.frames) out.frames.push(i === 0 ? f : { ...f, img: a.img }); });
    return out;
  }
  static single(img: Src): Atlas {
    const a = new Atlas(img);
    const w = (img as any).width, h = (img as any).height;
    a.frames = [{ name: '', x: 0, y: 0, w, h, fx: 0, fy: 0, fw: w, fh: h }];
    return a;
  }

  /** Atlas en cuadrícula (iconos, notas pixel...). */
  static grid(img: Src, cw: number, ch: number): Atlas {
    const a = new Atlas(img);
    const W_ = (img as any).width, H_ = (img as any).height;
    for (let y = 0; y + ch <= H_; y += ch)
      for (let x = 0; x + cw <= W_; x += cw)
        a.frames.push({ name: '', x, y, w: cw, h: ch, fx: 0, fy: 0, fw: cw, fh: ch });
    return a;
  }

  static sparrow(img: Src, xml: string): Atlas {
    const a = new Atlas(img);
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const subs = doc.getElementsByTagName('SubTexture');
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      const num = (n: string, d = 0) => { const v = s.getAttribute(n); return v === null || v === '' ? d : parseFloat(v); };
      const w = num('width'), h = num('height');
      const rotated = s.getAttribute('rotated') === 'true';
      a.frames.push({
        name: s.getAttribute('name') ?? '',
        x: num('x'), y: num('y'), w, h,
        fx: num('frameX'), fy: num('frameY'),
        fw: num('frameWidth', rotated ? h : w), fh: num('frameHeight', rotated ? w : h),
        rotated,
      });
    }
    return a;
  }

  /** Formato "Spritesheet Packer": nombre = x y w h */
  static packer(img: Src, txt: string): Atlas {
    const a = new Atlas(img);
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*(.+?)\s*=\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)/.exec(line);
      if (m) a.frames.push({ name: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5], fx: 0, fy: 0, fw: +m[4], fh: +m[5] });
    }
    return a;
  }

  /** Formato JSON de TexturePacker / Aseprite. */
  static texturePacker(img: Src, j: any): Atlas {
    const a = new Atlas(img);
    const list = Array.isArray(j.frames) ? j.frames : Object.entries(j.frames).map(([k, v]: any) => ({ filename: k, ...v }));
    for (const f of list) {
      const fr = f.frame, ss = f.spriteSourceSize, src = f.sourceSize;
      a.frames.push({
        name: f.filename ?? '', x: fr.x, y: fr.y, w: fr.w, h: fr.h,
        fx: ss ? -ss.x : 0, fy: ss ? -ss.y : 0, fw: src ? src.w : fr.w, fh: src ? src.h : fr.h,
      });
    }
    return a;
  }

  /** Imagen multiplicada por un color (para sprite.color / tintes). */
  tinted(color: number): Src {
    if ((color & 0xffffff) === 0xffffff) return this.img;
    let c = this.tintCache.get(color);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = this.width; c.height = this.height;
    const g = c.getContext('2d')!;
    g.drawImage(this.img as any, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = '#' + (color & 0xffffff).toString(16).padStart(6, '0');
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(this.img as any, 0, 0);
    if (this.tintCache.size > 24) this.tintCache.clear();
    this.tintCache.set(color, c);
    return c;
  }

  /**
   * Equivalente en CPU del shader RGBPalette de Psych: el canal R de la imagen se pinta con `r`,
   * el G con `g` y el B con `b` (las notas de 0.7 son grises y se colorean así).
   */
  recolored(r: number, g: number, b: number): Src {
    const key = r + ',' + g + ',' + b;
    let c = this.rgbCache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = this.width; c.height = this.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.img as any, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    const R = [(r >> 16) & 255, (r >> 8) & 255, r & 255];
    const G = [(g >> 16) & 255, (g >> 8) & 255, g & 255];
    const B = [(b >> 16) & 255, (b >> 8) & 255, b & 255];
    for (let i = 0; i < p.length; i += 4) {
      const a = p[i + 3];
      if (a === 0) continue;
      const rr = p[i] / 255, gg = p[i + 1] / 255, bb = p[i + 2] / 255;
      for (let k = 0; k < 3; k++) {
        const v = rr * R[k] + gg * G[k] + bb * B[k];
        p[i + k] = v > 255 ? 255 : v;
      }
    }
    ctx.putImageData(d, 0, 0);
    this.rgbCache.set(key, c);
    return c;
  }
}

// ------------------------------------------------------------------ cámara

export class Camera {
  zoom = 1;
  defaultZoom = 1;
  scroll = { x: 0, y: 0 };
  alpha = 1;
  angle = 0;
  x = 0; y = 0;
  visible = true;
  bgColor = 0; // ARGB; 0 = transparente
  private shakeT = 0; private shakeDur = 0; private shakeI = 0;
  private flashT = 0; private flashDur = 0; private flashColor = 0xffffff;
  private fadeT = 0; private fadeDur = 0; private fadeColor = 0; private fadeIn = false; private fadeHold = false;
  constructor(public name: string) {}

  shake(intensity: number, duration: number) { this.shakeI = intensity; this.shakeDur = this.shakeT = duration; }
  flash(color: number, duration: number) { this.flashColor = color; this.flashDur = this.flashT = Math.max(duration, 0.0001); }
  fade(color: number, duration: number, fadeIn = false) {
    this.fadeColor = color; this.fadeDur = this.fadeT = Math.max(duration, 0.0001); this.fadeIn = fadeIn; this.fadeHold = !fadeIn;
  }
  update(dt: number) {
    if (this.shakeT > 0) this.shakeT -= dt;
    if (this.flashT > 0) this.flashT -= dt;
    if (this.fadeT > 0) this.fadeT -= dt;
  }
  begin(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalAlpha = 1;
    // el recorte es el viewport completo
    ctx.beginPath(); ctx.rect(this.x, this.y, W, H); ctx.clip();
    if (this.bgColor >>> 24) {
      ctx.fillStyle = argb(this.bgColor); ctx.fillRect(0, 0, W, H);
    }
    ctx.translate(W / 2 + this.x, H / 2 + this.y);
    if (this.angle) ctx.rotate(this.angle * Math.PI / 180);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-W / 2, -H / 2);
    if (this.shakeT > 0) {
      ctx.translate((Math.random() * 2 - 1) * this.shakeI * W, (Math.random() * 2 - 1) * this.shakeI * H);
    }
  }
  end(ctx: CanvasRenderingContext2D) {
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(this.x, this.y, W, H); ctx.clip();
    if (this.flashT > 0) {
      ctx.globalAlpha = Math.max(0, this.flashT / this.flashDur);
      ctx.fillStyle = rgb(this.flashColor); ctx.fillRect(this.x, this.y, W, H);
    }
    if (this.fadeT > 0 || this.fadeHold) {
      let a = this.fadeT > 0 ? 1 - this.fadeT / this.fadeDur : 1;
      if (this.fadeIn) a = 1 - a;
      ctx.globalAlpha = Math.min(1, Math.max(0, a));
      ctx.fillStyle = rgb(this.fadeColor); ctx.fillRect(this.x, this.y, W, H);
      if (this.fadeIn && this.fadeT <= 0) this.fadeHold = false;
    }
    ctx.restore();
  }
}

export const rgb = (c: number) => '#' + (c & 0xffffff).toString(16).padStart(6, '0');
export const argb = (c: number) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${((c >>> 24) & 255) / 255})`;

export const BLEND: Record<string, GlobalCompositeOperation> = {
  add: 'lighter', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken',
  lighten: 'lighter', difference: 'difference', hardlight: 'hard-light', invert: 'difference',
};

// ------------------------------------------------------------------ objetos base

export interface Drawable {
  camera: string;
  visible: boolean;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, cam: Camera): void;
}

export interface Anim {
  name: string; frames: Frame[]; fps: number; loop: boolean;
}

export class Sprite implements Drawable {
  x = 0; y = 0; alpha = 1; visible = true; angle = 0;
  flipX = false; flipY = false;
  scale = { x: 1, y: 1 };
  scrollFactor = { x: 1, y: 1 };
  offset = { x: 0, y: 0 };
  origin = { x: 0, y: 0 };
  velocity = { x: 0, y: 0 };
  acceleration = { x: 0, y: 0 };
  camera = 'game';
  blend = '';
  color = 0xffffff;
  antialiasing = true;
  width = 0; height = 0;
  frameWidth = 0; frameHeight = 0;
  active = true;
  alive = true;
  atlas: Atlas | null = null;
  anims = new Map<string, Anim>();
  cur: Anim | null = null;
  curFrame = 0;
  private t = 0;
  finished = true;
  paused = false;
  reversed = false;
  /** callback al terminar una animación */
  onAnimFinish?: (name: string) => void;
  /** posición manual de frame (para grids sin anim) */
  staticFrame = 0;
  /** override del atlas dibujado (p.ej. nota recoloreada) */
  srcOverride: Src | null = null;
  fx: ShaderFx | null = null;
  tag = '';

  constructor(x = 0, y = 0) { this.x = x; this.y = y; }

  // --- carga
  setAtlas(a: Atlas) {
    this.atlas = a;
    this.anims.clear(); this.cur = null; this.curFrame = 0; this.staticFrame = 0;
    const f = a.frames[0];
    this.frameWidth = f ? f.fw : 0; this.frameHeight = f ? f.fh : 0;
    this.width = this.frameWidth; this.height = this.frameHeight;
    this.origin.x = this.frameWidth / 2; this.origin.y = this.frameHeight / 2;
    return this;
  }
  loadGraphic(img: Src | Atlas, animated = false, w = 0, h = 0) {
    if (img instanceof Atlas) {
      if (animated && w > 0 && h > 0) return this.setAtlas(Atlas.grid(img.img, w, h));
      return this.setAtlas(img);
    }
    return this.setAtlas(Atlas.single(img));
  }
  makeGraphic(w: number, h: number, color: number) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    const g = c.getContext('2d')!;
    g.fillStyle = argb(((color >>> 24) ? color : (0xff000000 | color)) >>> 0);
    g.fillRect(0, 0, c.width, c.height);
    return this.loadGraphic(c);
  }

  // --- animaciones
  private sortFrames(list: Frame[]) {
    const n = (f: Frame) => { const m = /(\d+)$/.exec(f.name); return m ? parseInt(m[1], 10) : 0; };
    return list.sort((a, b) => n(a) - n(b));
  }
  addByPrefix(name: string, prefix: string, fps = 24, loop = true): boolean {
    if (!this.atlas) return false;
    const fr = this.sortFrames(this.atlas.frames.filter(f => f.name.startsWith(prefix)));
    if (!fr.length) return false;
    this.anims.set(name, { name, frames: fr, fps, loop });
    return true;
  }
  addByIndices(name: string, prefix: string, indices: number[], postfix = '', fps = 24, loop = true): boolean {
    if (!this.atlas) return false;
    const frames: Frame[] = [];
    const byName = new Map(this.atlas.frames.map(f => [f.name, f]));
    const pool = this.sortFrames(this.atlas.frames.filter(f => f.name.startsWith(prefix)));
    for (const i of indices) {
      const f = byName.get(prefix + String(i).padStart(4, '0') + postfix) ?? pool[i];
      if (f) frames.push(f);
    }
    if (!frames.length) return false;
    this.anims.set(name, { name, frames, fps, loop });
    return true;
  }
  addByFrames(name: string, idx: number[], fps = 24, loop = true) {
    if (!this.atlas) return;
    this.anims.set(name, { name, frames: idx.map(i => this.atlas!.frames[i]).filter(Boolean), fps, loop });
  }
  hasAnim(name: string) { return this.anims.has(name); }
  play(name: string, force = false, reversed = false, startFrame = 0) {
    const a = this.anims.get(name);
    if (!a) return false;
    if (!force && this.cur === a && !this.finished) return true;
    this.cur = a; this.reversed = reversed; this.finished = false; this.paused = false;
    this.curFrame = Math.min(Math.max(0, startFrame), a.frames.length - 1);
    if (reversed && startFrame === 0) this.curFrame = a.frames.length - 1;
    this.t = 0;
    this.syncFrame();
    return true;
  }
  get animName() { return this.cur?.name ?? ''; }
  /** forma estilo Flixel para Lua: sprite.animation.curAnim.name */
  get animation() {
    const s = this;
    return {
      get curAnim() {
        if (!s.cur) return null;
        return { get name() { return s.cur!.name; }, get finished() { return s.finished; },
          get curFrame() { return s.curFrame; }, set curFrame(v: number) { s.curFrame = v; s.syncFrame(); },
          get paused() { return s.paused; }, set paused(v: boolean) { s.paused = v; },
          get frames() { return s.cur!.frames; }, get looped() { return s.cur!.loop; },
          get numFrames() { return s.cur!.frames.length; }, get frameRate() { return s.cur!.fps; }, set frameRate(v: number) { s.cur!.fps = v; },
          finish() { s.curFrame = Math.max(0, s.cur!.frames.length - 1); s.syncFrame(); } };
      },
      get frameIndex() { return s.curFrame; }, set frameIndex(v: number) { s.staticFrame = v; s.curFrame = v; s.syncFrame(); },
      add: (name: string, frames: number[], fps = 30, loop = true) => s.addByFrames(name, frames, fps, loop),
      addByPrefix: (name: string, prefix: string, fps = 30, loop = true) => s.addByPrefix(name, prefix, fps, loop),
      addByIndices: (name: string, prefix: string, indices: number[], postfix = '', fps = 30, loop = true) => s.addByIndices(name, prefix, indices, postfix, fps, loop),
      play: (name: string, force = false, reversed = false, frame = 0) => s.play(name, force, reversed, frame),
      pause: () => { s.paused = true; }, resume: () => { s.paused = false; }, stop: () => { s.finish(); },
      exists: (name: string) => s.hasAnim(name),
      get finished() { return s.finished; },
      get name() { return s.animName; },
    };
  }
  private syncFrame() {
    const f = this.currentFrame();
    if (f) { this.frameWidth = f.fw; this.frameHeight = f.fh; }
  }
  currentFrame(): Frame | null {
    if (!this.atlas) return null;
    if (this.cur) return this.cur.frames[Math.min(this.curFrame, this.cur.frames.length - 1)] ?? null;
    return this.atlas.frames[this.staticFrame] ?? this.atlas.frames[0] ?? null;
  }
  finish() {
    if (!this.cur) return;
    this.curFrame = this.reversed ? 0 : this.cur.frames.length - 1;
    this.finished = true;
  }

  // --- geometría
  updateHitbox() {
    this.width = Math.abs(this.scale.x) * this.frameWidth;
    this.height = Math.abs(this.scale.y) * this.frameHeight;
    this.offset.x = -0.5 * (this.width - this.frameWidth);
    this.offset.y = -0.5 * (this.height - this.frameHeight);
    this.origin.x = this.frameWidth / 2; this.origin.y = this.frameHeight / 2;
  }
  centerOrigin() { this.origin.x = this.frameWidth / 2; this.origin.y = this.frameHeight / 2; }
  centerOffsets() { this.offset.x = (this.frameWidth - this.width) * 0.5; this.offset.y = (this.frameHeight - this.height) * 0.5; }
  setGraphicSize(w = 0, h = 0) {
    if (w <= 0 && h <= 0) return;
    let sx = w / this.frameWidth, sy = h / this.frameHeight;
    this.scale.x = sx; this.scale.y = sy;
    if (w <= 0) this.scale.x = this.scale.y = sy; else if (h <= 0) this.scale.x = this.scale.y = sx;
  }
  screenCenter(axis = 'xy') {
    if (axis.includes('x')) this.x = (W - this.width) / 2;
    if (axis.includes('y')) this.y = (H - this.height) / 2;
  }
  midX() { return this.x + this.width * 0.5; }
  midY() { return this.y + this.height * 0.5; }
  graphicMidX() { return this.x + this.frameWidth * 0.5; }
  graphicMidY() { return this.y + this.frameHeight * 0.5; }

  // --- ciclo
  update(dt: number) {
    if (this.active) {
      if (this.acceleration.x || this.acceleration.y || this.velocity.x || this.velocity.y) {
        this.velocity.x += this.acceleration.x * dt; this.velocity.y += this.acceleration.y * dt;
        this.x += this.velocity.x * dt; this.y += this.velocity.y * dt;
      }
    }
    if (this.cur && !this.finished && !this.paused) {
      this.t += dt;
      const spf = 1 / this.cur.fps;
      const n = this.cur.frames.length;
      while (this.t >= spf && !this.finished) {
        this.t -= spf;
        if (this.reversed) {
          if (this.curFrame > 0) this.curFrame--;
          else if (this.cur.loop) this.curFrame = n - 1;
          else { this.finished = true; }
        } else {
          if (this.curFrame < n - 1) this.curFrame++;
          else if (this.cur.loop) this.curFrame = 0;
          else { this.finished = true; }
        }
        if (this.finished) this.onAnimFinish?.(this.cur.name);
      }
      this.syncFrame();
    }
  }

  getScreenPosition(cam?: Camera) { return { x: this.x - (cam?.scroll.x ?? 0) * this.scrollFactor.x, y: this.y - (cam?.scroll.y ?? 0) * this.scrollFactor.y }; }
  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (!this.visible || this.alpha <= 0 || !this.atlas) return;
    const f = this.currentFrame();
    if (!f) return;
    const px = this.x - this.offset.x - cam.scroll.x * this.scrollFactor.x;
    const py = this.y - this.offset.y - cam.scroll.y * this.scrollFactor.y;
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, this.alpha)) * cam.alpha;
    if (this.blend) ctx.globalCompositeOperation = BLEND[this.blend.toLowerCase()] ?? 'source-over';
    ctx.imageSmoothingEnabled = this.antialiasing;
    ctx.translate(px + this.origin.x, py + this.origin.y);
    if (this.angle) ctx.rotate(this.angle * Math.PI / 180);
    ctx.scale(this.scale.x * (this.flipX ? -1 : 1), this.scale.y * (this.flipY ? -1 : 1));
    const src = f.img ?? this.srcOverride ?? this.atlas.tinted(this.color);
    if (this.fx) ctx.drawImage(fxFrame(this.fx, src as any, f.x, f.y, f.w, f.h), -this.origin.x - f.fx, -this.origin.y - f.fy);
    else ctx.drawImage(src as any, f.x, f.y, f.w, f.h, -this.origin.x - f.fx, -this.origin.y - f.fy, f.w, f.h);
    ctx.restore();
  }
}

// ------------------------------------------------------------------ texto

export class TextObj implements Drawable {
  x = 0; y = 0; alpha = 1; visible = true; angle = 0;
  scale = { x: 1, y: 1 };
  scrollFactor = { x: 1, y: 1 };
  offset = { x: 0, y: 0 };
  origin = { x: 0, y: 0 };
  camera = 'hud';
  blend = '';
  antialiasing = true;
  text = '';
  size = 16;
  font = 'vcr';
  color = 0xffffff;
  align: 'left' | 'center' | 'right' = 'left';
  fieldWidth = 0;
  borderSize = 0;
  borderColor = 0x000000;
  italic = false;
  bold = false;
  lineHeight = 1.15;
  tag = '';
  velocity = { x: 0, y: 0 };
  acceleration = { x: 0, y: 0 };
  constructor(x = 0, y = 0, w = 0, text = '', size = 16) { this.x = x; this.y = y; this.fieldWidth = w; this.text = text; this.size = size; }
  get width() { return this.fieldWidth || this.measure(); }
  set width(v: number) { this.fieldWidth = v; }
  get height() { return this.text.split('\n').length * this.size * this.lineHeight; }
  get frameWidth() { return this.width; }
  get frameHeight() { return this.height; }
  measure() {
    ctxMeasure.font = this.fontStr();
    return Math.max(...this.text.split('\n').map(l => ctxMeasure.measureText(l).width), 0);
  }
  fontStr() { return `${this.italic ? 'italic ' : ''}${this.bold ? 'bold ' : ''}${this.size}px "${this.font}", "VCR OSD Mono", monospace`; }
  screenCenter(axis = 'xy') {
    if (axis.includes('x')) this.x = (W - this.width) / 2;
    if (axis.includes('y')) this.y = (H - this.height) / 2;
  }
  update(dt: number) {
    if (this.acceleration.x || this.acceleration.y || this.velocity.x || this.velocity.y) {
      this.velocity.x += this.acceleration.x * dt; this.velocity.y += this.acceleration.y * dt;
      this.x += this.velocity.x * dt; this.y += this.velocity.y * dt;
    }
  }
  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (!this.visible || this.alpha <= 0 || !this.text) return;
    const px = this.x - cam.scroll.x * this.scrollFactor.x;
    const py = this.y - cam.scroll.y * this.scrollFactor.y;
    const fw = this.fieldWidth || this.measure();
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.alpha) * cam.alpha;
    if (this.blend) ctx.globalCompositeOperation = BLEND[this.blend.toLowerCase()] ?? 'source-over';
    ctx.translate(px + fw / 2, py + this.height / 2);
    if (this.angle) ctx.rotate(this.angle * Math.PI / 180);
    ctx.scale(this.scale.x, this.scale.y);
    ctx.translate(-fw / 2, -this.height / 2);
    ctx.font = this.fontStr();
    ctx.textBaseline = 'top';
    ctx.textAlign = this.align;
    ctx.lineJoin = 'round';
    const ax = this.align === 'center' ? fw / 2 : this.align === 'right' ? fw : 0;
    let lines = this.text.split('\n');
    if (this.fieldWidth > 0) {
      const out: string[] = [];
      for (const para of lines) {
        let cur = '';
        for (const w of para.split(' ')) {
          const t = cur ? cur + ' ' + w : w;
          if (cur && ctx.measureText(t).width > this.fieldWidth) { out.push(cur); cur = w; } else cur = t;
        }
        out.push(cur);
      }
      lines = out;
    }
    lines.forEach((ln, i) => {
      const ly = i * this.size * this.lineHeight;
      if (this.borderSize > 0) {
        ctx.lineWidth = this.borderSize * 2; ctx.strokeStyle = rgb(this.borderColor);
        ctx.strokeText(ln, ax, ly);
      }
      ctx.fillStyle = rgb(this.color);
      ctx.fillText(ln, ax, ly);
    });
    ctx.restore();
  }
}
const ctxMeasure = document.createElement('canvas').getContext('2d')!;

/** Dibuja un rectángulo sólido o barra (para UI). */
export class Rect implements Drawable {
  x = 0; y = 0; w = 0; h = 0; color = 0x000000; alpha = 1; visible = true; camera = 'hud';
  constructor(x: number, y: number, w: number, h: number, color = 0x000000, alpha = 1) { Object.assign(this, { x, y, w, h, color, alpha }); }
  update() {}
  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (!this.visible) return;
    ctx.save(); ctx.globalAlpha = this.alpha * cam.alpha; ctx.fillStyle = rgb(this.color);
    ctx.fillRect(this.x, this.y, this.w, this.h); ctx.restore();
  }
}
