import { Interp, Env, HxHooks, HxMap, HxError, parseHx, makeIter, str, HxReg } from './interp';
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

  private _gp: any = null;
  /** `game` / `PlayState.instance`: el PlayState con los alias de Psych (camGame, camHUD, camOther…) */
  gameProxy() {
    if (this._gp) return this._gp;
    const ps = this.ps;
    const alias: Record<string, () => any> = {
      camGame: () => ps.cams.game, camHUD: () => ps.cams.hud, camOther: () => ps.cams.other,
      curStage: () => ps.stageName, SONG: () => ps.song, isStoryMode: () => !!ps.opts.isStory, camFollowPos: () => ps.camFollow, boyfriendGroup: () => ps.boyfriend, dadGroup: () => ps.dad, gfGroup: () => ps.gf,
    };
    return this._gp = new Proxy(ps as any, {
      get: (t, k) => { const key = String(k); if (key in alias) return alias[key]();
        if (/^(playerStrums|opponentStrums|strumLineNotes|unspawnNotes|notes)$/.test(key) && Array.isArray(t[key])) { const a = t[key]; if (!('members' in a)) Object.defineProperty(a, 'members', { get() { return this; }, enumerable: false }); return a; }
        const v = t[key]; return typeof v === 'function' ? v.bind(t) : v; },
      set: (t, k, v) => { t[String(k)] = v; return true; },
    });
  }

  // ----------------------------------------------------------- hooks del intérprete
  lookup(name: string): { found: boolean; value?: any } {
    const ps = this.ps;
    switch (name) {
      case 'game': case 'instance': return { found: true, value: this.gameProxy() };
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
      case 'getLuaObject': return { found: true, value: (t: string) => ps.luaSprites.get(String(t)) ?? ps.luaTexts.get(String(t)) ?? null };
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
    const gv = this.gameProxy()[name]; if (gv !== undefined) return { found: true, value: gv };
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
      case 'SpectralAnalyzer': {
        const bars = Number(args[1] ?? 7), an = this.e.audio.analyser; const prev: number[] = new Array(bars).fill(0);
        const obj: any = { fftN: 256, getLevels: (_old?: any) => {
          const data = new Uint8Array(an.frequencyBinCount); an.getByteFrequencyData(data);
          const hz = this.e.audio.ctx.sampleRate / an.fftSize, lo = 40, hi = 16000, out: { value: number; peak: number }[] = [];
          for (let i = 0; i < bars; i++) {
            const f0 = lo * Math.pow(hi / lo, i / bars), f1 = lo * Math.pow(hi / lo, (i + 1) / bars);
            const b0 = Math.max(0, Math.floor(f0 / hz)), b1 = Math.max(b0 + 1, Math.ceil(f1 / hz)); let m = 0;
            for (let b = b0; b < b1 && b < data.length; b++) m = Math.max(m, data[b]);
            const v = Math.pow(m / 255, 2.2); prev[i] = Math.max(v, prev[i] - 0.08);
            out.push({ value: Math.min(1, prev[i]), peak: v });
          }
          return out;
        } };
        return { found: true, value: obj };
      }
      case 'EReg': return { found: true, value: new HxReg(String(args[0] ?? ''), String(args[1] ?? '')) };
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
    const musicProxy = { _channel: { __audioSource: {} }, get volume() { return 1; }, set volume(_v: number) { }, fadeIn: () => { }, fadeOut: () => { }, play: () => { }, stop: () => { } };
    const playSnd = (s: any, vol = 1) => {
      const key = s && s.__sound; if (!key) return null;
      void e().assets.sound(key).then(b => e().audio.playSound(b, vol)); return { volume: vol, stop() { }, pause() { }, play() { } };
    };
    const FlxG = {
      onMobile: false, android: { justReleased: { BACK: false }, pressed: { BACK: false } }, touches: { list: [] }, width: W, height: H, get elapsed() { return 1 / 60; },
      get camera() { return ps().cams.game; },
      cameras: { get list() { return [ps().cams.game, ps().cams.hud, ps().cams.other]; }, flash: (c: number, d = 1) => ps().cams.game.flash(c & 0xffffff, d), shake: (i = 0.05, d = 0.5) => ps().cams.game.shake(i, d) },
      sound: { play: playSnd, load: (sn: any, vol = 1) => ({ play: (_f?: boolean) => playSnd(sn, vol), stop() { }, pause() { }, volume: vol }), playMusic: () => { }, music: musicProxy },
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
      const ty = typeof o.type === 'number' ? o.type : 8;
      const handle: any = {};
      const t = ps().tweens.tween(target, props, dur, {
        ease: o.ease ?? 'linear', delay: o.startDelay ?? 0,
        onComplete: typeof o.onComplete === 'function' ? () => o.onComplete(handle) : undefined,
        onUpdate: typeof o.onUpdate === 'function' ? () => o.onUpdate(handle) : undefined,
        loop: (ty & 2) || o.type === 'looping' ? 'looping' : (ty & 4) || o.type === 'pingpong' ? 'pingpong' : 'none',
      });
      Object.defineProperties(handle, {
        active: { get: () => !t.finished }, finished: { get: () => t.finished }, percent: { get: () => (t as any).progress ?? 0 },
        target: { get: () => target }, duration: { get: () => dur },
      });
      handle.cancel = () => t.cancel(); handle.destroy = () => t.cancel(); handle.start = () => handle;
      return handle;
    };
    const FlxTween = {
      PERSIST: 1, LOOPING: 2, PINGPONG: 4, ONESHOT: 8, BACKWARD: 16,
      tween,
      num: (from: number, to: number, dur: number, o: any = {}, cb?: (v: number) => void) => { const h = { v: from }; return tween(h, { v: to }, dur, { ...o, onUpdate: () => cb?.(h.v) }); },
      angle: (obj: any, from: number, to: number, dur: number, o: any = {}) => { obj.angle = from; return tween(obj, { angle: to }, dur, o); },
      color: (s: any, dur: number, from: number, to: number, o: any = {}) => { const h = { v: 0 }; const l = (a: number, b: number, t: number) => Math.round(a + (b - a) * t); return tween(h, { v: 1 }, dur, { ...o, onUpdate: (() => { const f = o.onUpdate; return (tw: any) => { const c = ((l((from >> 16) & 255, (to >> 16) & 255, h.v) << 16) | (l((from >> 8) & 255, (to >> 8) & 255, h.v) << 8) | l(from & 255, to & 255, h.v)); if (typeof o.onColor === 'function') o.onColor(c); else if (s && typeof s === 'object') s.color = c & 0xffffff; f?.(tw); }; })() }); },
      cancelTweensOf: (obj: any) => { for (const t of ps().tweens.tweens) if (t.target === obj) t.cancel(); },
      completeTweensOf: (obj: any) => { for (const t of ps().tweens.tweens) if (t.target === obj) t.cancel(); },
      globalManager: { clear() { ps().tweens.tweens.forEach(t => t.cancel()); }, cancelTweensOf: (obj: any) => { for (const t of ps().tweens.tweens) if (t.target === obj) t.cancel(); } },
    };
    const flicker = (obj: any, dur = 1, interval = 0.04, endVisible = true, _force = true, done?: (f: any) => void) => {
      const n = Math.max(1, Math.round(dur / Math.max(interval, 0.001)));
      const t = ps().tweens.timer(Math.max(interval, 0.001), n, tm => { obj.visible = !obj.visible; if (tm.finished || tm.elapsedLoops >= n) { obj.visible = endVisible; done?.({}); } });
      return { stop() { t.cancel(); obj.visible = true; }, object: obj };
    };
    const FlxFlicker = { flicker, stopFlickering: (_o: any) => {}, isFlickering: (_o: any) => false };
    const FlxSpriteUtil = {
      flicker: (o: any, dur = 1, interval = 0.04, endVisible = true) => flicker(o, dur, interval, endVisible),
      fadeIn: (o: any, t = 1, _ign = false, cb?: (x: any) => void) => { o.alpha = 0; return tween(o, { alpha: 1 }, t, { onComplete: cb }); },
      fadeOut: (o: any, t = 1, cb?: (x: any) => void) => tween(o, { alpha: 0 }, t, { onComplete: typeof cb === 'function' ? cb : undefined }),
      screenCenter: (o: any, axes = 'xy') => o.screenCenter?.(axes), isFlickering: () => false, stopFlickering: () => {},
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
      getPath: (k: string) => k, getSharedPath: (k = '') => 'assets/shared/' + k, getPreloadPath: (k = '') => 'assets/' + k,
      modFolders: (k: string) => 'mods/' + (e().assets.currentMod ? e().assets.currentMod + '/' : '') + k, mods: (k = '') => 'mods/' + k,
      xml: (k: string) => k, lua: (k: string) => k, hx: (k: string) => k, voices: (k: string) => k, inst: (k: string) => k,
      formatToSongPath: (k: string) => String(k).toLowerCase().replace(/ /g, '-'),
      clearUnusedMemory: () => {}, clearStoredMemory: () => {}, excludeAsset: () => {}, currentTrackedAssets: new Map(),
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
      random: (n: number) => Math.floor(Math.random() * n), isOfType: (v: any, t: any) => isOfType(v, t), is: (v: any, t: any) => isOfType(v, t),
      downcast: (v: any, t: any) => isOfType(v, t) ? v : null, instance: (v: any, t: any) => isOfType(v, t) ? v : null,
    };
    const TString: any = Object.assign(function (x: any) { return str(x); }, { fromCharCode: (c: number) => String.fromCharCode(c), __t: 'String' });
    const TInt = { __t: 'Int' }, TFloat = { __t: 'Float' }, TBool = { __t: 'Bool' }, TDynamic = { __t: 'Dynamic' }, TArray = { __t: 'Array' };
    const isOfType = (v: any, t: any): boolean => {
      if (t === TString) return typeof v === 'string'; if (t === TInt) return typeof v === 'number' && Number.isInteger(v);
      if (t === TFloat) return typeof v === 'number'; if (t === TBool) return typeof v === 'boolean'; if (t === TArray) return Array.isArray(v);
      if (t === TDynamic) return true; if (t && t.__hxclass) return !!v && typeof v === 'object' && (v.__classes ?? []).includes(t);
      return typeof t === 'function' && v instanceof t;
    };
    const Type = {
      getClassName: (o: any) => o?.__hxclass ? o.__name : o?.__classes ? o.__classes[o.__classes.length - 1].__name : (o?.constructor?.name ?? null),
      getClass: (o: any) => o?.__classes ? o.__classes[o.__classes.length - 1] : (o?.constructor ?? null),
      typeof: (o: any) => o === null ? 'TNull' : typeof o === 'number' ? (Number.isInteger(o) ? 'TInt' : 'TFloat') : typeof o === 'boolean' ? 'TBool' : typeof o === 'function' ? 'TFunction' : 'TObject',
      getEnumName: (e: any) => e?.__enum ?? null, enumConstructor: (e: any) => e?.name ?? null, enumParameters: (e: any) => e?.params ?? [],
      enumIndex: (e: any) => 0, getInstanceFields: (c: any) => (c?.__members ?? []).filter((m: any) => !m.isStatic).map((m: any) => m.name),
      resolveClass: (_n: string) => null, createInstance: (c: any, a: any[]) => c?.__new ? c.__new(a) : new c(...a), createEmptyInstance: (c: any) => c?.__new ? c.__new([]) : new c(),
      getSuperClass: (c: any) => c?.__parent ?? null,
    };
    const Lambda = {
      array: (it: any) => Array.from(it ?? []), count: (it: any, f?: (x: any) => boolean) => { let n = 0; for (const x of it) if (!f || f(x)) n++; return n; },
      exists: (it: any, f: (x: any) => boolean) => { for (const x of it) if (f(x)) return true; return false; },
      foreach: (it: any, f: (x: any) => boolean) => { for (const x of it) if (!f(x)) return false; return true; },
      map: (it: any, f: (x: any) => any) => Array.from(it, f), filter: (it: any, f: (x: any) => boolean) => Array.from(it).filter(f),
      fold: (it: any, f: (x: any, a: any) => any, init: any) => { let a = init; for (const x of it) a = f(x, a); return a; },
      find: (it: any, f: (x: any) => boolean) => { for (const x of it) if (f(x)) return x; return null; },
      iter: (it: any, f: (x: any) => void) => { for (const x of it) f(x); }, empty: (it: any) => !Array.from(it).length, has: (it: any, v: any) => Array.from(it).includes(v), indexOf: (it: any, v: any) => Array.from(it).indexOf(v),
    };
    const StringTools = {
      isSpace: (s: string, p: number) => /\s/.test(s.charAt(p)), urlEncode: (s: string) => encodeURIComponent(s), urlDecode: (s: string) => decodeURIComponent(s), htmlEscape: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      fastCodeAt: (s: string, i: number) => s.charCodeAt(i), unsafeCodeAt: (s: string, i: number) => s.charCodeAt(i), isEof: (c: number) => c !== c,
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
      get: (_t, k) => { const key = String(k); if (key === 'instance') return ps(); if (key === 'SONG') return ps().song; if (key === 'createRuntimeShader') return (_n: string) => new (HxShaderRef.c)(); if (key === 'camGame') return ps().cams.game; if (key === 'camHUD') return ps().cams.hud; if (key === 'camOther') return ps().cams.other; if (key === 'camFollowPos') return ps().camFollow; if (key === 'curStage') return ps().stageName; if (key === 'isStoryMode') return !!ps().opts.isStory; const v = (ps() as any)[key]; return typeof v === 'function' ? v.bind(ps()) : v; },
      set: (_t, k, v) => { (ps() as any)[String(k)] = v; return true; },
    });
    const CoolUtil = {
      floorDecimal: (v: number, d: number) => { const m = Math.pow(10, d); return Math.floor(v * m) / m; },
      boundTo: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
      coolTextFile: (_p: string) => [], formatSong: (s: string, d: string) => s + d,
    };
    HxShaderRef.c = null as any;
    class HxPoint {
      constructor(public x = 0, public y = 0) {}
      put() {} set(x = 0, y = x) { this.x = x; this.y = y; return this; } copyFrom(p: any) { this.x = p.x; this.y = p.y; return this; } copyTo(p: any) { p.x = this.x; p.y = this.y; return p; }
      add(x = 0, y = 0) { this.x += x; this.y += y; return this; } subtract(x = 0, y = 0) { this.x -= x; this.y -= y; return this; }
      addPoint(p: any) { this.x += p.x; this.y += p.y; return this; } subtractPoint(p: any) { this.x -= p.x; this.y -= p.y; return this; }
      scale(x: number, y = x) { this.x *= x; this.y *= y; return this; } clone() { return new HxPoint(this.x, this.y); }
      distanceTo(p: any) { return Math.hypot(this.x - p.x, this.y - p.y); } equals(p: any) { return this.x === p.x && this.y === p.y; }
      get length() { return Math.hypot(this.x, this.y); } normalize() { const l = this.length; if (l) { this.x /= l; this.y /= l; } return this; }
      rotate(_pivot: any, deg: number) { const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r); const x = this.x * c - this.y * sn, y = this.x * sn + this.y * c; this.x = x; this.y = y; return this; }
      toString() { return `(x: ${this.x} | y: ${this.y})`; }
    }
    /** Shader de OpenFL/Flixel: solo guarda parámetros (solo adjustColor se emula en pantalla). */
    class HxShader {
      params = new Map<string, any>(); frag = ''; vert = '';
      constructor(frag = '', vert = '') { this.frag = String(frag ?? ''); this.vert = String(vert ?? ''); warnShader(); }
      setFloat(n: string, v: number) { this.params.set(n, v); } setFloatArray(n: string, v: number[]) { this.params.set(n, v); }
      setInt(n: string, v: number) { this.params.set(n, v); } setIntArray(n: string, v: number[]) { this.params.set(n, v); }
      setBool(n: string, v: boolean) { this.params.set(n, v); } setBoolArray(n: string, v: boolean[]) { this.params.set(n, v); }
      setSampler2D(n: string, v: any) { this.params.set(n, v); } setSampler(n: string, v: any) { this.params.set(n, v); }
      getFloat(n: string) { return this.params.get(n); } getFloatArray(n: string) { return this.params.get(n); } getInt(n: string) { return this.params.get(n); } getBool(n: string) { return this.params.get(n); }
      get data(): any { const m = this.params; return new Proxy({}, { get: (_t, k) => new Proxy({}, { get: (_t2, kk) => kk === 'value' ? m.get(String(k)) : undefined, set: (_t2, kk, v) => { if (kk === 'value') m.set(String(k), v); return true; } }) }); }
    }
    HxShaderRef.c = HxShader;
    let shaderWarned = false;
    const warnShader = () => { if (!shaderWarned) { shaderWarned = true; console.warn('[HScript] shaders personalizados: parámetros guardados pero no se dibujan (solo adjustColor)'); } };
    const FlxAngle = { asRadians: (d: number) => d * Math.PI / 180, asDegrees: (r: number) => r * 180 / Math.PI, TO_RAD: Math.PI / 180, TO_DEG: 180 / Math.PI };
    return {
      String: TString, Int: TInt, Float: TFloat, Bool: TBool, Dynamic: TDynamic, Array: TArray, Type, Lambda,
      FlxG, FlxTween, FlxFlicker, FlxSpriteUtil, FlxEase: easeProxy, FlxColor, Paths, Math: jsMath, FlxMath, Std, StringTools, Reflect, Json, BlendMode, Conductor, ClientPrefs,
      PlayState: PlayStateCls, CoolUtil, FlxAngle, FlxSprite: Sprite, FlxText: TextObj, FlxCamera: Camera, Sprite, Map: HxMap, Sys: { time: () => performance.now() / 1000 },
      FlxTextBorderStyle: { NONE: 0, SHADOW: 1, OUTLINE: 2, OUTLINE_FAST: 3 }, FlxTextAlign: { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFY: 'left' },
      FlxAxes: { X: 'x', Y: 'y', XY: 'xy' }, FlxPoint: Object.assign(HxPoint, { get: (x = 0, y = 0) => new HxPoint(x, y), weak: (x = 0, y = 0) => new HxPoint(x, y) }),
      FlxRuntimeShader: HxShader, FlxShader: HxShader, FlxGraphicsShader: HxShader, ShaderFilter: class { constructor(public shader: any) { warnShader(); } },
      BitmapFilter: class {}, BlurFilter: class { constructor(public blurX = 4, public blurY = 4) {} }, ColorMatrixFilter: class { constructor(public matrix: any = null) {} }, GlowFilter: class {}, DropShadowFilter: class {},
      DateTools: { delta: (a: number, b: number) => a - b }, Date: { now: () => ({ getTime: () => Date.now() }) },
    };
  }
}

/** Un archivo .hx (o un bloque de runHaxeCode) con sus funciones de callback. */
const HxShaderRef: { c: any } = { c: null };

export class HxScript {
  rt: HxRuntime;
  closed = false;
  warned = new Set<string>();
  isHx = true;
  constructor(public host: ScriptHost, public path: string, public name: string, public modFolder: string) {
    this.rt = new HxRuntime(host, path);
  }

  /** Ejecuta código. Devuelve el valor de la última expresión / return. */
  exec(source: string, vars?: Record<string, any>): any {
    const prog = parseHx(source);
    if (vars && typeof vars === 'object') for (const [k, v] of Object.entries(vars)) this.rt.interp.globals.def(k, v);
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
