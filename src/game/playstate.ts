import { Engine, State, ENGINE_NAME } from '../engine/engine';
import { Atlas, Camera, Drawable, Sprite, TextObj, W, H, Frame } from '../engine/display';
import { Conductor } from '../engine/conductor';
import { TweenManager } from '../engine/tween';
import { Track } from '../engine/audio';
import { formatSongPath } from '../engine/assets';
import { saveScore } from '../engine/save';
import { SwagSong, loadChart, stageForSong } from './chart';
import { Character, preloadCharacter, clearCharCache } from './character';
import {
  Note, StrumNote, SWAG_WIDTH, COL_ARRAY, SING_ANIMS, DEFAULT_NOTE_SKIN, ARROW_RGB, ARROW_RGB_PIXEL,
  loadNoteAtlas, setupNoteAnims, setupStrumAnims,
} from './note';
import { Bar, HealthIcon, loadIconAtlas } from './hud';
import { StageFile, defaultStage, loadStageFile, buildNativeStage } from './stage';
import { ScriptHost } from '../lua/host';

export interface PlayOpts {
  song: string;            // nombre mostrado / carpeta
  diffName: string;        // "Hard"
  diffSuffix: string;      // "-hard"
  mod: string;             // carpeta de mod ('' = juego base)
  isStory?: boolean;
  onExit: (r: { finished: boolean; score: number }) => void;
  onRestart?: () => void;
}

export interface EventNote { strumTime: number; event: string; value1: string; value2: string }
interface Rating { name: string; window: number; mod: number; score: number; splash: boolean; hits: number }

const RATING_STUFF: [string, number][] = [
  ['You Suck!', 0.2], ['Shit', 0.4], ['Bad', 0.5], ['Bruh', 0.6], ['Meh', 0.69],
  ['Nice', 0.7], ['Good', 0.8], ['Great', 0.9], ['Sick!', 1], ['Perfect!!', 1],
];
export const FUNCTION_STOP = 'Function_Stop';
export const FUNCTION_CONTINUE = 'Function_Continue';

export class PlayState implements State {
  e: Engine;
  song!: SwagSong;
  cond = new Conductor();
  tweens = new TweenManager();
  cams = { game: new Camera('game'), hud: new Camera('hud'), other: new Camera('other') };
  camFollow = { x: 0, y: 0 };
  cameraSpeed = 1;
  defaultCamZoom = 0.9;
  camZooming = false;
  camZoomingMult = 1; camZoomingDecay = 1;
  isCameraOnForcedPos = false;

  // capas de dibujo (orden de pintado)
  layerBack: Drawable[] = [];
  layerChars: Drawable[] = [];
  layerFront: Drawable[] = [];
  layerHud: Drawable[] = [];
  layerOther: Drawable[] = [];
  luaSprites = new Map<string, Drawable>();
  luaTexts = new Map<string, TextObj>();

  stage!: StageFile;
  stageName = 'stage';
  isPixelStage = false;
  boyfriend!: Character; dad!: Character; gf: Character | null = null;
  boyfriendCameraOffset = [0, 0]; opponentCameraOffset = [0, 0]; girlfriendCameraOffset = [0, 0];
  BF_X = 770; BF_Y = 100; DAD_X = 100; DAD_Y = 100; GF_X = 400; GF_Y = 130;
  gfSpeed = 1;

  // notas
  noteAtlas: Atlas | null = null;
  unspawnNotes: Note[] = [];
  notes: Note[] = [];
  eventNotes: EventNote[] = [];
  strumLineNotes: StrumNote[] = [];
  playerStrums: StrumNote[] = [];
  opponentStrums: StrumNote[] = [];
  songSpeed = 1;
  noteKillOffset = 350;
  spawnTime = 2000;
  skin = DEFAULT_NOTE_SKIN;
  splashes: Sprite[] = [];
  splashAtlas: Atlas | null = null;
  comboSprites: Sprite[] = [];

  // HUD
  healthBar!: Bar; timeBar!: Bar;
  iconP1!: HealthIcon; iconP2!: HealthIcon;
  scoreTxt!: TextObj; timeTxt!: TextObj; botplayTxt!: TextObj;
  scoreScale = 1;
  songName: string;

  // estado de juego
  health = 1;
  combo = 0; songScore = 0; songHits = 0; songMisses = 0;
  totalPlayed = 0; totalNotesHit = 0;
  ratingPercent = 0; ratingName = '?'; ratingFC = '';
  ratings: Rating[] = [];
  curStep = 0; curBeat = 0; curSection = 0;
  sectionStartSteps: number[] = [];
  startingSong = true; startedCountdown = false; endingSong = false;
  songLength = 0;
  playbackRate = 1;
  cpuControlled = false;
  practiceMode = false;
  healthGain = 1; healthLoss = 1;
  paused = false;
  mode: 'load' | 'play' | 'pause' | 'dead' = 'load';
  generatedMusic = false;
  inCutscene = false;
  seenCutscene = false;

  // audio
  inst: Track | null = null;
  vocals: Track | null = null;
  opponentVocals: Track | null = null;
  audioAnchor = 0;           // ctx.currentTime en el que songPosition == 0
  pausedPos = 0;
  private countdownTick = -1;
  private lastStep = -9999;
  private lastBeat = -9999;
  private lastSection = -1;
  private hitsoundBuf: AudioBuffer | null = null;
  private missBufs: (AudioBuffer | null)[] = [];
  private introSounds: (AudioBuffer | null)[] = [];
  private pauseSel = 0;
  private deadTrack: Track | null = null;
  private deadChar: Character | null = null;
  private deadState: 'first' | 'loop' | 'confirm' = 'first';
  private deadCam = new Camera('dead');
  private deadT = 0;
  private fade = 0;
  private fadeTarget = 0;
  private endTimer = -1;
  private keyHeld = [false, false, false, false];
  private pendingChars = new Set<string>();

  scripts!: ScriptHost;
  iconBump = { p1: 1, p2: 1 };
  boyfriendGroupOrder = 0;

  constructor(e: Engine, public opts: PlayOpts) {
    this.e = e;
    this.songName = opts.song;
  }

  get stepCrochet() { return this.cond.stepCrochet; }
  get crochet() { return this.cond.crochet; }
  get songPosition() { return this.cond.songPosition; }
  get prefs() { return this.e.prefs; }

  // ====================================================================== carga
  async init() {
    const e = this.e, assets = e.assets;
    assets.currentMod = this.opts.mod;
    clearCharCache();
    const song = await loadChart(assets, this.opts.song, this.opts.diffSuffix);
    if (!song) throw new Error(`No se encontró el chart de "${this.opts.song}" (${this.opts.diffName})`);
    this.song = song;
    this.songName = formatSongPath(song.song || this.opts.song);
    this.cond.setBPM(song.bpm);
    this.cond.mapBPMChanges(song as any);
    this.songSpeed = this.prefs.scrollSpeed > 0 ? this.prefs.scrollSpeed : song.speed;
    this.cpuControlled = this.prefs.botplay;
    this.practiceMode = this.prefs.practice;
    this.healthGain = this.prefs.healthGain; this.healthLoss = this.prefs.healthLoss;

    // sección -> steps
    let acc = 0;
    this.sectionStartSteps = song.notes.map(s => { const a = acc; acc += Math.round((s.sectionBeats ?? 4) * 4); return a; });

    // stage
    this.stageName = stageForSong(song);
    this.stage = (await loadStageFile(assets, this.stageName)) ?? defaultStage();
    assets.currentLevel = this.stage.directory ? this.stage.directory.toLowerCase() : null;
    this.isPixelStage = !!this.stage.isPixelStage || this.stage.stageUI === 'pixel';
    this.defaultCamZoom = this.stage.defaultZoom ?? 0.9;
    this.cameraSpeed = this.stage.camera_speed ?? 1;
    [this.BF_X, this.BF_Y] = this.stage.boyfriend ?? [770, 100];
    [this.GF_X, this.GF_Y] = this.stage.girlfriend ?? [400, 130];
    [this.DAD_X, this.DAD_Y] = this.stage.opponent ?? [100, 100];
    this.boyfriendCameraOffset = this.stage.camera_boyfriend ?? [0, 0];
    this.opponentCameraOffset = this.stage.camera_opponent ?? [0, 0];
    this.girlfriendCameraOffset = this.stage.camera_girlfriend ?? [0, 0];

    // fuentes e imágenes de interfaz
    await assets.font('vcr', 'fonts/vcr.ttf');
    this.skin = song.arrowSkin && song.arrowSkin.length > 1 ? song.arrowSkin : DEFAULT_NOTE_SKIN;
    this.noteAtlas = await loadNoteAtlas(assets, this.skin);
    this.splashAtlas = await assets.atlas('noteSplashes/' + (song.splashSkin && song.splashSkin.length > 1 ? song.splashSkin : 'noteSplashes'))
      ?? await assets.atlas('noteSplashes/noteSplashes');

    // eventos y personajes (precarga)
    this.collectEvents();
    const names = new Set<string>([song.player1, song.player2, song.gfVersion || 'gf']);
    for (const ev of this.eventNotes) if (ev.event === 'Change Character' && ev.value2) names.add(ev.value2.trim());
    const dead = song.gameOverChar || 'bf-dead';
    names.add(dead);
    for (const n of names) if (n) await preloadCharacter(assets, n);

    // sonidos
    this.hitsoundBuf = await assets.sound('hitsound');
    this.missBufs = await Promise.all([1, 2, 3].map(i => assets.sound('missnote' + i)));
    const pix = this.isPixelStage ? '-pixel' : '';
    this.introSounds = await Promise.all(['intro3', 'intro2', 'intro1', 'introGo'].map(n => assets.sound(n + pix).then(b => b ?? assets.sound(n))));

    // audio de la canción
    const sf = this.songName;
    const instBuf = await assets.songFile(sf, 'Inst');
    if (!instBuf) throw new Error(`Falta la pista Inst de "${sf}" (songs/${sf}/Inst.ogg)`);
    this.inst = e.audio.track(instBuf);
    this.songLength = instBuf.duration * 1000;
    if (song.needsVoices) {
      const pv = await assets.songFile(sf, 'Voices-' + (this.boyfriendVocalName(song.player1))) ?? await assets.songFile(sf, 'Voices');
      if (pv) this.vocals = e.audio.track(pv);
      const ov = await assets.songFile(sf, 'Voices-' + (this.boyfriendVocalName(song.player2, 'Opponent')));
      if (ov) this.opponentVocals = e.audio.track(ov);
    }
    this.inst.pitch = this.playbackRate;
    for (const t of [this.vocals, this.opponentVocals]) if (t) t.pitch = this.playbackRate;

    // cámaras
    this.cams.game.zoom = this.cams.game.defaultZoom = this.defaultCamZoom;
    this.cams.hud.zoom = 1;

    // scripts (Lua): se crean antes de montar el stage para que onCreate pueda añadir sprites
    this.scripts = new ScriptHost(this);
    await this.scripts.loadAll();

    // stage nativo (solo si ningún script lo reemplaza)
    await buildNativeStage(this);
    this.scripts.call('onLoadStage');

    // personajes
    this.gf = null;
    const gfName = song.gfVersion || 'gf';
    if (!this.stage.hide_girlfriend && gfName) {
      this.gf = new Character(this.GF_X, this.GF_Y, gfName, false, assets);
      this.startCharPos(this.gf, true);
      this.gf.scrollFactor.x = this.gf.scrollFactor.y = 0.95;
      this.layerChars.push(this.gf);
    }
    this.dad = new Character(this.DAD_X, this.DAD_Y, song.player2, false, assets);
    this.startCharPos(this.dad);
    this.layerChars.push(this.dad);
    this.boyfriend = new Character(this.BF_X, this.BF_Y, song.player1, true, assets);
    this.startCharPos(this.boyfriend);
    this.layerChars.push(this.boyfriend);
    if (this.dad.curCharacter.startsWith("gf") && this.gf) { this.dad.x = this.gf.x; this.dad.y = this.gf.y; this.gf.visible = false; }

    // HUD
    await this.buildHud();
    this.generateStaticArrows(0); this.generateStaticArrows(1);
    this.generateSong();
    this.moveCameraSection(0);
    this.cams.game.scroll.x = this.camFollow.x - W / 2; this.cams.game.scroll.y = this.camFollow.y - H / 2;
    this.recalcRating(false);
    this.updateScoreText();
    this.scripts.call('onCreatePost');
    this.mode = 'play';
    this.startCountdown();
  }

  private boyfriendVocalName(char: string, fallback = 'Player') {
    const f = (this.pendingVocalFile(char));
    return f || fallback;
  }
  private pendingVocalFile(_char: string): string { return ''; }

  private startCharPos(c: Character, gf = false) {
    c.x += c.positionArray[0]; c.y += c.positionArray[1];
    if (gf) c.danceEveryNumBeats = c.danceEveryNumBeats; // sin cambios; reservado
  }

  private collectEvents() {
    this.eventNotes = [];
    for (const ev of this.song.events ?? []) {
      const time = ev[0] as number;
      for (const sub of ev[1] ?? []) {
        this.eventNotes.push({ strumTime: time, event: String(sub[0]), value1: String(sub[1] ?? ''), value2: String(sub[2] ?? '') });
      }
    }
    this.eventNotes.sort((a, b) => a.strumTime - b.strumTime);
  }

  // ====================================================================== HUD
  private async buildHud() {
    const e = this.e, assets = e.assets, down = this.prefs.downScroll;
    const sfx = this.isPixelStage ? '' : '';
    // barra de tiempo
    const tbAtlas = await assets.image('timeBar');
    const showTime = this.prefs.timeBarType !== 'Disabled';
    this.timeTxt = new TextObj(42 + W / 2 - 248, 19, 400, '', 32);
    this.timeTxt.align = 'center'; this.timeTxt.borderSize = 2; this.timeTxt.alpha = 0; this.timeTxt.visible = showTime;
    if (this.prefs.timeBarType === 'Song Name') this.timeTxt.text = this.song.song;
    if (down) this.timeTxt.y = H - 44;
    this.timeBar = new Bar(tbAtlas, 0, this.timeTxt.y + this.timeTxt.size / 4 * 1.15);
    this.timeBar.screenCenterX(); this.timeBar.value = 0; this.timeBar.min = 0; this.timeBar.max = 1;
    this.timeBar.leftToRight = true; this.timeBar.setColors(0xffffff, 0x000000);
    this.timeBar.alpha = 0; this.timeBar.visible = showTime;

    // la capa HUD: strums -> notas -> splashes -> UI
    // (los strums se añaden en generateStaticArrows)
    const hbAtlas = await assets.image('healthBar');
    this.healthBar = new Bar(hbAtlas, 0, H * (down ? 0.11 : 0.89));
    this.healthBar.screenCenterX();
    this.healthBar.leftToRight = false;
    this.healthBar.value = this.health;
    this.healthBar.alpha = this.prefs.healthBarAlpha;
    this.healthBar.visible = !this.prefs.hideHud;
    this.updateHealthColors();

    const i1 = await loadIconAtlas(assets, this.boyfriend?.healthIcon ?? this.charIcon(this.song.player1));
    const i2 = await loadIconAtlas(assets, this.dad?.healthIcon ?? this.charIcon(this.song.player2));
    this.iconP1 = new HealthIcon(assets, this.charIcon(this.song.player1), true, i1);
    this.iconP2 = new HealthIcon(assets, this.charIcon(this.song.player2), false, i2);
    this.iconP1.y = this.healthBar.y - 75; this.iconP2.y = this.healthBar.y - 75;
    this.iconP1.alpha = this.iconP2.alpha = this.prefs.healthBarAlpha;
    this.iconP1.visible = this.iconP2.visible = !this.prefs.hideHud;

    this.scoreTxt = new TextObj(0, this.healthBar.y + 40, W, '', 20);
    this.scoreTxt.align = 'center'; this.scoreTxt.borderSize = 1.25; this.scoreTxt.visible = !this.prefs.hideHud;

    this.botplayTxt = new TextObj(400, this.timeBar.y + 55, W - 800, 'BOTPLAY', 32);
    this.botplayTxt.align = 'center'; this.botplayTxt.borderSize = 1.25; this.botplayTxt.visible = this.cpuControlled;
    if (down) this.botplayTxt.y = this.timeBar.y - 78;
    void sfx;
  }

  private charIcon(name: string) {
    // el icono real se conoce una vez creado el personaje; antes usamos el JSON precargado
    return name;
  }

  updateHealthColors() {
    const d = this.dad?.healthColorArray ?? [255, 0, 0], b = this.boyfriend?.healthColorArray ?? [49, 176, 209];
    this.healthBar.setColors((d[0] << 16) | (d[1] << 8) | d[2], (b[0] << 16) | (b[1] << 8) | b[2]);
  }

  // ====================================================================== strums y notas
  private generateStaticArrows(player: number) {
    const mid = this.prefs.middleScroll, down = this.prefs.downScroll;
    const strumLineX = mid ? -278 : 42;
    const strumLineY = down ? H - 150 : 50;
    for (let i = 0; i < 4; i++) {
      let targetAlpha = 1;
      if (player < 1) {
        if (!this.prefs.opponentStrums) targetAlpha = 0; else if (mid) targetAlpha = 0.35;
      }
      const s = new StrumNote(strumLineX, strumLineY, i, player);
      s.rgb = (this.isPixelStage ? ARROW_RGB_PIXEL : ARROW_RGB)[i];
      s.useRGBShader = !this.song.disableNoteRGB;
      s.downScroll = down;
      s.camera = 'hud';
      s.scrollFactor.x = s.scrollFactor.y = 0;
      if (this.noteAtlas) setupStrumAnims(s, this.noteAtlas, this.skin);
      s.x += SWAG_WIDTH * i + 50 + (W / 2) * player;
      if (player === 0 && mid) { s.x += 310; if (i > 1) s.x += W / 2 + 25; }
      s.alpha = 0;
      this.tweens.tween(s, { alpha: targetAlpha }, 1, { ease: 'circOut', delay: 0.5 + 0.2 * i });
      (player === 1 ? this.playerStrums : this.opponentStrums).push(s);
      this.strumLineNotes.push(s);
      this.layerHud.push(s);
    }
  }

  private generateSong() {
    const song = this.song;
    this.unspawnNotes = [];
    let oldNote: Note | null = null;
    const off = this.prefs.noteOffset;
    song.notes.forEach(sec => {
      for (const sn of sec.sectionNotes) {
        const time = +sn[0], rawData = +sn[1];
        if (rawData < 0 || isNaN(time)) continue;
        const data = ((rawData % 4) + 4) % 4;
        let must = sec.mustHitSection;
        if (rawData > 3) must = !must;
        const n = new Note();
        n.noteData = data; n.strumTime = time + off; n.mustPress = must;
        n.sustainLength = Math.max(0, +sn[2] || 0);
        n.hasSustain = n.sustainLength > 0;
        n.gfNote = sec.gfSection && rawData < 4;
        n.noteType = typeof sn[3] === 'string' ? sn[3] : '';
        n.camera = 'hud';
        n.scrollFactor.x = n.scrollFactor.y = 0;
        n.useRGBShader = !song.disableNoteRGB;
        this.applyNoteType(n, sec.altAnim);
        if (this.noteAtlas) setupNoteAnims(n, this.noteAtlas, this.skin);
        this.applyNoteShader(n);
        if (oldNote) (n as any).prevNote = oldNote;
        oldNote = n;
        this.unspawnNotes.push(n);
      }
    });
    this.unspawnNotes.sort((a, b) => a.strumTime - b.strumTime || Number(a.lowPriority) - Number(b.lowPriority));
    // eventos con "early trigger" de scripts
    for (const ev of this.eventNotes) {
      const off2 = this.scripts.eventEarlyTrigger(ev);
      if (off2) ev.strumTime -= off2;
    }
    this.eventNotes.sort((a, b) => a.strumTime - b.strumTime);
    this.generatedMusic = true;
  }

  applyNoteType(n: Note, altAnim: boolean) {
    switch (n.noteType) {
      case 'Hurt Note':
        n.ignoreNote = n.mustPress; n.missHealth = 0.1; n.hitCausesMiss = true; n.useRGBShader = true;
        (n as any).hurtPalette = true; break;
      case 'Alt Animation': n.animSuffix = '-alt'; break;
      case 'No Animation': n.noAnimation = true; break;
      case 'GF Sing': n.gfNote = true; break;
    }
    if (altAnim && !n.animSuffix) n.animSuffix = '-alt';
  }

  applyNoteShader(n: Note) {
    if (!n.atlas) return;
    if (!n.useRGBShader) { n.srcOverride = null; return; }
    let c = (this.isPixelStage ? ARROW_RGB_PIXEL : ARROW_RGB)[n.noteData];
    if ((n as any).hurtPalette) c = [0x101010, 0xff0000, 0x990022];
    n.srcOverride = n.atlas.recolored(c[0], c[1], c[2]);
  }

  // ====================================================================== cuenta atrás y arranque
  startCountdown() {
    if (this.startedCountdown) return;
    const r = this.scripts.call('onStartCountdown');
    if (r === FUNCTION_STOP) return;
    this.startedCountdown = true;
    this.cond.songPosition = -this.crochet * 5;
    const now = this.e.audio.ctx.currentTime;
    this.audioAnchor = now + (this.crochet * 5) / 1000 / this.playbackRate;
    this.countdownTick = -1;
    this.scheduleAudio();
    this.scripts.call('onCountdownStarted');
    this.tweens.tween(this.timeBar, { alpha: 1 }, 0.5, { ease: 'circOut' });
    this.tweens.tween(this.timeTxt, { alpha: 1 }, 0.5, { ease: 'circOut' });
  }

  private scheduleAudio(fromMs = 0) {
    const when = this.audioAnchor, off = fromMs / 1000;
    this.inst?.start(when, off);
    this.vocals?.start(when, off);
    this.opponentVocals?.start(when, off);
  }

  private updateSongPosition() {
    this.cond.songPosition = (this.e.audio.ctx.currentTime - this.audioAnchor) * 1000 * this.playbackRate;
  }

  private async doCountdownTick(i: number) {
    const assets = this.e.assets;
    this.callBeatDances(i);
    this.scripts.call('onCountdownTick', [i]);
    if (i > 3) return;
    const snd = this.introSounds[i];
    this.e.audio.playSound(snd, 0.6);
    if (i === 0) return;
    const names = ['', 'ready', 'set', 'go'];
    const pre = this.isPixelStage ? 'pixelUI/' : '', suf = this.isPixelStage ? '-pixel' : '';
    const atlas = await assets.image(pre + names[i] + suf) ?? await assets.image(names[i]);
    if (!atlas) return;
    const s = new Sprite().loadGraphic(atlas.img);
    s.camera = 'hud'; s.scrollFactor.x = s.scrollFactor.y = 0;
    if (this.isPixelStage) { s.scale.x = s.scale.y = 6; s.updateHitbox(); s.antialiasing = false; }
    s.screenCenter();
    this.layerHud.push(s);
    this.tweens.tween(s, { y: s.y + 100, alpha: 0 }, this.crochet / 1000, {
      ease: 'cubeInOut', onComplete: () => { this.layerHud = this.layerHud.filter(o => o !== s); },
    });
  }

  private callBeatDances(counter: number) {
    const g = this.gf, b = this.boyfriend, d = this.dad;
    if (g && counter % Math.max(1, Math.round(this.gfSpeed * g.danceEveryNumBeats)) === 0 && !g.animName.startsWith('sing') && !g.stunned) g.dance();
    if (counter % b.danceEveryNumBeats === 0 && !b.animName.startsWith('sing') && !b.stunned) b.dance();
    if (counter % d.danceEveryNumBeats === 0 && !d.animName.startsWith('sing') && !d.stunned && !d.skipDance) d.dance();
  }

  // ====================================================================== bucle
  update(dt: number) {
    const inp = this.e.input;
    if (this.mode === 'load') return;
    if (this.mode === 'pause') { this.updatePause(); return; }
    if (this.mode === 'dead') { this.updateDead(dt); return; }

    this.scripts.call('onUpdate', [dt]);

    if (this.startedCountdown && !this.paused) {
      this.updateSongPosition();
      // ticks de cuenta atrás: -4c, -3c, -2c, -c, 0
      while (this.countdownTick < 4 && this.cond.songPosition >= -this.crochet * (4 - (this.countdownTick + 1))) {
        this.countdownTick++;
        void this.doCountdownTick(this.countdownTick);
        if (this.countdownTick === 4) break;
      }
      if (this.startingSong && this.cond.songPosition >= 0) { this.startingSong = false; this.camZooming = true; this.scripts.call('onSongStart'); }
      this.updateStepBeat();
    }

    // la animación de los personajes corre siempre
    const rate = this.playbackRate;
    this.gf?.update(dt * rate, this.stepCrochet, rate);
    this.dad.update(dt * rate, this.stepCrochet, rate);
    this.boyfriend.update(dt * rate, this.stepCrochet, rate);

    // eventos
    while (this.eventNotes.length && this.eventNotes[0].strumTime <= this.cond.songPosition) {
      const ev = this.eventNotes.shift()!;
      this.triggerEvent(ev.event, ev.value1, ev.value2, ev.strumTime);
    }

    if (this.generatedMusic && !this.endingSong) {
      this.processInput();
      this.updateNotes(dt);
    }

    this.updateCamera(dt);
    this.updateHud(dt);

    for (const o of [...this.layerBack, ...this.layerFront, ...this.layerHud, ...this.layerOther]) if (!(o instanceof Character)) o.update(dt);
    for (const c of Object.values(this.cams)) c.update(dt);
    this.tweens.update(dt);
    this.updateFx(dt);

    // fin de canción
    if (!this.startingSong && !this.endingSong && this.cond.songPosition >= this.songLength - 50 && this.songLength > 0) this.endSong();
    if (this.endTimer >= 0) { this.endTimer -= dt; if (this.endTimer < 0) this.finishExit(true); }

    // salud
    if (this.health > 2) this.health = 2;
    if (this.health <= 0 && !this.practiceMode && !this.endingSong && this.mode === 'play') {
      const r = this.scripts.call('onGameOver');
      if (r !== FUNCTION_STOP) { void this.startGameOver(); return; }
    }

    if ((inp.justPressed('pause') || inp.justPressedRaw('Escape')) && this.startedCountdown && !this.endingSong) this.pauseGame();
    if (inp.justPressed('reset') && !this.endingSong && this.startedCountdown) this.health = 0;
    this.scripts.call('onUpdatePost', [dt]);
  }

  private updateStepBeat() {
    const pos = this.cond.songPosition;
    const step = Math.floor(this.cond.getStep(pos));
    if (step === this.lastStep) return;
    // puede saltar varios steps si hubo un tirón
    const from = this.lastStep === -9999 ? step - 1 : this.lastStep;
    for (let s = from + 1; s <= step; s++) {
      this.curStep = s;
      if (s < 0) { this.lastStep = s; continue; }
      // sección
      let sec = 0;
      for (let i = 0; i < this.sectionStartSteps.length; i++) if (s >= this.sectionStartSteps[i]) sec = i;
      this.curSection = sec;
      if (sec !== this.lastSection) { this.lastSection = sec; this.sectionHit(); }
      this.scripts.call('onStepHit');
      if (s % 4 === 0) { this.curBeat = Math.floor(s / 4); this.beatHit(); }
      this.lastStep = s;
    }
    this.lastStep = step;
  }

  private sectionHit() {
    const sec = this.song.notes[this.curSection];
    if (!sec) return;
    if (sec.changeBPM && sec.bpm && sec.bpm !== this.cond.bpm) this.cond.setBPM(sec.bpm);
    if (!this.isCameraOnForcedPos) this.moveCameraSection(this.curSection);
    this.scripts.call('onSectionHit');
  }

  private beatHit() {
    const beat = this.curBeat;
    this.iconBump.p1 = this.iconBump.p2 = 1.2;
    this.iconP1.scale.x = this.iconP1.scale.y = 1.2; this.iconP2.scale.x = this.iconP2.scale.y = 1.2;
    if (this.camZooming && this.prefs.camZooms && this.cams.game.zoom < 1.35 && this.camZoomingMult > 0 && beat % (4 * 1) === 0) {
      this.cams.game.zoom += 0.015 * this.camZoomingMult;
      this.cams.hud.zoom += 0.03 * this.camZoomingMult;
    }
    this.callBeatDances(beat);
    this.scripts.call('onBeatHit');
  }

  // ====================================================================== cámara
  moveCameraSection(sec = this.curSection) {
    const s = this.song.notes[Math.max(0, sec)];
    if (!s) return;
    if (this.gf && s.gfSection) {
      this.camFollow.x = this.gf.midX() + this.gf.cameraPosition[0] + this.girlfriendCameraOffset[0];
      this.camFollow.y = this.gf.midY() + this.gf.cameraPosition[1] + this.girlfriendCameraOffset[1];
      this.scripts.call('onMoveCamera', ['gf']);
      return;
    }
    const isDad = s.mustHitSection !== true;
    this.moveCamera(isDad);
    this.scripts.call('onMoveCamera', [isDad ? 'dad' : 'boyfriend']);
  }

  moveCamera(isDad: boolean) {
    if (isDad) {
      this.camFollow.x = this.dad.midX() + 150 + this.dad.cameraPosition[0] + this.opponentCameraOffset[0];
      this.camFollow.y = this.dad.midY() - 100 + this.dad.cameraPosition[1] + this.opponentCameraOffset[1];
    } else {
      this.camFollow.x = this.boyfriend.midX() - 100 - (this.boyfriend.cameraPosition[0] - this.boyfriendCameraOffset[0]);
      this.camFollow.y = this.boyfriend.midY() - 100 + this.boyfriend.cameraPosition[1] + this.boyfriendCameraOffset[1];
    }
  }

  private updateCamera(dt: number) {
    const g = this.cams.game, h = this.cams.hud, rate = this.playbackRate;
    const k = 1 - Math.exp(-2.4 * this.cameraSpeed * rate * dt);
    g.scroll.x += (this.camFollow.x - W / 2 - g.scroll.x) * k;
    g.scroll.y += (this.camFollow.y - H / 2 - g.scroll.y) * k;
    if (this.camZooming) {
      const f = Math.exp(-dt * 3.125 * this.camZoomingDecay * rate);
      g.zoom = this.defaultCamZoom + (g.zoom - this.defaultCamZoom) * f;
      h.zoom = 1 + (h.zoom - 1) * f;
    }
  }

  // ====================================================================== eventos
  triggerEvent(name: string, v1: string, v2: string, strumTime = this.cond.songPosition) {
    const f1 = parseFloat(v1), f2 = parseFloat(v2);
    const char = (s: string): Character | null => {
      switch ((s ?? '').toLowerCase().trim()) {
        case 'gf': case 'girlfriend': case '2': return this.gf;
        case 'dad': case 'opponent': case '1': return this.dad;
        default: { const n = parseInt(s); return isNaN(n) || n === 0 ? this.boyfriend : (n === 1 ? this.dad : this.gf); }
      }
    };
    switch (name) {
      case 'Hey!': {
        const t = (v1 ?? '').toLowerCase().trim();
        const time = isNaN(f2) ? 0.6 : f2;
        let bf = true, g = true;
        if (t === 'bf' || t === 'boyfriend' || t === '0') g = false;
        if (t === 'gf' || t === 'girlfriend' || t === '1') bf = false;
        if (bf) { this.boyfriend.playAnim('hey', true); this.boyfriend.specialAnim = true; this.boyfriend.heyTimer = time; }
        if (g && this.gf) { this.gf.playAnim(this.gf.hasAnim('cheer') ? 'cheer' : 'hey', true); this.gf.specialAnim = true; this.gf.heyTimer = time; }
        break;
      }
      case 'Set GF Speed': this.gfSpeed = isNaN(f1) ? 1 : Math.max(1, f1); break;
      case 'Add Camera Zoom':
        if (this.prefs.camZooms && this.cams.game.zoom < 1.35) {
          this.cams.game.zoom += isNaN(f1) ? 0.015 : f1;
          this.cams.hud.zoom += isNaN(f2) ? 0.03 : f2;
        }
        break;
      case 'Camera Follow Pos':
        if (v1 === '' && v2 === '') { this.isCameraOnForcedPos = false; this.moveCameraSection(this.curSection); }
        else { this.isCameraOnForcedPos = true; this.camFollow.x = isNaN(f1) ? 0 : f1; this.camFollow.y = isNaN(f2) ? 0 : f2; }
        break;
      case 'Alt Idle Animation': {
        const c = char(v1); if (c) { c.idleSuffix = v2; c.recalculateDanceIdle(); }
        break;
      }
      case 'Screen Shake': {
        const parse = (s: string): [number, number] => {
          const p = (s ?? '').split(','); const d = parseFloat(p[0]), i = parseFloat(p[1]);
          return [isNaN(d) ? 0 : d, isNaN(i) ? 0 : i];
        };
        const [d1, i1] = parse(v1), [d2, i2] = parse(v2);
        if (d1 > 0 && i1 !== 0) this.cams.game.shake(i1, d1);
        if (d2 > 0 && i2 !== 0) this.cams.hud.shake(i2, d2);
        break;
      }
      case 'Play Animation': {
        const c = (v2 ?? '').toLowerCase().trim();
        const who = c === 'dad' || c === 'opponent' || c === '1' ? this.dad : (c === 'gf' || c === 'girlfriend' || c === '2') ? this.gf : this.boyfriend;
        if (who) { who.playAnim(v1, true); who.specialAnim = true; }
        break;
      }
      case 'Change Scroll Speed': {
        const mult = isNaN(f1) ? 1 : f1, dur = isNaN(f2) ? 0 : f2;
        const target = this.song.speed * (this.prefs.scrollSpeed > 0 ? 1 : 1) * mult;
        if (dur <= 0) this.songSpeed = target;
        else { const o = { v: this.songSpeed }; this.tweens.tween(o, { v: target }, dur / this.playbackRate, { ease: 'linear', onUpdate: () => { this.songSpeed = o.v; } }); }
        break;
      }
      case 'Change Character': {
        const t = (v1 ?? '').toLowerCase().trim();
        const which = t === 'gf' || t === 'girlfriend' || t === '2' ? 2 : (t === 'dad' || t === 'opponent' || t === '1') ? 1 : 0;
        this.changeCharacter(which, (v2 ?? '').trim());
        break;
      }
      case 'Set Property': this.scripts.setPropertyFromEvent(v1, v2); break;
      case 'Play Sound': {
        void this.e.assets.sound(v1).then(b => this.e.audio.playSound(b, isNaN(f2) ? 1 : f2));
        break;
      }
    }
    this.scripts.call('onEvent', [name, v1, v2, strumTime]);
    this.scripts.callEventScript(name, [name, v1, v2, strumTime]);
  }

  changeCharacter(which: 0 | 1 | 2, name: string) {
    const assets = this.e.assets;
    try {
      if (which === 0) {
        if (this.boyfriend.curCharacter === name) return;
        const old = this.boyfriend;
        const c = new Character(this.BF_X, this.BF_Y, name, true, assets); this.startCharPos(c);
        c.alpha = old.alpha; c.visible = old.visible;
        this.swapChar(old, c); this.boyfriend = c;
        this.iconP1.setIcon(c.healthIcon, null); void loadIconAtlas(assets, c.healthIcon).then(a => this.iconP1.setIcon(c.healthIcon, a));
      } else if (which === 1) {
        if (this.dad.curCharacter === name) return;
        const old = this.dad;
        const c = new Character(this.DAD_X, this.DAD_Y, name, false, assets); this.startCharPos(c);
        c.alpha = old.alpha; c.visible = old.visible;
        this.swapChar(old, c); this.dad = c;
        void loadIconAtlas(assets, c.healthIcon).then(a => this.iconP2.setIcon(c.healthIcon, a));
      } else if (this.gf) {
        if (this.gf.curCharacter === name) return;
        const old = this.gf;
        const c = new Character(this.GF_X, this.GF_Y, name, false, assets); this.startCharPos(c, true);
        c.alpha = old.alpha; c.visible = old.visible; c.scrollFactor.x = c.scrollFactor.y = 0.95;
        this.swapChar(old, c); this.gf = c;
      }
      this.updateHealthColors();
    } catch (err) {
      console.warn('Change Character falló (¿no precargado?)', name, err);
    }
  }
  private swapChar(old: Character, nw: Character) {
    const i = this.layerChars.indexOf(old);
    if (i >= 0) this.layerChars[i] = nw; else this.layerChars.push(nw);
  }

  // ====================================================================== notas: posición, fallos y sustains
  private strumCenterY(s: StrumNote) { return s.y + s.height / 2; }
  private distanceFor(n: Note, t: number) {
    return 0.45 * (t - this.cond.songPosition) * this.songSpeed * n.multSpeed / 1; // px hacia arriba/abajo
  }

  private updateNotes(dt: number) {
    const pos = this.cond.songPosition;
    const down = this.prefs.downScroll;
    this.noteKillOffset = Math.max(this.stepCrochet, 350 / this.songSpeed * this.playbackRate);
    let spawn = this.spawnTime;
    if (this.songSpeed < 1) spawn /= this.songSpeed;
    while (this.unspawnNotes.length && this.unspawnNotes[0].strumTime - pos < spawn) {
      const n = this.unspawnNotes.shift()!;
      n.spawned = true; n.visible = true;
      this.notes.push(n);
      this.scripts.call('onSpawnNote', [this.notes.length - 1, n.noteData, n.noteType, false, n.strumTime]);
    }
    const safe = this.cond.safeZoneOffset;
    for (let idx = this.notes.length - 1; idx >= 0; idx--) {
      const n = this.notes[idx];
      const strum = (n.mustPress ? this.playerStrums : this.opponentStrums)[n.noteData];
      // posición
      const cy = this.strumCenterY(strum);
      const dist = 0.45 * (n.strumTime - pos) * this.songSpeed * n.multSpeed;
      n.distance = dist;
      const signed = down ? -dist : dist;
      const cx = strum.x + strum.width / 2;
      if (n.copyX) n.x = cx - n.width / 2 + n.offsetX;
      n.y = cy + signed - n.height / 2 + n.offsetY;
      if (n.copyAngle) n.angle = strum.angle + n.offsetAngle;
      if (n.copyAlpha) n.alpha = strum.alpha * n.multAlpha;
      n.scale.x = n.scale.y = 0.7 * (strum.scale.x / 0.7);
      // geometría de la cola
      if (n.hasSustain && !n.susDone) {
        const startT = n.holding ? Math.max(pos, n.strumTime) : n.strumTime;
        const endT = n.strumTime + n.sustainLength;
        const yA = cy + (down ? -1 : 1) * 0.45 * (startT - pos) * this.songSpeed * n.multSpeed;
        const yB = cy + (down ? -1 : 1) * 0.45 * (endT - pos) * this.songSpeed * n.multSpeed;
        n.susTopY = yA; n.susBottomY = yB; n.susCenterX = cx; n.susDown = down;
      }

      // ventana de golpe
      if (n.mustPress) {
        n.canBeHit = n.strumTime > pos - safe * n.lateHitMult && n.strumTime < pos + safe * n.earlyHitMult;
        if (n.strumTime < pos - safe * n.lateHitMult && !n.wasGoodHit) n.tooLate = true;
      } else {
        n.canBeHit = false;
      }

      // oponente: golpea solo
      if (!n.mustPress && !n.hitByOpponent && !n.ignoreNote && n.strumTime <= pos) {
        this.opponentNoteHit(n);
      }
      // botplay
      if (n.mustPress && this.cpuControlled && !n.wasGoodHit && !n.ignoreNote && n.strumTime <= pos) {
        this.goodNoteHit(n, true);
      }

      // sostenidos
      if (n.hasSustain && n.holding && !n.susDone) this.updateSustain(n, strum, dt, idx);

      // mantener en lista mientras se sostiene
      const end = n.strumTime + (n.hasSustain ? n.sustainLength : 0);
      if (n.mustPress && !n.wasGoodHit && !n.ignoreNote && n.tooLate && n.strumTime < pos - this.noteKillOffset) {
        this.noteMiss(n);
        this.removeNote(n);
        continue;
      }
      if (n.ignoreNote && n.mustPress && n.strumTime < pos - this.noteKillOffset) { this.removeNote(n); continue; }
      if (!n.mustPress && n.hitByOpponent && (!n.hasSustain || n.susDone)) { this.removeNote(n); continue; }
      if (n.wasGoodHit && (!n.hasSustain || n.susDone)) { this.removeNote(n); continue; }
      if (n.missed && end < pos - this.noteKillOffset) { this.removeNote(n); continue; }
    }
  }

  removeNote(n: Note) {
    const i = this.notes.indexOf(n);
    if (i >= 0) this.notes.splice(i, 1);
  }

  private updateSustain(n: Note, strum: StrumNote, dt: number, idx: number) {
    const pos = this.cond.songPosition;
    const endT = n.strumTime + n.sustainLength;
    const remaining = endT - pos;
    if (n.mustPress) {
      const held = this.cpuControlled || this.keyHeld[n.noteData];
      const sc = n.gfNote ? this.gf : this.boyfriend;
      if (held) {
        strum.playStrumAnim('confirm'); strum.resetAnim = 0;
        if (!n.noAnimation && sc) { sc.holdTimer = 0; if (!sc.animName.startsWith(SING_ANIMS[n.noteData])) sc.playAnim(SING_ANIMS[n.noteData] + n.animSuffix, true); }
        n.susTick += dt * 1000;
        while (n.susTick >= this.stepCrochet) { n.susTick -= this.stepCrochet; this.health += n.hitHealth * this.healthGain; }
        this.vocals && (this.vocals.volume = 1);
        if (remaining <= 0) {
          n.susDone = true; n.wasGoodHit = true;
          if (!this.keyHeld[n.noteData] && !this.cpuControlled) strum.playStrumAnim('pressed'); else if (this.cpuControlled) strum.resetAnim = this.stepCrochet * 1.5 / 1000;
          this.scripts.call('onSustainEnd', [idx, n.noteData, n.noteType]);
        }
      } else {
        // soltó antes de tiempo
        n.susDone = true; n.holding = false;
        if (remaining > this.stepCrochet) {
          n.missed = true;
          this.sustainDropped(n);
        } else { n.wasGoodHit = true; }
        strum.playStrumAnim('static');
      }
    } else {
      // oponente
      strum.playStrumAnim('confirm'); strum.resetAnim = this.stepCrochet * 1.5 / 1000;
      const oc = n.gfNote ? this.gf : this.dad;
      if (oc && !n.noAnimation) { oc.holdTimer = 0; if (!oc.animName.startsWith(SING_ANIMS[n.noteData])) oc.playAnim(SING_ANIMS[n.noteData] + n.animSuffix, true); }
      if (this.opponentVocals) this.opponentVocals.volume = 1; else if (this.vocals) this.vocals.volume = 1;
      if (remaining <= 0) n.susDone = true;
    }
  }

  private sustainDropped(n: Note) {
    this.health -= n.missHealth * this.healthLoss * 0.5;
    this.combo = 0; this.songMisses++; this.totalPlayed++;
    if (!this.practiceMode) this.songScore -= 10;
    if (this.vocals) this.vocals.volume = 0;
    this.recalcRating(true);
  }

  // ====================================================================== entrada
  private processInput() {
    const inp = this.e.input;
    const nowPerf = performance.now();
    const dirOf = (code: string) => {
      const acts = inp.actionOf(code);
      for (const a of acts) { const i = ['left', 'down', 'up', 'right'].indexOf(a); if (i >= 0) return i; }
      return -1;
    };
    // estado de teclas sostenidas
    for (let i = 0; i < 4; i++) this.keyHeld[i] = inp.pressed(['left', 'down', 'up', 'right'][i]);
    if (this.cpuControlled) { for (const q of inp.queue) void q; return; }
    for (const q of inp.queue) {
      const d = dirOf(q.code);
      if (d < 0) continue;
      const pos = this.cond.songPosition - (nowPerf - q.time) * this.playbackRate;
      if (q.down) this.keyPressed(d, pos);
      else {
        const s = this.playerStrums[d];
        s.playStrumAnim('static'); s.resetAnim = 0;
        this.scripts.call('onKeyRelease', [d]);
      }
    }
  }

  private keyPressed(key: number, pos: number) {
    if (this.paused || this.endingSong || !this.generatedMusic) return;
    this.scripts.call('onKeyPress', [key]);
    const safe = this.cond.safeZoneOffset;
    const possible = this.notes.filter(n => n.mustPress && !n.wasGoodHit && !n.tooLate && !n.blockHit && n.noteData === key
      && n.strumTime > pos - safe * n.lateHitMult && n.strumTime < pos + safe * n.earlyHitMult && !n.missed);
    possible.sort((a, b) => a.strumTime - b.strumTime || Number(a.lowPriority) - Number(b.lowPriority));
    const strum = this.playerStrums[key];
    if (possible.length) {
      let target = possible[0];
      // si hay dos notas casi juntas, golpea la más cercana a la pulsación
      if (possible.length > 1 && Math.abs(possible[1].strumTime - pos) < Math.abs(target.strumTime - pos) && possible[1].strumTime - target.strumTime < 5) target = possible[1];
      this.goodNoteHit(target, false, pos);
    } else {
      if (!this.prefs.ghostTapping) this.noteMissPress(key);
      this.scripts.call('onGhostTap', [key]);
    }
    if (strum.animName !== 'confirm') { strum.playStrumAnim('pressed'); strum.resetAnim = 0; }
  }

  // ====================================================================== golpes
  judge(diff: number): Rating {
    if (!this.ratings.length) {
      const p = this.prefs;
      this.ratings = [
        { name: 'sick', window: p.sickWindow, mod: 1, score: 350, splash: true, hits: 0 },
        { name: 'good', window: p.goodWindow, mod: 0.67, score: 200, splash: false, hits: 0 },
        { name: 'bad', window: p.badWindow, mod: 0.34, score: 100, splash: false, hits: 0 },
        { name: 'shit', window: 9999, mod: 0, score: 50, splash: false, hits: 0 },
      ];
    }
    for (let i = 0; i < this.ratings.length - 1; i++) if (diff <= this.ratings[i].window) return this.ratings[i];
    return this.ratings[this.ratings.length - 1];
  }

  goodNoteHit(n: Note, auto: boolean, pos = this.cond.songPosition) {
    if (n.wasGoodHit) return;
    n.wasGoodHit = true;
    const idx = this.notes.indexOf(n);
    if (this.hitsoundBuf && this.prefs.hitsoundVolume > 0) this.e.audio.playSound(this.hitsoundBuf, this.prefs.hitsoundVolume);

    if (n.hitCausesMiss) {
      this.noteMiss(n, true);
      if (!n.noAnimation && this.boyfriend.hasAnim('hurt')) { this.boyfriend.playAnim('hurt', true); this.boyfriend.specialAnim = true; }
      this.removeNote(n);
      return;
    }
    const strum = this.playerStrums[n.noteData];
    const char = n.gfNote ? this.gf : this.boyfriend;
    if (!n.noAnimation && char) {
      char.playAnim(SING_ANIMS[n.noteData] + n.animSuffix, true);
      char.holdTimer = 0;
    }
    if (n.noteType === 'Hey!') {
      for (const c of [this.boyfriend, this.gf]) if (c?.hasAnim('hey')) { c.playAnim('hey', true); c.specialAnim = true; c.heyTimer = 0.6; }
    }
    strum.playStrumAnim('confirm', true);
    if (auto) strum.resetAnim = this.stepCrochet * 1.5 / 1000;
    // puntuación
    const diff = Math.abs(n.strumTime - pos + this.prefs.ratingOffset);
    const r = auto ? this.ratings[0] ?? this.judge(0) : this.judge(diff);
    n.rating = r.name; n.ratingMod = r.mod;
    if (!n.ratingDisabled) r.hits++;
    this.combo++;
    this.songHits++;
    this.totalNotesHit += r.mod; this.totalPlayed++;
    if (!this.practiceMode) this.songScore += r.score;
    this.popUpScore(r, n);
    this.health += n.hitHealth * this.healthGain;
    if (this.vocals) this.vocals.volume = 1;
    this.recalcRating(false);
    this.scripts.call('goodNoteHit', [idx, n.noteData, n.noteType, false]);
    if (n.hasSustain) { n.holding = true; n.susTick = 0; }
    else this.removeNote(n);
  }

  opponentNoteHit(n: Note) {
    n.hitByOpponent = true;
    const idx = this.notes.indexOf(n);
    const char = n.gfNote ? this.gf : this.dad;
    if (n.noteType !== 'Hey!' && !n.noAnimation && char) {
      char.playAnim(SING_ANIMS[n.noteData] + n.animSuffix, true); char.holdTimer = 0;
    } else if (n.noteType === 'Hey!' && char?.hasAnim('hey')) { char.playAnim('hey', true); char.specialAnim = true; char.heyTimer = 0.6; }
    if (this.opponentVocals) this.opponentVocals.volume = 1; else if (this.vocals) this.vocals.volume = 1;
    const strum = this.opponentStrums[n.noteData];
    strum.playStrumAnim('confirm', true); strum.resetAnim = this.stepCrochet * 1.5 / 1000;
    if (this.camZooming && false) void 0;
    this.scripts.call('opponentNoteHit', [idx, n.noteData, n.noteType, false]);
    if (n.hasSustain) { n.holding = true; } else n.susDone = true;
  }

  noteMiss(n: Note, hit = false) {
    const idx = this.notes.indexOf(n);
    n.missed = true;
    this.combo = 0;
    this.health -= n.missHealth * this.healthLoss;
    this.songMisses++;
    if (this.vocals) this.vocals.volume = 0;
    if (!this.practiceMode) this.songScore -= 10;
    this.totalPlayed++;
    this.recalcRating(true);
    const char = n.gfNote ? this.gf : this.boyfriend;
    if (!n.noAnimation && char && char.hasMissAnimations && !hit) char.playAnim(SING_ANIMS[n.noteData] + 'miss' + n.animSuffix, true);
    if (!hit) this.e.audio.playSound(this.missBufs[Math.floor(Math.random() * 3)], 0.1 + Math.random() * 0.1);
    this.scripts.call('noteMiss', [idx, n.noteData, n.noteType, false]);
  }

  private noteMissPress(key: number) {
    if (this.practiceMode || this.endingSong) return;
    this.health -= 0.05 * this.healthLoss;
    if (this.combo > 5 && this.gf?.hasAnim('sad')) this.gf.playAnim('sad');
    this.combo = 0;
    if (!this.practiceMode) this.songScore -= 10;
    this.totalPlayed++;
    this.songMisses++;
    this.recalcRating(true);
    this.e.audio.playSound(this.missBufs[Math.floor(Math.random() * 3)], 0.1 + Math.random() * 0.1);
    if (this.vocals) this.vocals.volume = 0;
    const b = this.boyfriend;
    if (b.hasMissAnimations) b.playAnim(SING_ANIMS[key] + 'miss', true);
    this.scripts.call('noteMissPress', [key]);
  }

  // ====================================================================== puntuación / texto
  recalcRating(badHit: boolean) {
    if (this.totalPlayed < 1) { this.ratingName = '?'; this.ratingFC = ''; }
    else {
      this.ratingPercent = Math.min(1, Math.max(0, this.totalNotesHit / this.totalPlayed));
      this.ratingName = RATING_STUFF[RATING_STUFF.length - 1][0];
      if (this.ratingPercent < 1) for (let i = 0; i < RATING_STUFF.length - 1; i++) if (this.ratingPercent < RATING_STUFF[i][1]) { this.ratingName = RATING_STUFF[i][0]; break; }
    }
    // FC
    const get = (n: string) => this.ratings.find(r => r.name === n)?.hits ?? 0;
    const sicks = get('sick'), goods = get('good'), bads = get('bad'), shits = get('shit');
    this.ratingFC = '';
    if (sicks > 0) this.ratingFC = 'SFC';
    if (goods > 0) this.ratingFC = 'GFC';
    if (bads > 0 || shits > 0) this.ratingFC = 'FC';
    if (this.songMisses > 0) this.ratingFC = this.songMisses < 10 ? 'SDCB' : 'Clear';
    this.updateScoreText(badHit);
  }

  updateScoreText(miss = false) {
    const r = this.scripts.call('preUpdateScore', [miss]);
    if (r === FUNCTION_STOP) return;
    let str = this.ratingName;
    if (this.totalPlayed !== 0) {
      const pct = Math.floor(this.ratingPercent * 10000) / 100;
      str += ` (${pct}%) - ${this.ratingFC}`;
    }
    this.scoreTxt.text = `Score: ${this.songScore} | Misses: ${this.songMisses} | Rating: ${str}\n`;
    if (!miss && !this.cpuControlled && this.prefs.scoreZoom) {
      this.scoreScale = 1.075;
      this.tweens.cancelTag('scoreBop');
      const o = this; this.tweens.tween(o, { scoreScale: 1 }, 0.2, { tag: 'scoreBop' });
    }
    this.scripts.call('onUpdateScore', [miss]);
  }

  private async popUpScore(r: Rating, n: Note) {
    if (this.prefs.hideHud) return;
    const assets = this.e.assets;
    const pre = this.isPixelStage ? 'pixelUI/' : '', suf = this.isPixelStage ? '-pixel' : '';
    const placement = W * 0.35;
    if (!this.prefs.comboStacking) { for (const s of this.comboSprites) this.removeHud(s); this.comboSprites = []; }
    // splash
    if (r.splash && this.splashAtlas) this.spawnSplash(n);
    const ratingAtlas = await assets.image(pre + r.name + suf) ?? await assets.image(r.name);
    const mk = (a: Atlas | null) => { const s = new Sprite(); if (a) s.loadGraphic(a.img); s.camera = 'hud'; s.scrollFactor.x = s.scrollFactor.y = 0; return s; };
    const sc = this.isPixelStage ? 6 * 0.85 : 0.7;
    if (ratingAtlas) {
      const spr = mk(ratingAtlas);
      spr.scale.x = spr.scale.y = sc; spr.updateHitbox();
      spr.x = placement - 40; spr.y = H / 2 - spr.height / 2 - 60;
      spr.acceleration.y = 550 * this.playbackRate ** 2; spr.velocity.y -= (140 + Math.random() * 35) * this.playbackRate; spr.velocity.x -= Math.random() * 10 * this.playbackRate;
      spr.antialiasing = !this.isPixelStage;
      this.layerHud.push(spr); this.comboSprites.push(spr);
      this.fadeOut(spr, this.crochet * 0.001 / this.playbackRate);
    }
    // número de combo
    const digits = String(Math.max(0, this.combo)).padStart(3, '0').split('');
    let i = 0;
    for (const d of digits) {
      const a = await assets.image(pre + 'num' + d + suf) ?? await assets.image('num' + d);
      if (!a) { i++; continue; }
      const s = mk(a);
      s.scale.x = s.scale.y = this.isPixelStage ? 6 : 0.5; s.updateHitbox();
      s.x = placement + (43 * i) - 90; s.y = H / 2 - s.height / 2 + 80;
      s.velocity.y -= (140 + Math.random() * 30) * this.playbackRate; s.velocity.x = (Math.random() * 10 - 5) * this.playbackRate;
      s.acceleration.y = (200 + Math.random() * 100) * this.playbackRate ** 2;
      s.antialiasing = !this.isPixelStage;
      this.layerHud.push(s); this.comboSprites.push(s);
      this.fadeOut(s, this.crochet * 0.002 / this.playbackRate);
      i++;
    }
  }

  private fadeOut(s: Sprite, delay: number) {
    this.tweens.tween(s, { alpha: 0 }, 0.2 / this.playbackRate, { delay, onComplete: () => this.removeHud(s) });
  }
  removeHud(s: Drawable) {
    this.layerHud = this.layerHud.filter(o => o !== s);
    this.comboSprites = this.comboSprites.filter(o => o !== s);
  }

  private spawnSplash(n: Note) {
    if (!this.splashAtlas || this.song.disableNoteRGB && false) return;
    const strum = this.playerStrums[n.noteData];
    const s = new Sprite();
    s.setAtlas(this.splashAtlas);
    const col = COL_ARRAY[n.noteData];
    const v = 1 + Math.floor(Math.random() * 2);
    if (!s.addByPrefix('splash', `note splash ${col} ${v}`, 24, false) && !s.addByPrefix('splash', `note splash ${col}`, 24, false)) return;
    const pal = (this.isPixelStage ? ARROW_RGB_PIXEL : ARROW_RGB)[n.noteData];
    if (n.useRGBShader) s.srcOverride = this.splashAtlas.recolored(pal[0], pal[1], pal[2]);
    s.camera = 'hud'; s.scrollFactor.x = s.scrollFactor.y = 0;
    s.play('splash', true);
    s.alpha = 0.6;
    s.scale.x = s.scale.y = 1;
    s.x = strum.x + strum.width / 2 - s.frameWidth / 2; s.y = strum.y + strum.height / 2 - s.frameHeight / 2;
    s.onAnimFinish = () => { this.layerHud = this.layerHud.filter(o => o !== s); };
    this.layerHud.push(s);
  }

  // ====================================================================== HUD por frame
  private updateHud(dt: number) {
    const hb = this.healthBar;
    hb.value = this.health;
    const pct = hb.percent;
    const clampPct = Math.max(0, Math.min(100, pct));
    const f = Math.exp(-dt * 9 * this.playbackRate);
    for (const ic of [this.iconP1, this.iconP2]) { const s = 1 + (ic.scale.x - 1) * f; ic.scale.x = ic.scale.y = s; }
    const p = this.iconP1, o = this.iconP2;
    p.x = hb.x + hb.width * ((100 - clampPct) * 0.01) + (150 * p.scale.x - 150) / 2 - 26;
    o.x = hb.x + hb.width * ((100 - clampPct) * 0.01) - (150 * o.scale.x) / 2 - 26 * 2;
    const hasWin = p.frameCount >= 3;
    p.setFrame(clampPct < 20 ? 1 : (clampPct > 80 && hasWin ? 2 : 0));
    o.setFrame(clampPct > 80 ? 1 : (clampPct < 20 && o.frameCount >= 3 ? 2 : 0));
    // tiempo
    const pos = Math.max(0, this.cond.songPosition);
    this.timeBar.value = this.songLength > 0 ? Math.min(1, pos / this.songLength) : 0;
    if (this.prefs.timeBarType !== 'Song Name' && this.prefs.timeBarType !== 'Disabled') {
      const secs = Math.floor(Math.max(0, (this.prefs.timeBarType === 'Time Elapsed' ? pos : this.songLength - pos)) / 1000);
      this.timeTxt.text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    }
    this.scoreTxt.scale.x = this.scoreTxt.scale.y = this.scoreScale;
    this.botplayTxt.visible = this.cpuControlled;
  }
  private updateFx(_dt: number) { /* reservado para efectos globales */ }

  // ====================================================================== pausa, muerte y fin
  pauseGame() {
    if (this.mode !== 'play') return;
    this.scripts.call('onPause');
    this.mode = 'pause'; this.paused = true; this.pauseSel = 0;
    this.pausedPos = this.cond.songPosition;
    this.inst?.stop(); this.vocals?.stop(); this.opponentVocals?.stop();
    this.tweens.setPaused(true);
  }
  resumeGame() {
    this.mode = 'play'; this.paused = false;
    const now = this.e.audio.ctx.currentTime;
    this.audioAnchor = now - this.pausedPos / 1000 / this.playbackRate;
    if (this.pausedPos >= 0) this.scheduleAudio(this.pausedPos);
    else this.scheduleAudio(0);
    this.tweens.setPaused(false);
    this.scripts.call('onResume');
  }
  private updatePause() {
    const inp = this.e.input;
    if (inp.justPressed('uiUp')) this.pauseSel = (this.pauseSel + 2) % 3;
    if (inp.justPressed('uiDown')) this.pauseSel = (this.pauseSel + 1) % 3;
    if (inp.justPressedRaw('Escape')) { this.resumeGame(); return; }
    if (inp.justPressed('accept')) {
      if (this.pauseSel === 0) this.resumeGame();
      else if (this.pauseSel === 1) { this.opts.onRestart ? this.opts.onRestart() : this.finishExit(false); }
      else this.finishExit(false);
    }
  }

  private async startGameOver() {
    this.mode = 'dead'; this.deadT = 0; this.deadState = 'first';
    this.inst?.stop(); this.vocals?.stop(); this.opponentVocals?.stop();
    this.scripts.call('onGameOverStart');
    const assets = this.e.assets;
    const name = this.song.gameOverChar || 'bf-dead';
    try {
      await preloadCharacter(assets, name);
      const bf = this.boyfriend;
      const c = new Character(bf.x - bf.positionArray[0], bf.y - bf.positionArray[1], name, true, assets);
      c.x += c.positionArray[0]; c.y += c.positionArray[1];
      this.deadChar = c; c.playAnim('firstDeath', true);
      this.deadCam.zoom = this.cams.game.zoom; this.deadCam.scroll.x = this.cams.game.scroll.x; this.deadCam.scroll.y = this.cams.game.scroll.y;
    } catch { this.deadChar = null; }
    this.e.audio.playSound(await assets.sound(this.song.gameOverSound || 'fnf_loss_sfx'), 1);
  }
  private updateDead(dt: number) {
    this.deadT += dt;
    const c = this.deadChar, inp = this.e.input;
    c?.update(dt);
    if (c && this.deadState === 'first') {
      const tx = c.midX() - W / 2, ty = c.midY() - H / 2;
      if (this.deadT > 0.4) { this.deadCam.scroll.x += (tx - this.deadCam.scroll.x) * (1 - Math.exp(-dt * 2.4)); this.deadCam.scroll.y += (ty - this.deadCam.scroll.y) * (1 - Math.exp(-dt * 2.4)); }
      if (c.finished && this.deadT > 1.2) { this.deadState = 'loop'; c.playAnim('deathLoop'); this.startDeadMusic(); }
    }
    if (this.deadState !== 'confirm' && inp.justPressed('accept')) {
      this.deadState = 'confirm'; c?.playAnim('deathConfirm', true);
      this.deadTrack?.stop();
      void this.e.assets.music(this.song.gameOverEnd || 'gameOverEnd').then(b => { this.deadTrack = this.e.audio.track(b); this.deadTrack.play(0); });
      this.fadeTarget = 1; this.endTimer = -1; setTimeout(() => { if (this.opts.onRestart) this.opts.onRestart(); }, 2200);
    }
    if (this.deadState !== 'confirm' && inp.justPressed('back')) { this.deadTrack?.stop(); this.finishExit(false); }
    this.fade += (this.fadeTarget - this.fade) * Math.min(1, dt * 1.5);
    this.tweens.update(dt);
  }
  private async startDeadMusic() {
    const b = await this.e.assets.music(this.song.gameOverLoop || 'gameOver');
    this.deadTrack = this.e.audio.track(b, true); this.deadTrack.play(0);
  }

  endSong() {
    if (this.endingSong) return;
    const r = this.scripts.call('onEndSong');
    if (r === FUNCTION_STOP) return;
    this.endingSong = true;
    this.inst?.stop(); this.vocals?.stop(); this.opponentVocals?.stop();
    if (!this.cpuControlled && !this.practiceMode) {
      saveScore(this.scoreId(), { score: this.songScore, rating: this.ratingPercent, misses: this.songMisses });
    }
    this.endTimer = 1.0;
  }
  scoreId() { return `${this.opts.mod}|${this.songName}|${this.opts.diffName}`; }

  private finishExit(finished: boolean) {
    if (this.exited) return;
    this.exited = true;
    this.opts.onExit({ finished, score: this.songScore });
  }
  private exited = false;

  // ====================================================================== dibujo
  render(ctx: CanvasRenderingContext2D) {
    if (this.mode === 'load') return;
    if (this.mode === 'dead') {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      this.deadCam.begin(ctx);
      this.deadChar?.draw(ctx, this.deadCam);
      this.deadCam.end(ctx);
      if (this.fade > 0.01) { ctx.fillStyle = `rgba(0,0,0,${this.fade})`; ctx.fillRect(0, 0, W, H); }
      return;
    }
    const order: Drawable[][] = [this.layerBack, this.layerChars, this.layerFront, this.layerHud, this.layerOther];
    for (const cam of [this.cams.game, this.cams.hud, this.cams.other]) {
      cam.begin(ctx);
      for (const layer of order) {
        for (const o of layer) if (o.camera === cam.name) o.draw(ctx, cam);
        if (layer === this.layerHud && cam.name === 'hud') this.drawNotes(ctx, cam);
        if (layer === this.layerHud && cam.name === 'hud') {
          this.timeBar.draw(ctx, cam); this.timeTxt.draw(ctx, cam);
          this.healthBar.draw(ctx, cam);
          this.iconP1.draw(ctx, cam); this.iconP2.draw(ctx, cam);
          this.scoreTxt.draw(ctx, cam); this.botplayTxt.draw(ctx, cam);
        }
      }
      cam.end(ctx);
    }
    if (this.mode === 'pause') this.drawPause(ctx);
  }

  private drawNotes(ctx: CanvasRenderingContext2D, cam: Camera) {
    // colas primero (detrás de las cabezas)
    for (const n of this.notes) {
      if (!n.hasSustain || !n.atlas) continue;
      const col = COL_ARRAY[n.noteData];
      const frames = n.atlas.frames;
      const piece = frames.find(f => f.name.startsWith(col + ' hold piece')), end = frames.find(f => f.name.startsWith(col + ' hold end'));
      n.drawSustain(ctx, cam, { atlas: n.atlas, piece, end });
    }
    for (const n of this.notes) {
      if (n.wasGoodHit || (n.hitByOpponent && !n.mustPress)) continue;
      if (n.missed && n.alpha > 0.3) { n.alpha = 0.3; }
      n.draw(ctx, cam);
    }
  }

  private drawPause(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, W, H);
    ctx.font = '48px "vcr", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const items = ['Resume', 'Restart Song', 'Exit to menu'];
    items.forEach((t, i) => {
      ctx.globalAlpha = i === this.pauseSel ? 1 : 0.5;
      ctx.lineWidth = 8; ctx.strokeStyle = '#000'; ctx.strokeText(t, W / 2, 330 + i * 70);
      ctx.fillStyle = '#fff'; ctx.fillText(t, W / 2, 330 + i * 70);
    });
    ctx.globalAlpha = 1; ctx.font = '28px "vcr", monospace';
    ctx.fillStyle = '#fff'; ctx.fillText(`${this.song.song} - ${this.opts.diffName}`, W / 2, 150);
    ctx.fillText(`Misses: ${this.songMisses}`, W / 2, 200);
    ctx.font = '16px "vcr", monospace'; ctx.fillText(ENGINE_NAME, W / 2, H - 30);
    ctx.restore();
  }

  keyDown(code: string) {
    void code;
  }

  // ====================================================================== utilidades para scripts
  /** sprite añadido por Lua (tag) */
  addDrawable(tag: string, o: Drawable, front: boolean) {
    this.luaSprites.set(tag, o);
    if (front) this.layerFront.push(o); else this.layerBack.push(o);
  }
  removeDrawable(o: Drawable) {
    for (const l of [this.layerBack, this.layerChars, this.layerFront, this.layerHud, this.layerOther]) {
      const i = l.indexOf(o); if (i >= 0) l.splice(i, 1);
    }
  }

  destroy() {
    this.scripts?.destroy();
    this.inst?.destroy(); this.vocals?.destroy(); this.opponentVocals?.destroy(); this.deadTrack?.destroy();
    this.e.assets.currentLevel = null;
    this.tweens.clear();
  }
}

export type { Frame };
