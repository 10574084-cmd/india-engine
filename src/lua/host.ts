import { TypeText } from '../engine/typetext';
import { AnimateAtlas, AnimateSprite } from '../engine/animate';
import { makeFx, SUPPORTED_SHADERS } from '../engine/shaderfx';
import { BUILTIN_SCRIPTS } from '../builtin/scripts';
import { LuaFactory, LuaEngine } from 'wasmoon';
import glueWasm from 'wasmoon/dist/glue.wasm?url';
import type { PlayState, EventNote } from '../game/playstate';
import { FUNCTION_STOP, FUNCTION_CONTINUE } from '../game/playstate';
import { Drawable, Sprite, TextObj, W, H } from '../engine/display';
import { Track } from '../engine/audio';
import { ENGINE_NAME, ENGINE_VERSION, PSYCH_COMPAT_VERSION } from '../engine/engine';
import { modSave } from '../engine/save';
import { Character, preloadCharacter } from '../game/character';
import { Note, StrumNote, SING_ANIMS } from '../game/note';
import { VideoSprite, resolveVideo } from '../game/video';
import { HxScript, hxPrefetchKeys } from '../hx/runtime';

let factory: LuaFactory | null = null;
const getFactory = () => (factory ??= new LuaFactory(glueWasm));

const COLOR_NAMES: Record<string, number> = {
  white: 0xffffff, black: 0x000000, red: 0xff0000, green: 0x008000, blue: 0x0000ff, yellow: 0xffff00, orange: 0xffa500,
  purple: 0x800080, pink: 0xffc0cb, cyan: 0x00ffff, magenta: 0xff00ff, gray: 0x808080, grey: 0x808080, lime: 0x00ff00,
  brown: 0x8b4513, transparent: 0x000000,
};

/** "FF0000", "#FF0000", "0xFFFF0000" -> entero ARGB (como FlxColor) */
export function parseColor(v: any): number {
  if (typeof v === 'number') return v >>> 0;
  let s = String(v ?? '').trim().toLowerCase();
  if (COLOR_NAMES[s] !== undefined) return (0xff000000 | COLOR_NAMES[s]) >>> 0;
  s = s.replace(/^#/, '').replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(s)) return 0xffffffff;
  if (s.length <= 6) return (0xff000000 | parseInt(s, 16)) >>> 0;
  return parseInt(s, 16) >>> 0;
}

const CAM_ALIAS: Record<string, 'game' | 'hud' | 'other'> = {
  camgame: 'game', game: 'game', camhud: 'hud', hud: 'hud', camother: 'other', other: 'other',
};

interface Ctx { host: ScriptHost; script: LuaScript }

export class LuaScript {
  lua!: LuaEngine;
  closed = false;
  warned = new Set<string>();
  hx: HxScript | null = null;
  constructor(public host: ScriptHost, public path: string, public name: string, public modFolder: string) {}

  async init(source: string) {
    this.lua = await getFactory().createEngine({ injectObjects: false, openStandardLibs: true });
    this.host.registerApi(this);
    this.host.setGlobals(this, true);
    try { await this.lua.doString(source); }
    catch (e) { this.host.error(this, 'al cargar', e); this.closed = true; }
  }

  call(fn: string, args: any[] = []): any {
    if (this.closed) return undefined;
    let f: any;
    try { f = this.lua.global.get(fn); } catch { return undefined; }
    if (typeof f !== 'function') return undefined;
    try { return f(...args); }
    catch (e) { this.host.error(this, fn, e); return undefined; }
  }
  has(fn: string) { try { return typeof this.lua.global.get(fn) === 'function'; } catch { return false; } }

  close() { if (this.closed) return; this.closed = true; try { this.lua.global.close(); } catch { /* ya cerrado */ } }
}

export class ScriptHost {
  scripts: LuaScript[] = [];
  hxScripts: HxScript[] = [];
  apiFns = new Map<string, (...a: any[]) => any>();
  stageHandledByScript = false;
  vars = new Map<string, any>();
  shaderParams = new Map<string, any>();
  textCache = new Map<string, string[]>();
  clientData: any = (() => { const extra: Record<string, any> = { language: 'en-US', pauseMusic: 'Tea Time', checkForUpdates: false, flashing: true }; const self = this;
    return new Proxy({}, { get: (_t, k: string) => k in extra ? extra[k] : (self.ps.prefs as any)[k], set: (_t, k: string, v: any) => { if (k in (self.ps.prefs as any) && !(k in extra)) (self.ps.prefs as any)[k] = v; else extra[k] = v; return true; } }); })();
  chartCache = new Map<string, any>();
  errorCount = new Map<string, number>();
  animCache = new Map<string, AnimateAtlas | null>();
  objShaders = new Map<any, { name: string; params: Record<string, any> }>();
  shaderFiles = new Set<string>();
  sounds = new Map<string, Track>();
  private errorsShown = new Set<string>();
  pendingLoads: Promise<any>[] = [];

  constructor(public ps: PlayState) {}

  get e() { return this.ps.e; }

  // ------------------------------------------------------------------ carga
  private seenFiles = new Set<string>();
  /** fase 'stage': solo el script del stage (antes de crear personajes); fase 'rest': el resto (después de crear personajes) */
  async loadAll(phase: 'stage' | 'rest' = 'rest') {
    const ps = this.ps, a = ps.e.assets;
    const firstLua = this.scripts.length, firstHx = this.hxScripts.length;
    // archivos guardados con saveFile() en sesiones anteriores
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i); if (!k || !k.startsWith('india.file.')) continue;
        const [mod, ...rest] = k.slice('india.file.'.length).split('|'); const f = rest.join('|');
        if (mod !== a.currentMod) continue;
        const data = new TextEncoder().encode(localStorage.getItem(k) ?? '').buffer as ArrayBuffer;
        ps.e.vfs.add(mod ? `mods/${mod}/${f}` : `mods/${f}`, async () => data);
      }
    } catch { /* sin almacenamiento */ }
    const seen = this.seenFiles;
    const queue: { path: string; mod: string }[] = [];
    const hxQueue: { path: string; mod: string }[] = [];
    const modOf = (p: string) => /^mods\/([^/]+)\//i.exec(p)?.[1] ?? '';
    const addDir = (dir: string) => {
      for (const c of a.candidates(dir)) {
        for (const ext of ['.lua', '.hx']) for (const f of a.vfs.listFiles(c, ext)) {
          const full = `${c}/${f}`;
          const k = full.toLowerCase();
          if (!seen.has(k)) { seen.add(k); (ext === '.hx' ? hxQueue : queue).push({ path: a.vfs.realPath(full)!, mod: modOf(full) }); }
        }
      }
    };
    const addFile = (file: string) => {
      for (const c of a.candidates(file)) if (a.vfs.has(c)) {
        const k = c.toLowerCase();
        if (!seen.has(k)) { seen.add(k); (file.endsWith('.hx') ? hxQueue : queue).push({ path: a.vfs.realPath(c)!, mod: modOf(c) }); }
      }
    };
    if (phase === 'stage') {
      const before = queue.length + hxQueue.length;
      addFile(`stages/${ps.stageName}.lua`);
      addFile(`stages/${ps.stageName}.hx`);
      if (queue.length + hxQueue.length > before) this.stageHandledByScript = true;
    } else {
    addDir('scripts');
    addDir(`data/${ps.songName}`);
    for (const n of new Set([ps.song.player1, ps.song.player2, ps.song.gfVersion || ps.stageImpl?.defaultGF || 'gf'])) {
      if (!n) continue; addFile(`characters/${n}.lua`); addFile(`characters/${n}.hx`);
    }
    const evs = new Set(ps.eventNotes.map(x => x.event));
    for (const ev of evs) { addFile(`custom_events/${ev}.lua`); addFile(`custom_events/${ev}.hx`); }
    const types = new Set<string>();
    ps.song.notes.forEach(s => s.sectionNotes.forEach(n => { if (typeof n[3] === 'string' && n[3]) types.add(n[3]); }));
    for (const t of types) { addFile(`custom_notetypes/${t}.lua`); addFile(`custom_notetypes/${t}.hx`); }

    }
    for (const b of BUILTIN_SCRIPTS) {
      if (phase === 'stage' || !ps.prefs.scripts?.[b.id]) continue;
      await this.prefetch(b.src);
      const s = new LuaScript(this, 'builtin/' + b.id + '.lua', b.id + '.lua', '');
      this.scripts.push(s);
      await s.init(b.src);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const q = queue[qi];
      let src: string;
      try { src = await a.vfs.text(q.path); } catch { continue; }
      // scripts que este script cargará con addLuaScript('x'): se precargan para que estén listos al llamarlos
      { const ra = /addLuaScript\s*\(\s*(['"])([^'"]+)\1/g; let m;
        while ((m = ra.exec(src))) { const f = m[2].endsWith('.lua') ? m[2] : m[2] + '.lua'; const before = queue.length; addFile(f); void before; } }
      await this.prefetch(src);
      const s = new LuaScript(this, q.path, q.path.split('/').pop()!, q.mod);
      this.scripts.push(s);
      await s.init(src);
    }
    for (const q of hxQueue) {
      let src: string;
      try { src = await a.vfs.text(q.path); } catch { continue; }
      await this.prefetchHx(src);
      const h = new HxScript(this, q.path, q.path.split('/').pop()!, q.mod);
      this.hxScripts.push(h);
      h.init(src);
    }
    // cargas asíncronas que dispararon los scripts durante onCreate
    await Promise.all(this.pendingLoads); this.pendingLoads = [];
    // onCreate (solo de los scripts nuevos de esta fase)
    this.syncGlobals();
    for (const sc of [...this.scripts.slice(firstLua), ...this.hxScripts.slice(firstHx)] as { closed: boolean; call(n: string, a: any[]): any }[]) if (!sc.closed) sc.call('onCreate', []);
    await Promise.all(this.pendingLoads); this.pendingLoads = [];
  }

  async prefetchHx(src: string) {
    const a = this.e.assets; const { images, sounds } = hxPrefetchKeys(src);
    await Promise.all([
      ...[...images].map(async k => { await a.image(k); if (a.hasAtlasData(k)) await a.atlas(k); }),
      ...[...sounds].map(k => a.sound(k)),
    ]);
  }

  /** Busca nombres de imágenes/sonidos literales en el script para tenerlos en caché antes de ejecutarlo. */
  private async prefetch(src: string) {
    const a = this.e.assets;
    const keys = new Set<string>();
    const re = [
      /make(?:Animated)?LuaSprite\s*\(\s*[^,()]+,\s*(['"])([^'"]+)\1()/g,
      /loadGraphic\s*\(\s*(['"])[^'"]*\1\s*,\s*(['"])([^'"]+)\2/g,
      /loadFrames\s*\(\s*(['"])[^'"]*\1\s*,\s*(['"])([^'"]+)\2/g,
      /precacheImage\s*\(\s*(['"])([^'"]+)\1()/g,
    ];
    for (const r of re) { let m; while ((m = r.exec(src))) keys.add(m[3] || m[2]); }
    { const ra = /loadAnimateAtlas\s*\(\s*[^,()]+,\s*(['"])([^'"]+)\1()/g; let m3;
      while ((m3 = ra.exec(src))) { const f = m3[2]; if (!this.animCache.has(f)) this.animCache.set(f, await AnimateAtlas.load(a, f)); } }
    if (/coolTextFile/.test(src)) {
      const folder = this.ps.songName;
      for (const c of [`data/${folder}`, 'data']) for (const d of a.candidates(c)) for (const f of a.vfs.listFiles(d, '.txt')) {
        const key = `${c}/${f}`.toLowerCase();
        if (this.textCache.has(key)) continue;
        try { this.textCache.set(key, (await a.vfs.text(a.vfs.realPath(`${d}/${f}`)!)).split('\n').map(x => x.trim())); } catch { /* ilegible */ }
      }
    }
    if (/getChart/.test(src)) {
      const folder = this.ps.songName;
      for (const c of a.candidates(`data/${folder}`)) for (const f of a.vfs.listFiles(c, '.json')) {
        const key = `${folder}/${f.replace(/\.json$/i, '').toLowerCase()}`;
        if (this.chartCache.has(key)) continue;
        try { this.chartCache.set(key, JSON.parse(await a.vfs.text(a.vfs.realPath(`${c}/${f}`)!))); } catch { /* json inválido */ }
      }
    }
    if (/objects\.Character/.test(src)) {
      const lits = new Set<string>(); const rl = /(['"])([\w\-./ ]{2,40})\1/g; let ml;
      while ((ml = rl.exec(src))) { lits.add(ml[2]); lits.add('cutscenes/' + ml[2]); }
      for (const n of lits) if (a.exists(`characters/${n}.json`)) await preloadCharacter(a, n);
    }
    const hxk = hxPrefetchKeys(src);   // bloques runHaxeCode dentro del Lua
    for (const k of hxk.images) keys.add(k);
    const snds = new Set<string>(hxk.sounds);
    const rs = /(?:playSound|precacheSound)\s*\(\s*(['"])([^'"]+)\1/g; let m2;
    while ((m2 = rs.exec(src))) snds.add(m2[2]);
    await Promise.all([
      ...[...keys].map(async k => { await a.image(k); if (a.hasAtlasData(k)) await a.atlas(k); }),
      ...[...snds].map(k => a.sound(k)),
    ]);
  }

  destroy() {
    for (const s of this.scripts) { try { s.call('onDestroy'); } catch { /* */ } s.close(); }
    for (const h of this.hxScripts) { try { h.call('onDestroy'); } catch { /* */ } h.close(); }
    this.scripts = []; this.hxScripts = [];
    for (const t of this.sounds.values()) t.destroy();
    this.sounds.clear();
  }

  error(s: { name: string }, where: string, e: any) {
    const msg = `${s.name}: ${where}: ${(e && e.message) ? String(e.message).split('\n')[0] : e}`;
    const k = msg.slice(0, 120);
    const n = (this.errorCount.get(k) ?? 0) + 1; this.errorCount.set(k, n);
    if (n <= 3 || n % 500 === 0) console.error('[Lua]', msg + (n > 3 ? ` (x${n})` : '') + '\n' + String(e?.stack ?? '').slice(0, 900));
    if (!this.errorsShown.has(k)) { this.errorsShown.add(k); this.e.toast('[Lua] ' + msg, '#ff7777', 7); }
  }

  // ------------------------------------------------------------------ llamadas
  call(name: string, args: any[] = []): any {
    if (!this.scripts.length && !this.hxScripts.length) return undefined;
    this.syncGlobals();
    let result: any;
    for (const s of [...this.scripts, ...this.hxScripts] as { closed: boolean; call(n: string, a: any[]): any }[]) {
      if (s.closed) continue;
      const r = s.call(name, args);
      if (r === FUNCTION_STOP) result = FUNCTION_STOP;
      else if (r === 'Function_StopLua') { result = FUNCTION_STOP; break; }
      else if (r !== undefined && r !== null && result === undefined) result = r;
    }
    return result;
  }
  callEventScript(_name: string, _args: any[]) { /* los custom_events reciben onEvent desde call() */ }

  eventEarlyTrigger(ev: EventNote): number {
    let best = 0;
    for (const s of [...this.scripts, ...this.hxScripts] as { call(n: string, a: any[]): any }[]) {
      const r = s.call('eventEarlyTrigger', [ev.event, ev.value1, ev.value2, ev.strumTime]);
      if (typeof r === 'number' && r > best) best = r;
    }
    return best;
  }

  // ------------------------------------------------------------------ globales
  setGlobals(s: LuaScript, first = false) {
    const ps = this.ps, p = ps.prefs, g = s.lua.global;
    const set = (k: string, v: any) => g.set(k, v);
    if (first) {
      set('Function_Stop', FUNCTION_STOP); set('Function_Continue', FUNCTION_CONTINUE);
      set('Function_StopLua', 'Function_StopLua'); set('Function_StopHScript', 'Function_StopHScript'); set('Function_StopAll', 'Function_StopAll');
      set('luaDebugMode', false); set('luaDeprecatedWarnings', false);
      set('version', PSYCH_COMPAT_VERSION); set('psychVersion', PSYCH_COMPAT_VERSION);
      set('indiaVersion', ENGINE_VERSION); set('engineName', ENGINE_NAME);
      set('inChartEditor', false);
      set('scriptName', s.path); set('currentModDirectory', s.modFolder || ps.opts.mod);
      set('modFolder', s.modFolder || ps.opts.mod);
      set('buildTarget', 'browser');
      set('screenWidth', W); set('screenHeight', H);
      set('songName', ps.song.song); set('songPath', ps.songName);
      set('isStoryMode', !!ps.opts.isStory); set('difficultyName', ps.opts.diffName); set('difficulty', 1);
      set('weekRaw', ''); set('week', ''); set('seenCutscene', false);
      set('hasVocals', !!ps.vocals);
      set('downscroll', p.downScroll); set('middlescroll', p.middleScroll); set('framerate', 60);
      set('ghostTapping', p.ghostTapping); set('hideHud', p.hideHud); set('timeBarType', p.timeBarType);
      set('scoreZoom', p.scoreZoom); set('cameraZoomOnBeat', p.camZooms); set('flashingLights', p.flashing);
      set('noteOffset', p.noteOffset); set('healthBarAlpha', p.healthBarAlpha); set('noResetButton', false);
      set('lowQuality', p.lowQuality); set('shadersEnabled', true);
      set('defaultBoyfriendX', ps.BF_X); set('defaultBoyfriendY', ps.BF_Y);
      set('defaultOpponentX', ps.DAD_X); set('defaultOpponentY', ps.DAD_Y);
      set('defaultGirlfriendX', ps.GF_X); set('defaultGirlfriendY', ps.GF_Y);
      set('boyfriendName', ps.song.player1); set('dadName', ps.song.player2); set('gfName', ps.song.gfVersion);
      set('stageName', ps.stageName); set('curStage', ps.stageName); set('isPixelStage', ps.isPixelStage);
    }
    this.syncOne(s);
  }

  private syncGlobals() { for (const s of this.scripts) if (!s.closed) this.syncOne(s); }
  private syncOne(s: LuaScript) {
    const ps = this.ps, c = ps.cond, g = s.lua.global;
    const sec = ps.song.notes[ps.curSection];
    const set = (k: string, v: any) => g.set(k, v);
    set('curBpm', c.bpm); set('bpm', ps.song.bpm); set('scrollSpeed', ps.songSpeed);
    set('crochet', c.crochet); set('stepCrochet', c.stepCrochet); set('songLength', ps.songLength);
    set('startedCountdown', ps.startedCountdown); set('playbackRate', ps.playbackRate); set('inGameOver', ps.mode === 'dead'); set('seenCutscene', !!ps.opts.seenCutscene); set('songPath', ps.songName);
    set('curSection', ps.curSection); set('curBeat', ps.curBeat); set('curStep', ps.curStep);
    set('mustHitSection', sec ? !!sec.mustHitSection : false); set('altAnim', sec ? !!sec.altAnim : false); set('gfSection', sec ? !!sec.gfSection : false);
    set('score', ps.songScore); set('misses', ps.songMisses); set('hits', ps.songHits); set('combo', ps.combo);
    set('rating', ps.ratingPercent); set('ratingName', ps.ratingName); set('ratingFC', ps.ratingFC);
    set('botPlay', ps.cpuControlled);
    set('cameraX', ps.camFollow.x); set('cameraY', ps.camFollow.y);
  }

  // ------------------------------------------------------------------ propiedades
  rootObj(name: string): any {
    const ps = this.ps;
    switch (name) {
      case 'boyfriend': case 'boyfriendGroup': return ps.boyfriend;
      case 'dad': case 'dadGroup': return ps.dad;
      case 'gf': case 'gfGroup': return ps.gf;
      case 'camGame': return ps.cams.game;
      case 'camHUD': return ps.cams.hud;
      case 'camOther': return ps.cams.other;
      case 'game': case 'instance': case 'PlayState': return ps;
      case 'camFollow': case 'camFollowPos': return ps.camFollow;
      case 'healthBar': return ps.healthBar;
      case 'timeBar': return ps.timeBar;
      case 'iconP1': return ps.iconP1;
      case 'iconP2': return ps.iconP2;
      case 'scoreTxt': return ps.scoreTxt;
      case 'timeTxt': return ps.timeTxt;
      case 'botplayTxt': return ps.botplayTxt;
      case 'playerStrums': return ps.playerStrums;
      case 'opponentStrums': return ps.opponentStrums;
      case 'strumLineNotes': return ps.strumLineNotes;
      case 'notes': return ps.notes;
      case 'unspawnNotes': return ps.unspawnNotes;
      case 'SONG': return ps.song;
    }
    return undefined;
  }

  /** Devuelve [objeto padre, clave] para una ruta tipo "boyfriend.scale.x" o "miSprite.alpha". */
  resolve(path: string): { parent: any; key: string | number } | null {
    const ps = this.ps;
    const toks = String(path).split(/[.\[\]]+/).filter(t => t.length);
    if (!toks.length) return null;
    let obj: any; let i = 0;
    const r0 = this.rootObj(toks[0]);
    if (r0 !== undefined && toks.length > 1) { obj = r0; i = 1; }
    else if (ps.luaSprites.has(toks[0]) && toks.length > 1) { obj = ps.luaSprites.get(toks[0]); i = 1; }
    else if (ps.luaTexts.has(toks[0]) && toks.length > 1) { obj = ps.luaTexts.get(toks[0]); i = 1; }
    else if (this.vars.has(toks[0]) && toks.length > 1) { obj = this.vars.get(toks[0]); i = 1; }
    else { obj = ps; i = 0; }
    for (; i < toks.length - 1; i++) {
      if (obj == null) return null;
      const t = /^\d+$/.test(toks[i]) ? parseInt(toks[i], 10) : toks[i];
      obj = obj[t as any];
    }
    if (obj == null) return null;
    const last = /^\d+$/.test(toks[toks.length - 1]) ? parseInt(toks[toks.length - 1], 10) : toks[toks.length - 1];
    return { parent: obj, key: last };
  }

  /** Objeto completo al que apunta la ruta (para tweens, etc.) */
  objectAt(path: string): any {
    const p = String(path);
    const ps = this.ps;
    if (ps.luaSprites.has(p)) return ps.luaSprites.get(p);
    if (ps.luaTexts.has(p)) return ps.luaTexts.get(p);
    const r = this.rootObj(p);
    if (r !== undefined) return r;
    const rr = this.resolve(p);
    if (!rr) return undefined;
    return rr.parent[rr.key as any];
  }

  getProp(path: string): any {
    const r = this.resolve(path);
    if (!r) return null;
    let v = r.parent[r.key as any];
    if (v === undefined) return null;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return null;
    if (typeof v === 'function') return null;
    return v;
  }

  setProp(path: string, value: any) {
    const r = this.resolve(path);
    if (!r) return false;
    const { parent, key } = r;
    if (key === 'color' && (parent instanceof Sprite || parent instanceof TextObj)) value = parseColor(value) & 0xffffff;
    else if (key === 'health' && parent === this.ps) { this.ps.health = value; return true; }
    else if (key === 'blend' && typeof value === 'string') { /* ok */ }
    try { parent[key as any] = value; } catch { return false; }
    if (parent instanceof StrumNote && key === 'alpha') this.ps.tweens.cancelTag('__none');
    return true;
  }

  classRoot(cls: string): any {
    const ps = this.ps;
    const c = cls.split('.').pop()!;
    switch (c) {
      case 'FlxG': {
        const inp = this.e.input;
        return { onMobile: false, android: { justReleased: { BACK: false } }, touches: { list: [] }, width: W, height: H, elapsed: 1 / 60, sound: { music: this.musicProxy() }, save: { data: {} },
          mouse: { get x() { return inp.mouseX; }, get y() { return inp.mouseY; }, get screenX() { return inp.mouseX; }, get screenY() { return inp.mouseY; },
            get visible() { return inp.mouseVisible; }, set visible(v: boolean) { inp.setMouseVisible(!!v); },
            get justPressed() { return inp.mouseJustPressed(0); }, get pressed() { return inp.mousePressed(0); }, get justReleased() { return inp.mouseJustReleased(0); },
            get justPressedRight() { return inp.mouseJustPressed(2); }, get pressedRight() { return inp.mousePressed(2); } } };
      }
      case 'ClientPrefs': return { data: this.clientData, getGameplaySetting: (k: string, d?: any) => d ?? false };
      case 'PlayState': return { ...this.psProxy(), instance: ps, SONG: ps.song, curStage: ps.stageName, isStoryMode: !!ps.opts.isStory, storyDifficulty: 1 };
      case 'Conductor': return ps.cond;
      case 'MainMenuState': return { psychEngineVersion: PSYCH_COMPAT_VERSION };
      case 'GameOverSubstate': {
        const d = ps.gameOverDefs;
        return { instance: { get boyfriend() { return (ps as any).deadChar; } },
          get characterName() { return d.char; }, set characterName(v: string) { d.char = v; ps.song.gameOverChar = v; },
          get deathSoundName() { return d.sound; }, set deathSoundName(v: string) { d.sound = v; ps.song.gameOverSound = v; },
          get loopSoundName() { return d.loop; }, set loopSoundName(v: string) { d.loop = v; ps.song.gameOverLoop = v; },
          get endSoundName() { return d.end; }, set endSoundName(v: string) { d.end = v; ps.song.gameOverEnd = v; } };
      }
      case 'Paths': return {
        formatToSongPath: (x: string) => String(x).toLowerCase().replace(/[~&;:<>#\s]/g, '-').replace(/[.,'"%?!]/g, ''),
        txt: (k: string) => 'data/' + k + '.txt', json: (k: string) => 'data/' + k + '.json', image: (k: string) => 'images/' + k + '.png',
      };
      case 'Song': return {
        getChart: (name: string, folder?: string) => {
          const f = String(folder ?? ps.songName).toLowerCase();
          const j = this.chartCache.get(`${f}/${String(name).toLowerCase()}`);
          const c = j ? (j.song && typeof j.song === 'object' ? j.song : j) : undefined;
          const clean = (v: any): any => Array.isArray(v) ? v.map(x => x === null || x === undefined ? 0 : clean(x)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, clean(x)])) : v;
          return c ? clean(c) : undefined;
        },
      };
      case 'CoolUtil': return { coolTextFile: (p: string) => this.textCache.get(String(p).toLowerCase()) ?? [], floorDecimal: (v: number, d: number) => Math.floor(v * 10 ** d) / 10 ** d };
    }
    return undefined;
  }
  private psProxy() { return this.ps; }
  private musicProxy() {
    const ps = this.ps;
    return {
      get volume() { return ps.inst?.volume ?? 1; }, set volume(v: number) { if (ps.inst) ps.inst.volume = v; },
      get time() { return ps.cond.songPosition; },
      get pitch() { return ps.playbackRate; },
      set pitch(v: number) { ps.playbackRate = v; if (ps.inst) ps.inst.pitch = v; if (ps.vocals) ps.vocals.pitch = v; if (ps.opponentVocals) ps.opponentVocals.pitch = v; },
    };
  }

  setPropertyFromEvent(prop: string, value: string) {
    let v: any = value;
    if (value === 'true') v = true; else if (value === 'false') v = false; else if (value !== '' && !isNaN(Number(value))) v = Number(value);
    this.setProp(prop, v);
  }

  // ------------------------------------------------------------------ utilidades de sprites
  private spriteOrNull(tag: string): any {
    return this.objectAt(tag);
  }
  makeSprite(tag: string, image: string | null | undefined, x: number, y: number, animated: boolean): Sprite {
    const ps = this.ps, a = this.e.assets;
    const old = ps.luaSprites.get(tag);
    if (old) ps.removeDrawable(old);
    const s = new Sprite(x ?? 0, y ?? 0);
    s.tag = tag;
    ps.luaSprites.set(tag, s);
    if (image) {
      const apply = (at: any) => { if (at) { s.setAtlas(at); (s as any)._flush?.(); } };
      const cached = animated ? a.peekAtlas(image) : a.peekImage(image);
      if (cached) s.setAtlas(cached);
      else {
        const ops: (() => void)[] = [];
        (s as any)._ops = ops;
        const p = (animated ? a.atlas(image) : a.image(image)).then(at => {
          if (at) { s.setAtlas(at); }
          for (const op of ops) op();
          (s as any)._ops = null;
        });
        this.pendingLoads.push(p);
        void apply;
      }
    }
    return s;
  }
  /** ejecuta `fn` ahora, o cuando el sprite termine de cargar su imagen */
  whenLoaded(s: any, fn: () => void) {
    if (s && s._ops) s._ops.push(fn); else fn();
  }

  private camName(v: any): 'game' | 'hud' | 'other' { return CAM_ALIAS[String(v ?? '').toLowerCase()] ?? 'game'; }

  reorder(o: Drawable, order: number) {
    const ps = this.ps;
    for (const l of [ps.layerBack, ps.layerChars, ps.layerFront, ps.layerHud, ps.layerOther]) {
      const i = l.indexOf(o);
      if (i >= 0) { l.splice(i, 1); l.splice(Math.max(0, Math.min(order, l.length)), 0, o); return; }
    }
  }
  orderOf(o: Drawable): number {
    const ps = this.ps;
    const all = [...ps.layerBack, ...ps.layerChars, ...ps.layerFront];
    return all.indexOf(o);
  }

  stopSound(tag: string) { const t = this.sounds.get(tag); if (t) { t.destroy(); this.sounds.delete(tag); } }

  // =================================================================== API Lua
  registerApi(script: LuaScript) {
    const ps = this.ps, host = this, e = this.e;
    const g = script.lua.global;
    const def = (name: string, fn: (...a: any[]) => any) => {
      const wrapped = (...a: any[]) => {
        try { const r = fn(...a); return r === null ? undefined : r; } catch (err) { host.error(script, name, err); return undefined; }
      };
      if (!host.apiFns.has(name)) host.apiFns.set(name, wrapped);
      g.set(name, wrapped);
    };
    const rate = () => ps.playbackRate;
    const unsupported = (name: string, ret: any = false) => def(name, () => {
      const k = name; if (!script.warned.has(k)) { script.warned.add(k); console.warn(`[Lua] ${name} no está soportado todavía en India Engine`); }
      return ret;
    });

    // ---------------------------------------------------------- depuración y utilidades
    def('debugPrint', (...a: any[]) => { const t = a.filter(x => typeof x !== 'number' || a.length === 1 || a.indexOf(x) < a.length - 0).join(' '); console.log('[Lua]', t); e.toast('[Lua] ' + t, '#ffffff', 4); });
    def('close', () => { script.close(); return true; });
    def('getRandomInt', (min: number, max = 0, exclude = '') => {
      const ex = String(exclude).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      for (let i = 0; i < 50; i++) { const v = Math.floor(min + Math.random() * (max - min + 1)); if (!ex.includes(v)) return v; }
      return min;
    });
    def('getRandomFloat', (min: number, max = 1) => min + Math.random() * (max - min));
    def('getRandomBool', (chance = 50) => Math.random() * 100 < chance);
    def('stringStartsWith', (s: string, t: string) => String(s).startsWith(t));
    def('stringEndsWith', (s: string, t: string) => String(s).endsWith(t));
    def('stringSplit', (s: string, d: string) => String(s).split(d));
    def('stringTrim', (s: string) => String(s).trim());
    def('getColorFromHex', (h: string) => parseColor(h));
    def('getColorFromName', (n: string) => parseColor(n));
    def('getColorFromString', (n: string) => parseColor(n));
    def('checkFileExists', (f: string, _abs?: boolean) => e.assets.exists(f));
    def('getTextFromFile', async (f: string) => e.assets.text(f) as any);
    def('directoryFileList', (d: string) => e.assets.listAll(d).map(x => x.name));
    def('isRunning', (f: string) => host.scripts.some(s => !s.closed && s.path.toLowerCase().endsWith(String(f).toLowerCase())));
    def('getRunningScripts', () => host.scripts.filter(s => !s.closed).map(s => s.path));
    def('setVar', (k: string, v: any) => { host.vars.set(k, v); return v; });
    def('getVar', (k: string) => host.vars.has(k) ? host.vars.get(k) : null);
    def('addLuaScript', (f: string) => { void host.addScript(f); });
    def('removeLuaScript', (f: string) => { for (const s of host.scripts) if (s.path.toLowerCase().includes(String(f).toLowerCase())) s.close(); });
    def('getTranslationPhrase', (k: string, d?: string) => d ?? k);
    def('setScoreText', (t = '') => { ps.scoreTxt.text = String(t); return true; });
    def('callOnScripts', (fn: string, args: any[] = []) => host.call(fn, Array.isArray(args) ? args : Object.values(args as any)));
    def('loadMultipleFrames', () => undefined);
    // ---- cámara (Psych 1.0)
    const gc = () => ps.cams.game;
    def('setCameraScroll', (x: number, y: number) => { gc().scroll.x = x; gc().scroll.y = y; });
    def('addCameraScroll', (x = 0, y = 0) => { gc().scroll.x += x; gc().scroll.y += y; });
    def('getCameraScrollX', () => gc().scroll.x); def('getCameraScrollY', () => gc().scroll.y);
    def('setCameraFollowPoint', (x: number, y: number) => { ps.camFollow.x = x; ps.camFollow.y = y; ps.isCameraOnForcedPos = true; });
    def('addCameraFollowPoint', (x = 0, y = 0) => { ps.camFollow.x += x; ps.camFollow.y += y; ps.isCameraOnForcedPos = true; });
    def('getCameraFollowX', () => ps.camFollow.x); def('getCameraFollowY', () => ps.camFollow.y);
    def('setSongPosition', (t: number) => { ps.cond.songPosition = t; if (ps.inst) { try { ps.inst.stop(); } catch { /* */ } } });
    def('luaDebugMode', () => false);
    def('getFileTranslation', (k: string, d?: string) => d ?? k);
    // ---- llamadas entre scripts (Lua/HScript)
    def('callOnScripts', (fn: string, args: any[] = []) => host.call(fn, Array.isArray(args) ? args : Object.values(args ?? {})));
    def('callOnHScript', (fn: string, args: any[] = []) => { const a = Array.isArray(args) ? args : Object.values(args ?? {}); let r: any; for (const h of host.hxScripts) if (!h.closed) { const v = h.call(fn, a); if (v !== undefined) r = v; } return toLua(r); });
    def('setOnHScript', (k: string, v: any) => { for (const h of [...host.hxScripts, ...host.scripts.map(x => x.hx).filter(Boolean) as any[]]) if (!h.closed) h.rt.interp.globals.def(String(k), v); });
    def('getOnHScript', (k: string, f?: string) => { for (const h of [...host.hxScripts, ...host.scripts.map(x => x.hx).filter(Boolean) as any[]]) { if (f && !h.path.toLowerCase().includes(String(f).toLowerCase())) continue; const v = h.rt.interp.globals.get(String(k)); if (v !== undefined) return toLua(v); } return undefined; });
    def('setOnScripts', (k: string, v: any) => { for (const sc of host.scripts) if (!sc.closed) sc.lua.global.set(k, v); for (const h of host.hxScripts) if (!h.closed) h.rt.interp.globals.def(String(k), v); });
    def('getOnScripts', (k: string, f?: string) => { for (const sc of host.scripts) { if (sc.closed || (f && !sc.path.toLowerCase().includes(String(f).toLowerCase()))) continue; try { const v = sc.lua.global.get(k); if (v !== undefined && v !== null) return v; } catch { /* */ } } return undefined; });
    def('callOnLuas', (fn: string, args: any[] = []) => { host.call(fn, Array.isArray(args) ? args : Object.values(args ?? {})); });
    def('setOnLuas', (k: string, v: any) => { for (const s of host.scripts) if (!s.closed) s.lua.global.set(k, v); });
    const hxOf = () => { if (!script.hx) script.hx = new HxScript(host, script.path, script.name, script.modFolder); return script.hx; };
    const toLua = (r: any): any => {
      if (r && typeof r === 'object' && (Array.isArray(r) || Object.getPrototypeOf(r) === Object.prototype)) {
        const lit = (v: any): string => Array.isArray(v) ? '{' + v.map(lit).join(',') + '}'
          : v && typeof v === 'object' ? '{' + Object.entries(v).filter(([, x]) => x !== null && x !== undefined && typeof x !== 'function').map(([k, x]) => `[${JSON.stringify(k)}]=${lit(x)}`).join(',') + '}'
          : typeof v === 'string' ? JSON.stringify(v) : typeof v === 'number' ? (isFinite(v) ? String(v) : '0') : typeof v === 'boolean' ? String(v) : 'nil';
        try { script.lua.doStringSync('__LT = ' + lit(r)); return '__LUATABLE__'; } catch { return undefined; }
      }
      return r;
    };
    def('runHaxeCode', (code: string, vars?: any) => {
      const h = hxOf();
      try { const r = h.exec(String(code), vars); return r === null ? undefined : toLua(r); }
      catch (err) { host.error(script, 'runHaxeCode', err); return null; }
    });
    def('runHaxeFunction', (fn: string, args?: any) => { const h = hxOf(); const a = Array.isArray(args) ? args : args && typeof args === 'object' ? Object.values(args) : []; try { const r = h.rt.interp.call(String(fn), a); return r === null ? undefined : toLua(r); } catch (err) { host.error(script, 'runHaxeFunction', err); return null; } });
    def('addHaxeLibrary', () => null);
    def('addHScript', () => false); def('removeHScript', () => false);
    def('callScript', (f: string, fn: string, args: any[] = []) => {
      const s = host.scripts.find(x => x.path.toLowerCase().endsWith(String(f).toLowerCase() + '.lua') || x.path.toLowerCase().endsWith(String(f).toLowerCase()));
      return s ? s.call(fn, Array.isArray(args) ? args : Object.values(args ?? {})) : null;
    });
    def('getGlobalFromScript', (f: string, v: string) => { const s = host.scripts.find(x => x.path.toLowerCase().includes(String(f).toLowerCase())); try { return s?.lua.global.get(v) ?? null; } catch { return null; } });
    def('setGlobalFromScript', (f: string, v: string, val: any) => { const s = host.scripts.find(x => x.path.toLowerCase().includes(String(f).toLowerCase())); s?.lua.global.set(v, val); });

    // ---------------------------------------------------------- datos guardados
    const saves = new Map<string, Record<string, any>>();
    def('initSaveData', (name: string) => { if (!saves.has(name)) saves.set(name, modSave.load(name)); });
    def('getDataFromSave', (name: string, field: string, dflt: any = null) => { const d = saves.get(name) ?? modSave.load(name); return d[field] ?? dflt; });
    def('setDataFromSave', (name: string, field: string, v: any) => { const d = saves.get(name) ?? modSave.load(name); d[field] = v; saves.set(name, d); });
    def('flushSaveData', (name: string) => { const d = saves.get(name); if (d) modSave.store(name, d); });
    def('eraseSaveData', (name: string) => { saves.set(name, {}); modSave.store(name, {}); });
    def('getModSetting', (_k: string, _m?: string) => null);

    // ---------------------------------------------------------- propiedades
    def('setProperty', (p: string, v: any) => host.setProp(p, v));
    def('getProperty', (p: string) => host.getProp(p));
    def('setPropertyFromClass', (cls: string, p: string, v: any) => {
      const root = host.classRoot(cls); if (!root) return false;
      const toks = String(p).split(/[.\[\]]+/).filter(Boolean); let o = root;
      for (let i = 0; i < toks.length - 1; i++) o = o?.[toks[i]]; if (o == null) return false;
      o[toks[toks.length - 1]] = v; return true;
    });
    def('getPropertyFromClass', (cls: string, p: string) => {
      const root = host.classRoot(cls); if (!root) return null;
      let o = root; for (const t of String(p).split(/[.\[\]]+/).filter(Boolean)) { o = o?.[t]; if (o == null) return null; }
      return typeof o === 'object' ? null : o;
    });
    const groupOf = (name: string): any[] | null => {
      const r = host.rootObj(name); return Array.isArray(r) ? r : null;
    };
    def('setPropertyFromGroup', (grp: string, idx: number, v: string, val: any) => {
      const arr = groupOf(grp); const m = arr?.[idx]; if (!m) return false;
      if (v == null || v === '') return false;
      const toks = String(v).split('.'); let o = m; for (let i = 0; i < toks.length - 1; i++) o = o?.[toks[i]];
      if (o == null) return false;
      if (toks[toks.length - 1] === 'color' && (o instanceof Sprite)) val = parseColor(val) & 0xffffff;
      o[toks[toks.length - 1]] = val; return true;
    });
    def('getPropertyFromGroup', (grp: string, idx: number, v: string) => {
      const arr = groupOf(grp); let o = arr?.[idx]; if (!o) return null;
      for (const t of String(v).split('.')) { o = o?.[t]; if (o == null) return null; }
      return typeof o === 'object' ? null : o;
    });
    def('setPropertyLuaSprite', (tag: string, v: string, val: any) => host.setProp(tag + '.' + v, val));
    def('getPropertyLuaSprite', (tag: string, v: string) => host.getProp(tag + '.' + v));
    def('removeFromGroup', () => false);

    // ---------------------------------------------------------- sprites
    def('makeLuaSprite', (tag: string, image: string | null, x = 0, y = 0) => { host.makeSprite(tag, image, x, y, false); });
    def('makeAnimatedLuaSprite', (tag: string, image: string | null, x = 0, y = 0) => { host.makeSprite(tag, image, x, y, true); });
    def('addLuaSprite', (tag: string, front = false) => {
      const s = ps.luaSprites.get(tag); if (!s) return;
      ps.removeDrawable(s); (front ? ps.layerFront : ps.layerBack).push(s);
    });
    def('removeLuaSprite', (tag: string) => { const s = ps.luaSprites.get(tag); if (s) { ps.removeDrawable(s); ps.luaSprites.delete(tag); } });
    def('luaSpriteExists', (tag: string) => ps.luaSprites.has(tag));
    def('luaTextExists', (tag: string) => ps.luaTexts.has(tag));
    def('luaSoundExists', (tag: string) => host.sounds.has(tag));
    def('makeGraphic', (tag: string, w = 256, h = 256, color = 'FFFFFF') => {
      const s = host.spriteOrNull(tag); if (s instanceof Sprite) s.makeGraphic(w, h, parseColor(color));
    });
    def('luaSpriteMakeGraphic', (tag: string, w: number, h: number, color: string) => {
      const s = host.spriteOrNull(tag); if (s instanceof Sprite) s.makeGraphic(w, h, parseColor(color));
    });
    def('loadGraphic', (tag: string, image: string, w = 0, h = 0) => {
      const s = host.spriteOrNull(tag); if (!(s instanceof Sprite)) return;
      const at = e.assets.peekImage(image);
      const set = (a: any) => { if (!a) return; s.setAtlas(a); };
      if (at) set(at); else { (s as any)._ops = (s as any)._ops ?? []; host.pendingLoads.push(e.assets.image(image).then(a => { set(a); const ops = (s as any)._ops; (s as any)._ops = null; ops?.forEach((f: any) => f()); })); }
      void w; void h;
    });
    def('loadFrames', (tag: string, image: string) => {
      const s = host.spriteOrNull(tag); if (!(s instanceof Sprite)) return;
      const at = e.assets.peekAtlas(image);
      if (at) s.setAtlas(at);
      else { (s as any)._ops = (s as any)._ops ?? []; host.pendingLoads.push(e.assets.atlas(image).then(a => { if (a) s.setAtlas(a); const ops = (s as any)._ops; (s as any)._ops = null; ops?.forEach((f: any) => f()); })); }
    });
    const animTarget = (tag: string) => host.spriteOrNull(tag);
    const addAnim = (tag: string, name: string, prefix: string, fps = 24, loop = true) => {
      const s = animTarget(tag); if (!(s instanceof Sprite)) return false;
      host.whenLoaded(s, () => { s.addByPrefix(name, prefix, fps, loop); if (!s.cur) s.play(name, true); });
      return true;
    };
    def('addAnimationByPrefix', (t: string, n: string, p: string, fps = 24, loop = true) => addAnim(t, n, p, fps, loop));
    def('luaSpriteAddAnimationByPrefix', (t: string, n: string, p: string, fps = 24, loop = true) => addAnim(t, n, p, fps, loop));
    const addIdx = (t: string, n: string, p: string, ind: any, fps = 24, loop = false) => {
      const s = animTarget(t); if (!(s instanceof Sprite)) return false;
      const arr = String(ind).split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x));
      host.whenLoaded(s, () => { s.addByIndices(n, p, arr, '', fps, loop); if (!s.cur) s.play(n, true); });
      return true;
    };
    def('addAnimationByIndices', (t: string, n: string, p: string, ind: any, fps = 24) => addIdx(t, n, p, ind, fps, false));
    def('addAnimationByIndicesLoop', (t: string, n: string, p: string, ind: any, fps = 24) => addIdx(t, n, p, ind, fps, true));
    def('luaSpriteAddAnimationByIndices', (t: string, n: string, p: string, ind: any, fps = 24) => addIdx(t, n, p, ind, fps, false));
    def('addAnimation', (t: string, n: string, frames: any, fps = 24, loop = true) => {
      const s = animTarget(t); if (!(s instanceof Sprite)) return false;
      const arr = Array.isArray(frames) ? frames : Object.values(frames ?? {});
      host.whenLoaded(s, () => s.addByFrames(n, arr.map(Number), fps, loop)); return true;
    });
    def('addOffset', (t: string, anim: string, x: number, y: number) => {
      const o = host.objectAt(t);
      if (o instanceof Character) { o.animOffsets.set(anim, [x, y]); return true; }
      return false;
    });
    const play = (t: string, anim: string, force = false, rev = false, frame = 0) => {
      const o = host.objectAt(t);
      if (o instanceof Character) { o.playAnim(anim, force, rev, frame); return true; }
      if (o instanceof AnimateSprite) { o.play(anim, force); return true; }
      if (o instanceof Sprite) { host.whenLoaded(o, () => o.play(anim, force, rev, frame)); return true; }
      return false;
    };
    def('playAnim', play); def('objectPlayAnimation', play); def('luaSpritePlayAnimation', play);
    def('setGraphicSize', (t: string, w = 0, h = 0, updateHB = true) => {
      const o = host.objectAt(t); if (!(o instanceof Sprite)) return;
      host.whenLoaded(o, () => { o.setGraphicSize(w, h); if (updateHB) o.updateHitbox(); });
    });
    def('scaleObject', (t: string, x = 1, y = 1, updateHB = true) => {
      const o = host.objectAt(t); if (!o) return;
      host.whenLoaded(o, () => { o.scale.x = x; o.scale.y = y; if (updateHB && o.updateHitbox) o.updateHitbox(); });
    });
    def('scaleLuaSprite', (t: string, x = 1, y = 1) => {
      const o = host.objectAt(t); if (!o) return;
      host.whenLoaded(o, () => { o.scale.x = x; o.scale.y = y; });
    });
    def('updateHitbox', (t: string) => { const o = host.objectAt(t); if (o?.updateHitbox) host.whenLoaded(o, () => o.updateHitbox()); });
    def('updateHitboxFromGroup', (g: string, i: number) => { groupOf(g)?.[i]?.updateHitbox?.(); });
    def('screenCenter', (t: string, axis = 'xy') => { const o = host.objectAt(t); if (o?.screenCenter) host.whenLoaded(o, () => o.screenCenter(String(axis).toLowerCase())); });
    def('setScrollFactor', (t: string, x = 1, y = 1) => { const o = host.objectAt(t); if (o?.scrollFactor) { o.scrollFactor.x = x; o.scrollFactor.y = y; } });
    def('setLuaSpriteScrollFactor', (t: string, x = 1, y = 1) => { const o = host.objectAt(t); if (o?.scrollFactor) { o.scrollFactor.x = x; o.scrollFactor.y = y; } });
    def('setObjectCamera', (t: string, cam = 'game') => { const o = host.objectAt(t); if (o && 'camera' in o) { o.camera = host.camName(cam); return true; } return false; });
    def('setLuaSpriteCamera', (t: string, cam = 'game') => { const o = host.objectAt(t); if (o) o.camera = host.camName(cam); });
    def('setBlendMode', (t: string, b = '') => { const o = host.objectAt(t); if (o) { o.blend = String(b).toLowerCase(); return true; } return false; });
    def('getObjectOrder', (t: string) => { const o = host.objectAt(t); return o ? host.orderOf(o) : -1; });
    def('setObjectOrder', (t: string, order: number) => { const o = host.objectAt(t); if (o) host.reorder(o, order); });
    def('objectsOverlap', (a: string, b: string) => {
      const x = host.objectAt(a), y = host.objectAt(b); if (!x || !y) return false;
      return x.x < y.x + (y.width ?? 0) && x.x + (x.width ?? 0) > y.x && x.y < y.y + (y.height ?? 0) && x.y + (x.height ?? 0) > y.y;
    });
    def('getMidpointX', (t: string) => { const o = host.objectAt(t); return o ? o.x + (o.width ?? 0) / 2 : 0; });
    def('getMidpointY', (t: string) => { const o = host.objectAt(t); return o ? o.y + (o.height ?? 0) / 2 : 0; });
    def('getGraphicMidpointX', (t: string) => { const o = host.objectAt(t); return o ? o.x + (o.frameWidth ?? o.width ?? 0) / 2 : 0; });
    def('getGraphicMidpointY', (t: string) => { const o = host.objectAt(t); return o ? o.y + (o.frameHeight ?? o.height ?? 0) / 2 : 0; });
    def('getScreenPositionX', (t: string, cam = 'game') => { const o = host.objectAt(t); const c = ps.cams[host.camName(cam)]; return o ? o.x - c.scroll.x * (o.scrollFactor?.x ?? 1) : 0; });
    def('getScreenPositionY', (t: string, cam = 'game') => { const o = host.objectAt(t); const c = ps.cams[host.camName(cam)]; return o ? o.y - c.scroll.y * (o.scrollFactor?.y ?? 1) : 0; });
    def('getPixelColor', () => 0);

    // ---------------------------------------------------------- texto
    def('makeLuaText', (tag: string, text = '', width = 0, x = 0, y = 0) => {
      const t = new TextObj(x, y, width, String(text), 16);
      t.camera = 'game'; t.scrollFactor.x = t.scrollFactor.y = 0; t.tag = tag; t.borderSize = 1; t.borderColor = 0;
      ps.luaTexts.set(tag, t);
    });
    def('addLuaText', (tag: string) => { const t = ps.luaTexts.get(tag); if (t) { ps.removeDrawable(t); ps.layerFront.push(t); } });
    def('removeLuaText', (tag: string) => { const t = ps.luaTexts.get(tag); if (t) { ps.removeDrawable(t); ps.luaTexts.delete(tag); } });
    const T = (tag: string) => ps.luaTexts.get(tag);
    def('setTextString', (t: string, s: any) => { const o = T(t); if (o) o.text = String(s); });
    def('setTextSize', (t: string, n: number) => { const o = T(t); if (o) o.size = n; });
    def('setTextColor', (t: string, c: string) => { const o = T(t); if (o) o.color = parseColor(c) & 0xffffff; });
    def('setTextBorder', (t: string, size: number, c = '000000') => { const o = T(t); if (o) { o.borderSize = size; o.borderColor = parseColor(c) & 0xffffff; } });
    def('setTextAlignment', (t: string, a = 'left') => { const o = T(t); if (o) o.align = (['left', 'center', 'right'].includes(String(a).toLowerCase()) ? String(a).toLowerCase() : 'left') as any; });
    def('setTextFont', (t: string, f: string) => {
      const o = T(t); if (!o) return;
      const fam = 'f_' + String(f).replace(/\W/g, '_'); host.pendingLoads.push(e.assets.font(fam, 'fonts/' + f).then(() => { o.font = fam; }));
    });
    def('setTextItalic', (t: string, b: boolean) => { const o = T(t); if (o) o.italic = !!b; });
    def('setTextWidth', (t: string, w: number) => { const o = T(t); if (o) o.fieldWidth = w; });
    def('setTextHeight', () => { /* alto automático */ });
    def('setTextAutoSize', () => { /* siempre automático */ });
    def('getTextString', (t: string) => T(t)?.text ?? null);
    def('getTextSize', (t: string) => T(t)?.size ?? 0);
    def('getTextFont', (t: string) => T(t)?.font ?? null);
    def('getTextWidth', (t: string) => T(t)?.width ?? 0);

    // ---------------------------------------------------------- tweens y timers
    const tweenTo = (tag: string, objPath: string, props: Record<string, number>, dur: number, ease: string, nested?: string) => {
      let o = host.objectAt(objPath); if (!o) return;
      if (nested) o = o[nested];
      ps.tweens.cancelTag('tw_' + tag);
      ps.tweens.tween(o, props, dur / rate(), { ease, tag: 'tw_' + tag, onComplete: () => { host.call('onTweenCompleted', [tag, objPath]); } });
    };
    def('doTweenX', (tag: string, o: string, v: number, d: number, ease = 'linear') => tweenTo(tag, o, { x: v }, d, ease));
    def('doTweenY', (tag: string, o: string, v: number, d: number, ease = 'linear') => tweenTo(tag, o, { y: v }, d, ease));
    def('doTweenAngle', (tag: string, o: string, v: number, d: number, ease = 'linear') => tweenTo(tag, o, { angle: v }, d, ease));
    def('doTweenAlpha', (tag: string, o: string, v: number, d: number, ease = 'linear') => tweenTo(tag, o, { alpha: v }, d, ease));
    def('doTweenZoom', (tag: string, o: string, v: number, d: number, ease = 'linear') => tweenTo(tag, o, { zoom: v }, d, ease));
    def('doTweenColor', (tag: string, o: string, target: string, d: number, ease = 'linear') => {
      const obj = host.objectAt(o); if (!obj) return;
      const from = (obj.color ?? 0xffffff) & 0xffffff, to = parseColor(target) & 0xffffff;
      const st = { t: 0 };
      ps.tweens.cancelTag('tw_' + tag);
      ps.tweens.tween(st, { t: 1 }, d / rate(), {
        ease, tag: 'tw_' + tag,
        onUpdate: () => {
          const mix = (s: number) => Math.round(((from >> s) & 255) + (((to >> s) & 255) - ((from >> s) & 255)) * st.t);
          obj.color = (mix(16) << 16) | (mix(8) << 8) | mix(0);
        },
        onComplete: () => host.call('onTweenCompleted', [tag, o]),
      });
    });
    def('startTween', (tag: string, o: string, values: any, d: number, opts: any = {}) => {
      const obj = host.objectAt(o); if (!obj || !values) return;
      const props: Record<string, number> = {};
      for (const [k, v] of Object.entries(values)) if (typeof v === 'number') props[k] = v;
      ps.tweens.cancelTag('tw_' + tag);
      ps.tweens.tween(obj, props, d / rate(), { ease: opts?.ease ?? 'linear', tag: 'tw_' + tag, onComplete: () => host.call('onTweenCompleted', [tag, o]) });
    });
    def('cancelTween', (tag: string) => ps.tweens.cancelTag('tw_' + tag));
    const strumAt = (i: number) => ps.strumLineNotes[i];
    const noteTw = (tag: string, i: number, props: Record<string, number>, d: number, ease: string) => {
      const s = strumAt(i); if (!s) return;
      ps.tweens.cancelTag('tw_' + tag);
      ps.tweens.tween(s, props, d / rate(), { ease, tag: 'tw_' + tag, onComplete: () => host.call('onTweenCompleted', [tag]) });
    };
    def('noteTweenX', (tag: string, i: number, v: number, d: number, ease = 'linear') => noteTw(tag, i, { x: v }, d, ease));
    def('noteTweenY', (tag: string, i: number, v: number, d: number, ease = 'linear') => noteTw(tag, i, { y: v }, d, ease));
    def('noteTweenAngle', (tag: string, i: number, v: number, d: number, ease = 'linear') => noteTw(tag, i, { angle: v }, d, ease));
    def('noteTweenAlpha', (tag: string, i: number, v: number, d: number, ease = 'linear') => noteTw(tag, i, { alpha: v }, d, ease));
    def('noteTweenDirection', (tag: string, i: number, v: number, d: number, ease = 'linear') => noteTw(tag, i, { direction: v }, d, ease));
    def('runTimer', (tag: string, time = 1, loops = 1) => {
      ps.tweens.cancelTimer('tm_' + tag);
      ps.tweens.timer(time / rate(), loops, t => { host.call('onTimerCompleted', [tag, t.elapsedLoops, t.loops > 0 ? t.loops - t.elapsedLoops : 0]); }, 'tm_' + tag);
    });
    def('cancelTimer', (tag: string) => ps.tweens.cancelTimer('tm_' + tag));

    // ---------------------------------------------------------- cámaras
    def('cameraSetTarget', (who: string) => {
      const w = String(who).toLowerCase();
      if (w === 'dad' || w === 'opponent') ps.moveCamera(true); else if (w === 'gf' || w === 'girlfriend') {
        if (ps.gf) { ps.camFollow.x = ps.gf.midX() + ps.gf.cameraPosition[0] + ps.girlfriendCameraOffset[0]; ps.camFollow.y = ps.gf.midY() + ps.gf.cameraPosition[1] + ps.girlfriendCameraOffset[1]; }
      } else ps.moveCamera(false);
    });
    def('cameraShake', (cam: string, intensity: number, dur: number) => ps.cams[host.camName(cam)].shake(intensity, dur));
    def('cameraFlash', (cam: string, color: string, dur: number) => ps.cams[host.camName(cam)].flash(parseColor(color) & 0xffffff, dur));
    def('cameraFade', (cam: string, color: string, dur: number) => ps.cams[host.camName(cam)].fade(parseColor(color) & 0xffffff, dur));

    // ---------------------------------------------------------- personajes
    const charOf = (t: string): Character | null => {
      switch (String(t).toLowerCase()) { case 'boyfriend': case 'bf': return ps.boyfriend; case 'dad': case 'opponent': return ps.dad; case 'gf': case 'girlfriend': return ps.gf; }
      return null;
    };
    def('characterPlayAnim', (c: string, anim: string, force = false) => { const ch = charOf(c); if (ch) { ch.playAnim(anim, force); ch.specialAnim = true; } });
    def('characterDance', (c: string) => { charOf(c)?.dance(); });
    def('getCharacterX', (t: string) => { const c = charOf(t); return c ? c.x - c.positionArray[0] : 0; });
    def('getCharacterY', (t: string) => { const c = charOf(t); return c ? c.y - c.positionArray[1] : 0; });
    def('setCharacterX', (t: string, v: number) => { const c = charOf(t); if (c) c.x = v + c.positionArray[0]; });
    def('setCharacterY', (t: string, v: number) => { const c = charOf(t); if (c) c.y = v + c.positionArray[1]; });
    def('addCharacterToList', (name: string, _type: string) => { host.pendingLoads.push(preloadCharacter(e.assets, name)); });
    def('triggerEvent', (name: string, v1 = '', v2 = '') => { ps.triggerEvent(String(name), String(v1), String(v2)); return true; });
    def('setHealthBarColors', (l: string, r: string) => { ps.healthBar.setColors(parseColor(l) & 0xffffff, parseColor(r) & 0xffffff); });
    def('setTimeBarColors', (l: string, r: string) => { ps.timeBar.setColors(parseColor(l) & 0xffffff, parseColor(r) & 0xffffff); });

    // ---------------------------------------------------------- estadísticas
    def('addScore', (v = 0) => { ps.songScore += v; ps.recalcRating(false); });
    def('addMisses', (v = 0) => { ps.songMisses += v; ps.recalcRating(true); });
    def('addHits', (v = 0) => { ps.songHits += v; ps.recalcRating(false); });
    def('setScore', (v = 0) => { ps.songScore = v; ps.recalcRating(false); });
    def('setMisses', (v = 0) => { ps.songMisses = v; ps.recalcRating(true); });
    def('setHits', (v = 0) => { ps.songHits = v; ps.recalcRating(false); });
    def('getScore', () => ps.songScore); def('getMisses', () => ps.songMisses); def('getHits', () => ps.songHits);
    def('setHealth', (v = 0) => { ps.health = v; }); def('getHealth', () => ps.health); def('addHealth', (v = 0) => { ps.health += v; });
    def('setRatingName', (v: string) => { ps.ratingName = v; ps.updateScoreText(); });
    def('setRatingFC', (v: string) => { ps.ratingFC = v; ps.updateScoreText(); });
    def('setRatingPercent', (v: number) => { ps.ratingPercent = v; ps.updateScoreText(); });

    // ---------------------------------------------------------- audio
    def('playSound', (name: string, vol = 1, tag?: string) => {
      host.pendingLoads.push(e.assets.sound(name).then(b => {
        if (!b) return;
        if (tag) {
          host.stopSound(tag);
          const t = e.audio.track(b); t.volume = vol; t.onEnded = () => { host.sounds.delete(tag); host.call('onSoundFinished', [tag]); }; t.play(0); host.sounds.set(tag, t);
        } else e.audio.playSound(b, vol);
      }));
    });
    def('stopSound', (tag: string) => host.stopSound(tag));
    def('pauseSound', (tag: string) => { host.sounds.get(tag)?.stop(); });
    def('resumeSound', (tag: string) => { host.sounds.get(tag)?.play(0); });
    def('soundFadeIn', (tag: string, d: number, from = 0, to = 1) => { host.sounds.get(tag)?.fade(to, d, from); });
    def('soundFadeOut', (tag: string, d: number, to = 0) => { host.sounds.get(tag)?.fade(to, d); });
    def('soundFadeCancel', () => { /* sin soporte fino */ });
    def('getSoundVolume', (tag: string) => host.sounds.get(tag)?.volume ?? ps.inst?.volume ?? 0);
    def('setSoundVolume', (tag: string, v: number) => { const t = host.sounds.get(tag); if (t) t.volume = v; else if (!tag && ps.inst) ps.inst.volume = v; });
    def('getSoundTime', (tag: string) => (host.sounds.get(tag)?.time ?? 0) * 1000);
    def('setSoundTime', () => { /* seek no soportado */ });
    def('getSoundPitch', (tag: string) => host.sounds.get(tag)?.pitch ?? 1);
    def('setSoundPitch', (tag: string, v: number) => { const t = host.sounds.get(tag); if (t) t.pitch = v; });
    def('playMusic', (name: string, vol = 1, loop = false) => {
      host.pendingLoads.push(e.assets.music(name).then(b => { if (!b) return; host.stopSound('__music'); const t = e.audio.track(b, loop); t.volume = vol; t.play(0); host.sounds.set('__music', t); }));
    });
    def('musicFadeIn', (d: number, from = 0, to = 1) => { host.sounds.get('__music')?.fade(to, d, from); });
    def('musicFadeOut', (d: number, to = 0) => { host.sounds.get('__music')?.fade(to, d); });
    def('precacheImage', (k: string) => { host.pendingLoads.push(e.assets.image(k)); });
    def('precacheSound', (k: string) => { host.pendingLoads.push(e.assets.sound(k)); });
    def('precacheMusic', (k: string) => { host.pendingLoads.push(e.assets.music(k)); });

    // ---------------------------------------------------------- canción
    def('getSongPosition', () => ps.cond.songPosition);
    def('startCountdown', () => { ps.startCountdown(); return true; });
    def('endSong', () => { ps.endSong(); return true; });
    def('restartSong', () => { ps.opts.onRestart?.(); return true; });
    def('exitSong', () => { ps.opts.onExit({ finished: false, score: ps.songScore }); return true; });
    def('startDialogue', (file: string, music?: string) => { void ps.startDialogue(String(file), music ? String(music) : undefined); return true; });
    def('startVideo', (file: string, canSkip = true) => {
      if (!resolveVideo(e, String(file))) { console.warn('[Lua] startVideo: no existe el video', file); e.toast('startVideo: video no encontrado: ' + file, '#ff9999', 4); return false; }
      return ps.startVideo(String(file), canSkip !== false);
    });
    // video como sprite (API de Psych 1.0)
    def('makeVideoSprite', (tag: string, file: string, x = 0, y = 0, cam = 'camGame', loop = false) => {
      const path = resolveVideo(e, String(file));
      if (!path) { e.toast('makeVideoSprite: video no encontrado: ' + file, '#ff9999', 4); return false; }
      const old = ps.luaSprites.get(tag); if (old) { ps.removeDrawable(old); if (old instanceof VideoSprite) old.destroy(); }
      const v = new VideoSprite(e, path, !!loop);
      v.x = x; v.y = y; v.camera = host.camName(cam); v.scrollFactor.x = v.scrollFactor.y = 0;
      v.onEnd = () => { host.call('onVideoCompleted', [tag]); };
      ps.luaSprites.set(tag, v);
      return true;
    });
    def('pauseVideoSprite', (tag: string) => { const v = ps.luaSprites.get(tag); if (v instanceof VideoSprite) v.pause(); });
    def('resumeVideoSprite', (tag: string) => { const v = ps.luaSprites.get(tag); if (v instanceof VideoSprite) v.resume(); });
    def('setVideoVolume', (tag: string, vol: number) => { const v = ps.luaSprites.get(tag); if (v instanceof VideoSprite) v.setVolume(vol); });
    def('getVideoTime', (tag: string) => { const v = ps.luaSprites.get(tag); return v instanceof VideoSprite ? v.time : 0; });
    def('getVideoDuration', (tag: string) => { const v = ps.luaSprites.get(tag); return v instanceof VideoSprite ? v.duration : 0; });
    def('loadSong', () => false);

    // ---------------------------------------------------------- teclado y ratón
    const keyMap: Record<string, string> = { left: 'left', down: 'down', up: 'up', right: 'right', accept: 'accept', back: 'back', pause: 'pause', reset: 'reset' };
    const input = e.input;
    const act = (k: string) => keyMap[String(k).toLowerCase().replace(/^note_/, '').replace(/^ui_/, '')];
    def('keyJustPressed', (k: string) => { const a = act(k); return a ? input.justPressed(a) : false; });
    def('keyPressed', (k: string) => { const a = act(k); return a ? input.pressed(a) : false; });
    def('keyReleased', (k: string) => { const a = act(k); return a ? input.justReleased(a) : false; });
    const raw = (k: string) => { const s = String(k).toUpperCase(); if (s.length === 1 && /[A-Z]/.test(s)) return 'Key' + s; if (/^\d$/.test(s)) return 'Digit' + s; if (s === 'SPACE') return 'Space'; if (s === 'ENTER') return 'Enter'; if (s === 'ESCAPE') return 'Escape'; if (['LEFT', 'RIGHT', 'UP', 'DOWN'].includes(s)) return 'Arrow' + s[0] + s.slice(1).toLowerCase(); return s; };
    def('keyboardJustPressed', (k: string) => input.justPressedRaw(raw(k)));
    def('keyboardPressed', (k: string) => input.rawDown(raw(k)));
    def('keyboardReleased', () => false);
    const btn = (b: any) => { const k = String(b ?? 'left').toLowerCase(); return k === 'right' ? 2 : k === 'middle' ? 1 : 0; };
    def('mouseClicked', (b?: string) => input.mouseJustPressed(btn(b)));
    def('mousePressed', (b?: string) => input.mousePressed(btn(b)));
    def('mouseReleased', (b?: string) => input.mouseJustReleased(btn(b)));
    for (const n of ['anyGamepadJustPressed', 'anyGamepadPressed', 'anyGamepadReleased', 'gamepadJustPressed', 'gamepadPressed', 'gamepadReleased']) def(n, () => false);
    def('getMouseX', (cam?: string) => { const c = cam ? ps.cams[host.camName(cam)] : null; return input.mouseX + (c ? 0 : 0); });
    def('getMouseY', (cam?: string) => { const c = cam ? ps.cams[host.camName(cam)] : null; return input.mouseY + (c ? 0 : 0); });
    def('setMouseVisible', (v: boolean) => input.setMouseVisible(!!v));
    def('gamepadAnalogX', () => 0); def('gamepadAnalogY', () => 0);

    // ---------------------------------------------------------- shaders (emulados en Canvas2D: adjustColor; el resto guarda parámetros)
    const shaderTag = (o: any) => String(o);
    const shObj = (o: any) => host.objectAt(String(o));
    const refresh = (obj: any) => {
      const sh = host.objShaders.get(obj); if (!sh) return;
      const fx = makeFx(sh.name, sh.params);
      if (obj && 'fx' in obj) obj.fx = fx;
    };
    def('initLuaShader', (name: string) => { host.shaderFiles.add(String(name)); return true; });
    def('setSpriteShader', (o: string, name: string) => {
      const obj = shObj(o); if (!obj) return false;
      if (!SUPPORTED_SHADERS.has(String(name))) { host.unsupportedOnce(script, 'shader ' + name + ' (solo se emula adjustColor)'); return false; }
      const sh = { name: String(name), params: {} as Record<string, any> };
      host.objShaders.set(obj, sh); refresh(obj); return true;
    });
    def('removeSpriteShader', (o: string) => { const obj = shObj(o); if (obj) { host.objShaders.delete(obj); if ('fx' in obj) obj.fx = null; } return true; });
    def('setShaderSampler2D', () => true);
    for (const [kind, fix] of [['Float', Number], ['Int', (v: any) => Math.trunc(Number(v))], ['Bool', Boolean]] as [string, (v: any) => any][]) {
      const put = (sh: string, prop: string, v: any) => {
        host.shaderParams.set(shaderTag(sh) + '.' + prop, v);
        const obj = shObj(sh); const s = obj && host.objShaders.get(obj);
        if (s) { s.params[prop] = v; refresh(obj); }
      };
      def('setShader' + kind, (sh: string, prop: string, v: any) => { put(sh, prop, fix(v)); return true; });
      def('getShader' + kind, (sh: string, prop: string) => host.shaderParams.get(shaderTag(sh) + '.' + prop) ?? undefined);
      def('setShader' + kind + 'Array', (sh: string, prop: string, v: any) => { put(sh, prop, Array.isArray(v) ? v.map(fix) : Object.values(v ?? {}).map(fix)); return true; });
      def('getShader' + kind + 'Array', (sh: string, prop: string) => host.shaderParams.get(shaderTag(sh) + '.' + prop) ?? undefined);
    }

    def('makeFlxAnimateSprite', (tag: string, x = 0, y = 0) => {
      const old = ps.luaSprites.get(tag); if (old) ps.removeDrawable(old);
      const sp = new AnimateSprite(); sp.x = x; sp.y = y; ps.luaSprites.set(tag, sp); return true;
    });
    def('loadAnimateAtlas', (tag: string, folder: string) => {
      const sp = ps.luaSprites.get(tag); if (!(sp instanceof AnimateSprite)) return false;
      const f = String(folder);
      const set = (at: AnimateAtlas | null | undefined) => { if (at) sp.atlas = at; };
      if (host.animCache.has(f)) set(host.animCache.get(f));
      else host.pendingLoads.push(AnimateAtlas.load(ps.e.assets, f).then(at => { host.animCache.set(f, at); set(at); }));
      return true;
    });
    def('addAnimationBySymbol', (tag: string, name: string, symbol: string, fps = 24, loop = false) => {
      const sp = ps.luaSprites.get(tag); if (!(sp instanceof AnimateSprite)) return false; sp.addBySymbol(name, symbol, fps, loop); return true;
    });
    def('addAnimationBySymbolIndices', (tag: string, name: string, symbol: string, indices: any, fps = 24, loop = false) => {
      const sp = ps.luaSprites.get(tag); if (!(sp instanceof AnimateSprite)) return false;
      const arr = Array.isArray(indices) ? indices : String(indices).split(',').map(Number);
      sp.addBySymbolIndices(name, symbol, arr.map(Number), fps, loop); return true;
    });

    // ---------------------------------------------------------- substates personalizados (GUI en Lua)
    def('openCustomSubstate', (name: string, pause = false) => ps.openSub(String(name), !!pause));
    def('closeCustomSubstate', () => ps.closeSub());
    def('insertToCustomSubstate', (tag: string, pos = -1) => {
      const o = ps.luaSprites.get(tag) ?? ps.luaTexts.get(tag); if (!o) return false;
      return ps.insertToSub(o, pos);
    });

    // ---------------------------------------------------------- colores, globales y archivos
    def('FlxColor', (c: any) => parseColor(c) | 0);
    def('getGlobals', () => ({}));
    const fileKey = (f: string) => 'india.file.' + e.assets.currentMod + '|' + String(f).replace(/\\/g, '/');
    def('saveFile', (path: string, content: string, _abs = false) => {
      try { localStorage.setItem(fileKey(path), String(content ?? '')); } catch { /* sin almacenamiento */ }
      const data = new TextEncoder().encode(String(content ?? '')).buffer as ArrayBuffer;
      e.vfs.add(e.assets.currentMod ? `mods/${e.assets.currentMod}/${path}` : `mods/${path}`, async () => data);
      return true;
    });
    def('deleteFile', (path: string, _abs = false) => { try { localStorage.removeItem(fileKey(path)); } catch { /* nada */ } return true; });

    // ---------------------------------------------------------- reflexión (callMethod / instancias)
    const unwrap = (a: any): any => {
      if (a && typeof a === 'object' && !Array.isArray(a) && a.__instance) return host.vars.get(a.__instance) ?? host.objectAt(a.__instance);
      return a;
    };
    const argList = (a: any): any[] => (Array.isArray(a) ? a : a && typeof a === 'object' ? Object.values(a) : a == null ? [] : [a]).map(unwrap);
    const callOn = (parent: any, key: string, args: any[], allowObj = false) => {
      const fn = parent?.[key];
      if (typeof fn !== 'function') { console.warn('[Lua] callMethod: no existe el método', key); return null; }
      const r = fn.apply(parent, args);
      return r === undefined ? null : (typeof r === 'object' && !allowObj ? null : r);
    };
    def('callMethod', (path: string, args?: any) => {
      const r = host.resolve(String(path)); if (!r) return null;
      return callOn(r.parent, String(r.key), argList(args));
    });
    def('callMethodFromClass', (cls: string, fn: string, args?: any) => {
      const root = host.classRoot(String(cls)); if (!root) { host.unsupportedOnce(script, 'clase ' + cls); return null; }
      const parts = String(fn).split('.'); let o = root;
      for (const p of parts.slice(0, -1)) o = o?.[p];
      const r = callOn(o, parts[parts.length - 1], argList(args), true);
      return toLua(r);
    });
    try { script.lua.doStringSync(`for _, n in ipairs({'callMethodFromClass', 'runHaxeFunction', 'runHaxeCode'}) do local f = _G[n]; _G[n] = function(...) local r = f(...); if r == '__LUATABLE__' then local t = __LT; __LT = nil; return t end; return r end end`); } catch { /* sin motor */ }
    def('instanceArg', (tag: string) => ({ __instance: String(tag) }));
    def('createInstance', (tag: string, cls: string, args?: any) => {
      const c = String(cls).split('.').pop(); const a = argList(args);
      let o: any = null;
      if (c === 'FlxSprite') o = new Sprite(Number(a[0] ?? 0), Number(a[1] ?? 0));
      else if (c === 'FlxText') o = new TextObj(Number(a[0] ?? 0), Number(a[1] ?? 0), Number(a[2] ?? 0), String(a[3] ?? ''), Number(a[4] ?? 8) * 2);
      else if (c === 'FlxTypeText') { o = new TypeText(Number(a[0] ?? 0), Number(a[1] ?? 0), Number(a[2] ?? 0), String(a[3] ?? ''), Number(a[4] ?? 8) * 2); ps.luaTexts.set(String(tag), o); }
      else if (c === 'Character') o = new Character(Number(a[0] ?? 0), Number(a[1] ?? 0), String(a[2] ?? 'bf'), !!a[3], e.assets);
      else if (c === 'FlxPieDial') { o = new Sprite(Number(a[0] ?? 0), Number(a[1] ?? 0)); o.replaceColor = () => undefined; o.amount = 0; }
      if (!o) { host.unsupportedOnce(script, 'createInstance(' + cls + ')'); return false; }
      o.camera = 'game'; host.vars.set(String(tag), o); return true;
    });
    def('addInstance', (tag: string, front = false) => {
      const o = host.vars.get(String(tag)); if (!o || typeof o.draw !== 'function') return false;
      ps.removeDrawable(o); (front ? ps.layerFront : ps.layerBack).push(o); return true;
    });

    // ---------------------------------------------------------- logros (guardados en el navegador)
    const achKey = 'india.achievements';
    const loadAch = (): Record<string, any> => { try { return JSON.parse(localStorage.getItem(achKey) ?? '{}'); } catch { return {}; } };
    const saveAch = (o: Record<string, any>) => { try { localStorage.setItem(achKey, JSON.stringify(o)); } catch { /* nada */ } };
    const BUILTIN_ACH = ['friday_night_play', 'week1_nomiss', 'week2_nomiss', 'week3_nomiss', 'week4_nomiss', 'week5_nomiss', 'week6_nomiss', 'week7_nomiss', 'ur_bad', 'ur_good', 'hype', 'two_keys', 'toastie', 'debugger'];
    def('achievementExists', (n: string) => BUILTIN_ACH.includes(String(n)) || e.assets.exists(`achievements/${n}.json`));
    def('isAchievementUnlocked', (n: string) => !!loadAch()[n]?.unlocked);
    def('unlockAchievement', (n: string) => {
      const all = loadAch(); if (all[n]?.unlocked) return false;
      all[n] = { ...(all[n] ?? {}), unlocked: true }; saveAch(all);
      e.toast('🏆 Logro desbloqueado: ' + n, '#ffd966', 5); return true;
    });
    def('getAchievementScore', (n: string) => loadAch()[n]?.score ?? 0);
    def('setAchievementScore', (n: string, v: number, _save = true) => { const all = loadAch(); all[n] = { ...(all[n] ?? {}), score: Number(v) }; saveAch(all); return Number(v); });
    def('addAchievementScore', (n: string, v = 1, _save = true) => { const all = loadAch(); const nv = (all[n]?.score ?? 0) + Number(v); all[n] = { ...(all[n] ?? {}), score: nv }; saveAch(all); return nv; });
    def('changeDiscordPresence', () => {}); def('changeDiscordClientID', () => {});
    void SING_ANIMS; void Note;
  }

  private warnedOnce = new Set<string>();
  unsupportedOnce(_s: LuaScript, what: string) {
    if (this.warnedOnce.has(what)) return;
    this.warnedOnce.add(what);
    console.warn('[Lua] No soportado todavía:', what);
    this.e.toast('Función no soportada aún: ' + what, '#ffcc66', 5);
  }

  async addScript(file: string) {
    const a = this.e.assets;
    const f = file.endsWith('.lua') ? file : file + '.lua';
    const p = a.resolve(f);
    if (!p) return;
    if (this.scripts.some(x => x.path === p)) return;
    const src = await a.vfs.text(p);
    await this.prefetch(src);
    const s = new LuaScript(this, p, p.split('/').pop()!, /^mods\/([^/]+)\//i.exec(p)?.[1] ?? '');
    this.scripts.push(s);
    await s.init(src);
    s.call('onCreate'); s.call('onCreatePost');
  }
}
