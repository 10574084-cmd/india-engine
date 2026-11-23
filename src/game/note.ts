import { Assets } from '../engine/assets';
import { Atlas, Camera, Sprite } from '../engine/display';

export const SWAG_WIDTH = 160 * 0.7;
export const COL_ARRAY = ['purple', 'blue', 'green', 'red'];
export const DIR_ARRAY = ['left', 'down', 'up', 'right'];
export const DIR_UP = ['LEFT', 'DOWN', 'UP', 'RIGHT'];
export const SING_ANIMS = ['singLEFT', 'singDOWN', 'singUP', 'singRIGHT'];
export const DEFAULT_NOTE_SKIN = 'noteSkins/NOTE_assets';

export const ARROW_RGB: number[][] = [
  [0xC24B99, 0xFFFFFF, 0x3C1F56], [0x00FFFF, 0xFFFFFF, 0x1542B7],
  [0x12FA05, 0xFFFFFF, 0x0A4447], [0xF9393F, 0xFFFFFF, 0x651038],
];
export const ARROW_RGB_PIXEL: number[][] = [
  [0xE276FF, 0xFFF9FF, 0x60008D], [0x3DCAFF, 0xF4FFFF, 0x003060],
  [0x71E300, 0xF6FFE6, 0x003100], [0xFF884E, 0xFFFAF5, 0x6C0000],
];

export class Note extends Sprite {
  strumTime = 0;
  noteData = 0;
  mustPress = false;
  canBeHit = false; tooLate = false; wasGoodHit = false; missed = false;
  ignoreNote = false; hitByOpponent = false; blockHit = false;
  noteType = '';
  gfNote = false; animSuffix = ''; noAnimation = false;
  sustainLength = 0;          // ms
  isSustainNote = false;
  hasSustain = false;
  holding = false;            // cabeza ya golpeada y cola en curso
  susDone = false;            // cola terminada o soltada
  susTick = 0;                // acumulador para dar salud por cada step sostenido
  hitHealth = 0.023; missHealth = 0.0475; hitCausesMiss = false;
  earlyHitMult = 1; lateHitMult = 1; lowPriority = false;
  multSpeed = 1; multAlpha = 1;
  offsetX = 0; offsetY = 0; offsetAngle = 0;
  copyX = true; copyY = true; copyAngle = true; copyAlpha = true;
  rating = 'unknown'; ratingMod = 0; ratingDisabled = false;
  useRGBShader = true;
  texture = '';
  distance = 0;
  spawned = false;
  extraData = new Map<string, any>();
  eventName = ''; eventLength = 0; eventVal1 = ''; eventVal2 = '';
  noteSplashData = { disabled: false, texture: null as string | null, useRGBShader: true, r: -1, g: -1, b: -1, a: 0.6 };
  /** cola: geometría calculada por PlayState cada frame (coordenadas de pantalla del mundo HUD) */
  susTopY = 0; susBottomY = 0; susCenterX = 0; susDown = false;
  /** textura y paleta de la cola */
  atlas2: Atlas | null = null;

  get hitWindowStart() { return this.strumTime; }

  /** Pinta la cola de sustain (1 trozo estirado + remate). */
  drawSustain(ctx: CanvasRenderingContext2D, cam: Camera, srcPiece: { atlas: Atlas; piece: any; end: any } | null) {
    if (!this.hasSustain || this.susDone || !srcPiece || !this.visible) return;
    const { atlas, piece, end } = srcPiece;
    if (!piece || !end) return;
    const top = Math.min(this.susTopY, this.susBottomY), bot = Math.max(this.susTopY, this.susBottomY);
    const len = bot - top;
    if (len <= 1) return;
    const sc = this.scale.x;
    const w = piece.w * sc;
    const capH = Math.min(end.h * sc, len);
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.alpha * this.multAlpha * (this.missed ? 0.3 : 0.6)) * cam.alpha;
    const src = this.srcOverride ?? atlas.img;
    const cx = this.susCenterX - cam.scroll.x * this.scrollFactor.x;
    const x0 = cx - w / 2;
    const bodyH = len - capH;
    if (!this.susDown) {
      // upscroll: la cola se extiende hacia abajo (tiempo futuro), el remate queda abajo
      if (bodyH > 0) ctx.drawImage(src as any, piece.x, piece.y, piece.w, piece.h, x0, top, w, bodyH + 1);
      ctx.drawImage(src as any, end.x, end.y, end.w, end.h, x0, top + bodyH, w, capH);
    } else {
      // downscroll: invertido verticalmente
      if (bodyH > 0) ctx.drawImage(src as any, piece.x, piece.y, piece.w, piece.h, x0, top + capH - 1, w, bodyH + 1);
      ctx.save();
      ctx.translate(0, top + capH / 2); ctx.scale(1, -1); ctx.translate(0, -(top + capH / 2));
      ctx.drawImage(src as any, end.x, end.y, end.w, end.h, x0, top, w, capH);
      ctx.restore();
    }
    ctx.restore();
  }
}

export class StrumNote extends Sprite {
  resetAnim = 0;
  noteData: number;
  player: number;
  downScroll = false;
  sustainReduce = true;
  useRGBShader = true;
  direction = 90;
  pixel = false;
  rgb: number[];
  texture = '';
  constructor(x: number, y: number, noteData: number, player: number) {
    super(x, y);
    this.noteData = noteData; this.player = player;
    this.rgb = ARROW_RGB[noteData];
  }
  playStrumAnim(name: string, force = false) {
    this.play(name, force);
    if (this.cur) { this.centerOffsets(); this.centerOrigin(); }
    this.applyShader();
  }
  applyShader() {
    if (this.atlas && this.useRGBShader && this.animName !== 'static') this.srcOverride = this.atlas.recolored(this.rgb[0], this.rgb[1], this.rgb[2]);
    else this.srcOverride = null;
  }
  update(dt: number) {
    if (this.resetAnim > 0) {
      this.resetAnim -= dt;
      if (this.resetAnim <= 0) { this.playStrumAnim('static'); this.resetAnim = 0; }
    }
    super.update(dt);
  }
}

/** Carga el atlas de una nota/strum y registra sus animaciones Sparrow estándar. */
export async function loadNoteAtlas(assets: Assets, skin: string): Promise<Atlas | null> {
  return (await assets.atlas(skin)) ?? (await assets.atlas(DEFAULT_NOTE_SKIN));
}

export function setupStrumAnims(s: StrumNote, atlas: Atlas, skin: string) {
  s.setAtlas(atlas);
  s.texture = skin;
  const d = s.noteData;
  s.addByPrefix('green', 'arrowUP');
  s.addByPrefix('blue', 'arrowDOWN');
  s.addByPrefix('purple', 'arrowLEFT');
  s.addByPrefix('red', 'arrowRIGHT');
  const name = DIR_ARRAY[d];
  s.addByPrefix('static', 'arrow' + DIR_UP[d]);
  s.addByPrefix('pressed', name + ' press', 24, false);
  s.addByPrefix('confirm', name + ' confirm', 24, false);
  s.scale.x = s.scale.y = 0.7;
  s.updateHitbox();
  s.playStrumAnim('static');
}

export function setupNoteAnims(n: Note, atlas: Atlas, skin: string) {
  n.setAtlas(atlas);
  n.texture = skin;
  const c = COL_ARRAY[n.noteData % 4];
  n.addByPrefix(c + 'Scroll', c + '0');
  n.scale.x = n.scale.y = 0.7;
  n.play(c + 'Scroll');
  n.updateHitbox();
}
