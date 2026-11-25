import { Interp, Env, HxHooks, HxMap, HxError, parseHx, makeIter, str } from './interp';
import { Atlas, Camera, Drawable, Sprite, TextObj, W, H } from '../engine/display';
import { ease } from '../engine/tween';
import type { PlayState } from '../game/playstate';
import { FUNCTION_STOP, FUNCTION_CONTINUE } from '../game/playstate';
import { BG, Group } from '../game/stages';
import { parseColor } from '../lua/host';
import type { ScriptHost } from '../lua/host';

const PACKAGES = new Set(['haxe', 'flixel', 'openfl', 'lime', 'objects', 'backend', 'psychlua', 'states', 'substates', 'cutscenes', 'options', 'shaders', 'sys', 'tjson', 'hscript', 'flash', 'openfl', 'js', 'tweenx']);
const CAMS: Record<string, 'game' | 'hud' | 'other'> = { game: 'game', hud: 'hud', other: 'other' };

/** Grupo estilo FlxTypedGroup / FlxSpriteGroup */
export class HxGroup extends Group {
  get members() { return this.items; }
  get length() { return this.items.length; }
  add(o: Sprite) { if (!this.items.length && o.camera) this.camera = o.camera; this.items.push(o); return o; }
  remove(o: Sprite) { const i = this.items.indexOf(o); if (i >= 0) this.items.splice(i, 1); return o; }
  insert(i: number, o: Sprite) { this.items.splice(i, 0, o); return o; }
  forEach(fn: (s: any) => void) { for (const s of [...this.items]) fn(s); }
  clear() { this.items.length = 0; }
  iterator() { return makeIter(this.items); }
  kill() { this.visible = false; } revive() { this.visible = true; } destroy() { this.items.length = 0; this.visible = false; }
}

class HxTimer {
  private t: any = null;
  loopsLeft = 0; elapsedLoops = 0; finished = false;
  constructor(private rt: HxRuntime) { }
  start(time = 1, cb?: (t: HxTimer) => void, loops = 1) {
    this.t = this.rt.ps.tweens.timer(time, loops, tt => {
      this.elapsedLoops = tt.elapsedLoops; this.loopsLeft = tt.loopsLeft; this.finished = tt.finished;
      cb?.(this);
    });
    return this;
  }
  cancel() { this.t?.cancel(); }
  get active() { return !!this.t && !this.t.finished; }
}

export class HxRuntime implements HxHooks {
  interp: Interp;
  classes: Record<string, any>;
  constructor(public host: ScriptHost, public file: string) {
    this.interp = new Interp(this, file);
    this.classes = this.buildClasses();
  }
  get ps(): PlayState { return this.host.ps; }
  get e() { return this.host.ps.e; }

  /** `haxe.Json`, `flixel.FlxG`… : cualquier paquete devuelve las clases conocidas por su último nombre */
  pkg(): any {
    const rt = this;
    return new Proxy({}, { get: (_t, k) => { const key = String(k); if (key in rt.classes) return rt.classes[key]; if (/^[a-z]/.test(key)) return rt.pkg(); return undefined; } });
  }

  // ----------------------------------------------------------- carga asíncrona de imágenes
  /** Devuelve un Atlas ya cargado o un marcador que se rellena en cuanto termina la carga. */
  atlasFor(key: string, animated: boolean): Atlas | null {
    const a = this.e.assets;
    const k = String(key).replace(/\.png$/i, '');
    const cached = (animated ? a.peekAtlas(k) : null) ?? a.peekImage(k) ?? a.peekAtlas(k);
    if (cached) return cached;
    if (!a.exists(`images/${k}.png`)) { console.warn('[HScript] imagen no encontrada:', k); return null; }
    const hole = Atlas.grid(document.createElement('canvas'), 1, 1);
    hole.frames = [{ name: '', x: 0, y: 0, w: 1, h: 1, fx: 0, fy: 0, fw: 1, fh: 1 } as any];
    this.host.pendingLoads.push((animated || a.hasAtlasData(k) ? a.atlas(k) : a.image(k)).then(at => { if (at) Object.assign(hole, at); }));
    return hole;
  }

  // ----------------------------------------------------------- hooks del intérprete
  lookup(name: string): { found: boolean; value?: any } {
    const ps = this.ps;
    switch (name) {
      case 'game': case 'instance': return { found: true, value: ps };
      case 'boyfriend': case 'boyfriendGroup': return { found: true, value: ps.boyfriend ?? null };
      case 'dad': case 'dadGroup': return { found: true, value: ps.dad ?? null };
      case 'gf': case 'gfGroup': return { found: true, value: ps.gf ?? null };
      case 'camGame': return { found: true, value: ps.cams.game };
      case 'camHUD': return { found: true, value: ps.cams.hud };
      case 'camOther': return { found: true, value: ps.cams.other };
      case 'camFollowPos': case 'camFollow': return { found: true, value: ps.camFollow };
      case 'Function_Stop': return { found: true, value: FUNCTION_STOP };
      case 'Function_Continue': return { found: true, value: FUNCTION_CONTINUE };
      case 'Function_StopHScript': case 'Function_StopLua': case 'Function_StopAll': return { found: true, value: name };
      case 'add': return { found: true, value: (o: Drawable) => this.addObj(o) };
      case 'remove': return { found: true, value: (o: Drawable) => { ps.removeDrawable(o); return o; } };
      case 'insert': return { found: true, value: (pos: number, o: Drawable) => this.insertObj(pos, o) };
      case 'addBehindGF': return { found: true, value: (o: Drawable) => this.addBehind(o, ps.gf) };
      case 'addBehindDad': return { found: true, value: (o: Drawable) => this.addBehind(o, ps.dad) };
      case 'addBehindBF': return { found: true, value: (o: Drawable) => this.addBehind(o, ps.boyfriend) };
      case 'members': return { found: true, value: [...ps.layerBack, ...ps.layerChars, ...ps.layerFront, ...ps.layerHud] };
      case 'trace': return { found: true, value: (...a: any[]) => { const t = a.map(str).join(' '); console.log('[HScript]', t); this.e.toast('[HScript] ' + t, '#ffffff', 4); } };
      case 'debugPrint': return { found: true, value: (...a: any[]) => { const t = a.map(str).join(' '); console.log('[HScript]', t); this.e.toast('[HScript] ' + t, '#ffffff', 4); } };
      case 'Std': case 'Math': case 'StringTools': case 'Reflect': case 'Json': break;
    }
    if (name in this.classes) return { found: true, value: this.classes[name] };
    if (PACKAGES.has(name)) return { found: true, value: this.pkg() };
    const api = this.host.apiFns.get(name);
    if (api) return { found: true, value: api };
    if (name in (ps as any)) { const v = (ps as any)[name]; return { found: true, value: typeof v === 'function' ? v.bind(ps) : v }; }
    return { found: false };
  }

  assignGlobal(name: string, value: any): boolean {
    const ps = this.ps as any;
    if (name in ps && typeof ps[name] !== 'function') { ps[name] = value; return true; }
    return false;
  }

  setField(obj: any, name: string, value: any): boolean {
    if (name === 'camera' && value instanceof Camera) { obj.camera = value.name; return true; }
    if (name === 'cameras' && Array.isArray(value)) { obj.camera = value[0]?.name ?? 'game'; return true; }
    if (name === 'cameras') return true;
    if (name === 'frames' && obj instanceof Sprite) { if (value instanceof Atlas) obj.setAtlas(value); return true; }
    if (name === 'color' && (obj instanceof Sprite || obj instanceof TextObj) && typeof value === 'number') { obj.color = value & 0xffffff; return true; }
    if (name === 'alignment' && obj instanceof TextObj) { obj.align = String(value).toLowerCase() as any; return true; }
    if (name === 'blend' && typeof value === 'string') { obj.blend = value.toLowerCase(); return true; }
    if (name === 'health' && obj === this.ps) { this.ps.health = value; return true; }
    return false;
  }

  missingMethod(obj: any, name: string, args: any[]): { handled: boolean; value?: any } {
    if (name === 'set' && obj && typeof obj === 'object' && 'x' in obj && 'y' in obj) {
      obj.x = args[0] ?? 0; obj.y = args[1] ?? args[0] ?? 0; return { handled: true };
    }
    if (name === 'setPosition' && obj && 'x' in obj) { obj.x = args[0] ?? obj.x; obj.y = args[1] ?? obj.y; return { handled: true }; }
    if (name === 'setSize' && obj && 'width' in obj) { obj.width = args[0]; obj.height = args[1]; return { handled: true }; }
    if (name === 'kill') { obj.visible = false; obj.alive = false; return { handled: true }; }
    if (name === 'revive') { obj.visible = true; obj.alive = true; return { handled: true }; }
    if (name === 'destroy') { this.ps.removeDrawable(obj); obj.visible = false; return { handled: true }; }
    if (name === 'setFormat' && obj instanceof TextObj) {
      const [font, size, color, align, , bcolor] = args;
      if (font) obj.font = String(font).replace(/\.ttf$/i, '').replace(/^.*\//, '');
      if (size) obj.size = size;
      if (typeof color === 'number') obj.color = color & 0xffffff;
      if (align) obj.align = String(align).toLowerCase() as any;
      if (typeof bcolor === 'number') { obj.borderColor = bcolor & 0xffffff; obj.borderSize = obj.borderSize || 1; }
      return { handled: true };
    }
    if (name === 'setBorderStyle' && obj instanceof TextObj) { obj.borderSize = 1; if (typeof args[1] === 'number') obj.borderColor = args[1] & 0xffffff; return { handled: true }; }
    if (name === 'screenCenter' && obj && typeof obj.screenCenter === 'function') { obj.screenCenter(String(args[0] ?? 'xy').toLowerCase()); return { handled: true }; }
    if (name === 'setColorTransform') return { handled: true };
    if (name === 'cancel' && obj) return { handled: true };
    return { handled: false };
  }

  construct(cls: string, args: any[]): { found: boolean; value?: any } {
    const ps = this.ps;
    const c = cls.split('.').pop()!;
    switch (c) {
      case 'FlxSprite': {
        const s = new Sprite(Number(args[0] ?? 0), Number(args[1] ?? 0));
        s.camera = 'game'; s.antialiasing = ps.prefs.antialiasing && !ps.isPixelStage;
        if (args[2] instanceof Atlas) s.setAtlas(args[2]);
        return { found: true, value: s };
      }
      case 'FlxText': {
        const t = new TextObj(Number(args[0] ?? 0), Number(args[1] ?? 0), Number(args[2] ?? 0), String(args[3] ?? ''), Number(args[4] ?? 8) * 2);
        t.camera = 'game'; return { found: true, value: t };
      }
      case 'BGSprite': {
        const [image, x = 0, y = 0, sx = 1, sy = 1, anims = null, loop = false] = args;
        const s = new BG(Number(x), Number(y));
        const animated = Array.isArray(anims);
        if (image) {
          const at = this.atlasFor(String(image), animated);
          if (at) s.setAtlas(at);
          if (animated) for (const an of anims as string[]) { s.addByPrefix(an, an, 24, !!loop); if (!s.idleAnim) { s.idleAnim = an; s.play(an); } }
        }
        s.scrollFactor.x = Number(sx); s.scrollFactor.y = Number(sy);
        s.antialiasing = ps.prefs.antialiasing && !ps.isPixelStage; s.camera = 'game';
        return { found: true, value: s };
      }
      case 'FlxTypedGroup': case 'FlxSpriteGroup': case 'FlxGroup': return { found: true, value: new HxGroup() };
      case 'FlxTimer': return { found: true, value: new HxTimer(this) };
      case 'FlxPoint': return { found: true, value: { x: Number(args[0] ?? 0), y: Number(args[1] ?? 0) } };
      case 'StringBuf': { let s = ''; return { found: true, value: { add: (x: any) => { s += str(x); }, toString: () => s, get length() { return s.length; } } }; }
    }
    return { found: false };
  }

  // ----------------------------------------------------------- capas
  private addObj(o: Drawable) { (this.ps.boyfriend ? this.ps.layerFront : this.ps.layerBack).push(o); return o; }
  private insertObj(pos: number, o: Drawable) {
    const ps = this.ps; const all = [...ps.layerBack, ...ps.layerChars, ...ps.layerFront, ...ps.layerHud];
    const ref = all[pos];
    for (const l of [ps.layerBack, ps.layerChars, ps.layerFront, ps.layerHud]) { const i = l.indexOf(ref); if (i >= 0) { l.splice(i, 0, o); return o; } }
    return this.addObj(o);
  }
  private addBehind(o: Drawable, ref: Drawable | null) {
    const ps = this.ps;
    if (!ref || !ps.boyfriend) { ps.layerBack.push(o); return o; }
    const i = ps.layerChars.indexOf(ref);
    ps.layerChars.splice(i < 0 ? 0 : i, 0, o); return o;
  }

  // ----------------------------------------------------------- clases disponibles para el script
  private buildClasses(): Record<string, any> {
    const rt = this;
    const ps = () => rt.ps;
    const e = () => rt.e;
    const color = (a: number, r: number, g: number, b: number) => (((a & 255) << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;
    const hsb = (h: number, s: number, v: number, a = 1) => {
      const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c; let r = 0, g = 0, b = 0; h = ((h % 360) + 360) % 360;
      if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
      return color(Math.round(a * 255), Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
    };
    const rawKey = (k: string) => { const s = String(k).toUpperCase(); if (/^[A-Z]$/.test(s)) return 'Key' + s; if (/^\d$/.test(s)) return 'Digit' + s; const m: Record<string, string> = { SPACE: 'Space', ENTER: 'Enter', ESCAPE: 'Escape', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', UP: 'ArrowUp', DOWN: 'ArrowDown', SHIFT: 'ShiftLeft', CONTROL: 'ControlLeft', TAB: 'Tab', BACKSPACE: 'Backspace' }; return m[s] ?? s; };
    const keyProxy = (fn: (code: string) => boolean) => new Proxy({}, { get: (_t, k) => fn(rawKey(String(k))) });
    const musicProxy = { get volume() { return 1; }, set volume(_v: number) { }, fadeIn: () => { }, fadeOut: () => { }, play: () => { }, stop: () => { } };
    const playSnd = (s: any, vol = 1) => {
      const key = s && s.__sound; if (!key) return null;
      void e().assets.sound(key).then(b => e().audio.playSound(b, vol)); return { volume: vol, stop() { }, pause() { }, play() { } };
    };
    const FlxG = {
      width: W, height: H, get elapsed() { return 1 / 60; },
      get camera() { return ps().cams.game; },
      cameras: { get list() { return [ps().cams.game, ps().cams.hud, ps().cams.other]; }, flash: (c: number, d = 1) => ps().cams.game.flash(c & 0xffffff, d), shake: (i = 0.05, d = 0.5) => ps().cams.game.shake(i, d) },
      sound: { play: playSnd, playMusic: () => { }, music: musicProxy },
      random: {
        int: (a = 0, b = 2147483647, ex?: number[]) => { for (let i = 0; i < 40; i++) { const v = a + Math.floor(Math.random() * (b - a + 1)); if (!ex || !ex.includes(v)) return v; } return a; },
        float: (a = 0, b = 1) => a + Math.random() * (b - a), bool: (chance = 50) => Math.random() * 100 < chance,
        getObject: (arr: any[]) => arr[Math.floor(Math.random() * arr.length)],
      },
      mouse: { get x() { return e().input.mouseX; }, get y() { return e().input.mouseY; }, get screenX() { return e().input.mouseX; }, get screenY() { return e().input.mouseY; },
        get visible() { return e().input.mouseVisible; }, set visible(v: boolean) { e().input.setMouseVisible(!!v); },
        get justPressed() { return e().input.mouseJustPressed(0); }, get pressed() { return e().input.mousePressed(0); }, get justReleased() { return e().input.mouseJustReleased(0); } },
      keys: { justPressed: keyProxy(c => e().input.justPressedRaw(c)), pressed: keyProxy(c => e().input.rawDown(c)), justReleased: keyProxy(() => false) },
      save: { data: {} },
      get state() { return ps(); },
      drawFramerate: 60, updateFramerate: 60, fullscreen: false,
    };
    const easeProxy = new Proxy({}, { get: (_t, k) => ease(String(k)) });
    const tween = (target: any, props: Record<string, number>, dur: number, o: any = {}) => {
      const t = ps().tweens.tween(target, props, dur, {
        ease: o.ease ?? 'linear', delay: o.startDelay ?? 0,
        onComplete: typeof o.onComplete === 'function' ? () => o.onComplete({ }) : undefined,
        onUpdate: typeof o.onUpdate === 'function' ? () => o.onUpdate({}) : undefined,
        loop: o.type === 2 || o.type === 'looping' ? 'looping' : o.type === 4 || o.type === 'pingpong' ? 'pingpong' : 'none',
      });
      return { cancel: () => t.cancel(), get active() { return !t.finished; }, get finished() { return t.finished; } };
    };
    const FlxTween = {
      tween,
      num: (from: number, to: number, dur: number, o: any = {}, cb?: (v: number) => void) => { const h = { v: from }; return tween(h, { v: to }, dur, { ...o, onUpdate: () => cb?.(h.v) }); },
      color: (_s: any, dur: number, from: number, to: number, o: any = {}) => { const h = { v: 0 }; const l = (a: number, b: number, t: number) => Math.round(a + (b - a) * t); return tween(h, { v: 1 }, dur, { ...o, onUpdate: (() => { const f = o.onUpdate; return () => { const c = ((l((from >> 16) & 255, (to >> 16) & 255, h.v) << 16) | (l((from >> 8) & 255, (to >> 8) & 255, h.v) << 8) | l(from & 255, to & 255, h.v)); if (typeof o.onColor === 'function') o.onColor(c); f?.(); }; })() }); },
      cancelTweensOf: (obj: any) => { for (const t of ps().tweens.tweens) if (t.target === obj) t.cancel(); },
      globalManager: {},
    };
    const FlxColor: any = {
      BLACK: 0xff000000, WHITE: 0xffffffff, RED: 0xffff0000, GREEN: 0xff008000, BLUE: 0xff0000ff, YELLOW: 0xffffff00, ORANGE: 0xffffa500,
      CYAN: 0xff00ffff, MAGENTA: 0xffff00ff, PINK: 0xffffc0cb, PURPLE: 0xff800080, LIME: 0xff00ff00, GRAY: 0xff808080, BROWN: 0xff8b4513, TRANSPARENT: 0x00000000,
      fromRGB: (r: number, g: number, b: number, a = 255) => color(a, r, g, b),
      fromRGBFloat: (r: number, g: number, b: number, a = 1) => color(a * 255, r * 255, g * 255, b * 255),
      fromHSB: hsb, fromString: (s: string) => parseColor(s), fromInt: (n: number) => n >>> 0,
      interpolate: (a: number, b: number, t = 0.5) => { const l = (x: number, y: number) => Math.round(x + (y - x) * t); return color(l(a >>> 24, b >>> 24), l((a >> 16) & 255, (b >> 16) & 255), l((a >> 8) & 255, (b >> 8) & 255), l(a & 255, b & 255)); },
      getRGB: (c: number) => ({ r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 }),
    };
    const Paths = {
      image: (k: string) => rt.atlasFor(k, false),
      getSparrowAtlas: (k: string) => rt.atlasFor(k, true),
      getPackerAtlas: (k: string) => rt.atlasFor(k, true),
      sound: (k: string) => ({ __sound: k }),
      soundRandom: (k: string, a: number, b: number) => ({ __sound: k + (a + Math.floor(Math.random() * (b - a + 1))) }),
      music: (k: string) => ({ __music: k }),
      font: (k: string) => k, txt: (k: string) => k, json: (k: string) => k, video: (k: string) => k,
      fileExists: (k: string) => e().assets.exists(k),
      getPath: (k: string) => k,
    };
    const jsMath: any = {
      PI: Math.PI, NaN: NaN, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity,
      isNaN: (x: number) => Number.isNaN(x), isFinite: (x: number) => Number.isFinite(x),
      floor: (x: number) => Math.floor(x), ceil: (x: number) => Math.ceil(x), round: (x: number) => Math.round(x), sin: Math.sin, cos: Math.cos, tan: Math.tan,
      asin: Math.asin, acos: Math.acos, atan: Math.atan, abs: Math.abs, max: Math.max, min: Math.min, sqrt: Math.sqrt, pow: Math.pow, atan2: Math.atan2,
      random: Math.random, exp: Math.exp, log: Math.log, fround: Math.fround,
    };
    const FlxMath = {
      lerp: (a: number, b: number, r: number) => a + (b - a) * r, bound: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
      roundDecimal: (v: number, p: number) => { const m = Math.pow(10, p); return Math.round(v * m) / m; },
      remapToRange: (v: number, s1: number, s2: number, e1: number, e2: number) => e1 + ((v - s1) / (s2 - s1)) * (e2 - e1),
      isEven: (n: number) => n % 2 === 0, isOdd: (n: number) => n % 2 !== 0,
      fastSin: Math.sin, fastCos: Math.cos,
    };
    const Std = {
      int: (x: any) => Math.trunc(Number(x)), string: (x: any) => str(x),
      parseInt: (s: string) => { const n = parseInt(s); return isNaN(n) ? null : n; }, parseFloat: (s: string) => parseFloat(s),
      random: (n: number) => Math.floor(Math.random() * n), isOfType: (v: any, t: any) => typeof t === 'function' && v instanceof t,
    };
    const StringTools = {
      trim: (s: string) => s.trim(), ltrim: (s: string) => s.trimStart(), rtrim: (s: string) => s.trimEnd(),
      startsWith: (s: string, p: string) => s.startsWith(p), endsWith: (s: string, p: string) => s.endsWith(p), contains: (s: string, p: string) => s.includes(p),
      replace: (s: string, a: string, b: string) => s.split(a).join(b), hex: (n: number, d = 0) => n.toString(16).toUpperCase().padStart(d, '0'),
      lpad: (s: string, c: string, l: number) => s.padStart(l, c), rpad: (s: string, c: string, l: number) => s.padEnd(l, c),
    };
    const Reflect = {
      field: (o: any, n: string) => o?.[n] ?? null, setField: (o: any, n: string, v: any) => { if (!rt.setField(o, n, v)) o[n] = v; },
      hasField: (o: any, n: string) => !!o && n in o, fields: (o: any) => Object.keys(o ?? {}),
      getProperty: (o: any, n: string) => o?.[n] ?? null, setProperty: (o: any, n: string, v: any) => { if (!rt.setField(o, n, v)) o[n] = v; },
      callMethod: (o: any, f: any, args: any[] = []) => f.apply(o, args), isFunction: (f: any) => typeof f === 'function',
      deleteField: (o: any, n: string) => delete o[n],
    };
    const Json = { parse: (s: string) => JSON.parse(s), stringify: (v: any, _r?: any, space?: string) => JSON.stringify(v, null, space) };
    const BlendMode = { ADD: 'add', MULTIPLY: 'multiply', SCREEN: 'screen', NORMAL: 'normal', SUBTRACT: 'subtract', DARKEN: 'darken', LIGHTEN: 'lighten', OVERLAY: 'overlay', DIFFERENCE: 'difference', INVERT: 'invert', ALPHA: 'alpha', LAYER: 'normal', ERASE: 'erase', HARDLIGHT: 'hardlight' };
    const Conductor = new Proxy({}, { get: (_t, k) => (ps().cond as any)[String(k)] });
    const ClientPrefs = { get data() { return ps().prefs; } };
    const PlayStateCls = new Proxy({}, {
      get: (_t, k) => { const key = String(k); if (key === 'instance') return ps(); if (key === 'SONG') return ps().song; if (key === 'curStage') return ps().stageName; if (key === 'isStoryMode') return !!ps().opts.isStory; const v = (ps() as any)[key]; return typeof v === 'function' ? v.bind(ps()) : v; },
      set: (_t, k, v) => { (ps() as any)[String(k)] = v; return true; },
    });
    const CoolUtil = {
      floorDecimal: (v: number, d: number) => { const m = Math.pow(10, d); return Math.floor(v * m) / m; },
      boundTo: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
      coolTextFile: (_p: string) => [], formatSong: (s: string, d: string) => s + d,
    };
    const FlxAngle = { asRadians: (d: number) => d * Math.PI / 180, asDegrees: (r: number) => r * 180 / Math.PI, TO_RAD: Math.PI / 180, TO_DEG: 180 / Math.PI };
    return {
      FlxG, FlxTween, FlxEase: easeProxy, FlxColor, Paths, Math: jsMath, FlxMath, Std, StringTools, Reflect, Json, BlendMode, Conductor, ClientPrefs,
      PlayState: PlayStateCls, CoolUtil, FlxAngle, FlxSprite: Sprite, FlxText: TextObj, FlxCamera: Camera, Sprite, Map: HxMap, Sys: { time: () => performance.now() / 1000 },
      FlxTextBorderStyle: { NONE: 0, SHADOW: 1, OUTLINE: 2, OUTLINE_FAST: 3 }, FlxTextAlign: { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFY: 'left' },
      FlxAxes: { X: 'x', Y: 'y', XY: 'xy' }, FlxPoint: { get: (x = 0, y = 0) => ({ x, y }), weak: (x = 0, y = 0) => ({ x, y }) },
      DateTools: { delta: (a: number, b: number) => a - b }, Date: { now: () => ({ getTime: () => Date.now() }) },
    };
  }
}

/** Un archivo .hx (o un bloque de runHaxeCode) con sus funciones de callback. */
export class HxScript {
  rt: HxRuntime;
  closed = false;
  warned = new Set<string>();
  isHx = true;
  constructor(public host: ScriptHost, public path: string, public name: string, public modFolder: string) {
    this.rt = new HxRuntime(host, path);
  }

  /** Ejecuta código. Devuelve el valor de la última expresión / return. */
  exec(source: string): any {
    const prog = parseHx(source);
    return this.rt.interp.run(prog);
  }

  init(source: string) {
    try { this.exec(source); }
    catch (e) { this.host.error(this, 'al cargar', e); this.closed = true; }
  }

  call(fn: string, args: any[] = []): any {
    if (this.closed || !this.rt.interp.has(fn)) return undefined;
    try { const r = this.rt.interp.call(fn, args); return r === null ? undefined : r; }
    catch (e) { this.host.error(this, fn, e instanceof HxError ? e : e); return undefined; }
  }
  has(fn: string) { return this.rt.interp.has(fn); }
  close() { this.closed = true; }
}

/** Busca imágenes y sonidos literales en el HScript para precargarlos antes de ejecutarlo. */
export function hxPrefetchKeys(src: string): { images: Set<string>; sounds: Set<string> } {
  const images = new Set<string>(), sounds = new Set<string>();
  const re = [
    /Paths\.(?:image|getSparrowAtlas|getPackerAtlas)\s*\(\s*(['"])([^'"]+)\1/g,
    /new\s+BGSprite\s*\(\s*(['"])([^'"]+)\1/g,
    /loadGraphic\s*\(\s*(['"])([^'"]+)\1/g,
  ];
  for (const r of re) { let m; while ((m = r.exec(src))) images.add(m[2]); }
  const rs = /Paths\.sound\s*\(\s*(['"])([^'"]+)\1/g; let m2; while ((m2 = rs.exec(src))) sounds.add(m2[2]);
  const rr = /Paths\.soundRandom\s*\(\s*(['"])([^'"]+)\1\s*,\s*(\d+)\s*,\s*(\d+)/g; let m3;
  while ((m3 = rr.exec(src))) for (let i = +m3[3]; i <= +m3[4]; i++) sounds.add(m3[2] + i);
  return { images, sounds };
}
export { Env };
