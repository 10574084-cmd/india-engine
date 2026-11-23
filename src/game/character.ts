import { Assets } from '../engine/assets';
import { Atlas, Sprite } from '../engine/display';

export interface AnimArray { anim: string; name: string; fps: number; loop: boolean; indices: number[]; offsets: number[] }
export interface CharacterFile {
  animations: AnimArray[]; image: string; scale: number; sing_duration: number; healthicon: string;
  position: number[]; camera_position: number[]; flip_x: boolean; no_antialiasing: boolean;
  healthbar_colors: number[]; vocals_file?: string;
}

interface Loaded { json: CharacterFile; atlas: Atlas | null; missing: boolean }
const cache = new Map<string, Loaded>();
export const clearCharCache = () => cache.clear();

/** Carga (async) el JSON y el atlas de un personaje; luego `new Character` es síncrono. */
export async function preloadCharacter(assets: Assets, name: string): Promise<void> {
  const key = assets.currentMod + '|' + name;
  if (cache.has(key)) return;
  let json = await assets.json<CharacterFile>(`characters/${name}.json`);
  let missing = false;
  if (!json) { json = await assets.json<CharacterFile>('characters/bf.json'); missing = true; }
  if (!json) json = { animations: [], image: '', scale: 1, sing_duration: 4, healthicon: 'face', position: [0, 0], camera_position: [0, 0], flip_x: false, no_antialiasing: false, healthbar_colors: [161, 161, 161] };
  const atlas = json.image ? await assets.atlas(json.image) : null;
  cache.set(key, { json, atlas, missing });
}

export class Character extends Sprite {
  curCharacter: string;
  isPlayer: boolean;
  animOffsets = new Map<string, number[]>();
  holdTimer = 0; heyTimer = 0;
  specialAnim = false; stunned = false; skipDance = false;
  singDuration = 4; idleSuffix = ''; danceIdle = false; danced = false;
  healthIcon = 'face';
  positionArray = [0, 0]; cameraPosition = [0, 0];
  healthColorArray = [161, 161, 161];
  hasMissAnimations = false;
  danceEveryNumBeats = 2;
  vocalsFile = '';
  jsonScale = 1;
  originalFlipX = false;
  imageFile = '';
  /** ¿se usa un personaje de reemplazo porque el pedido no existe? */
  isFallback = false;
  extraData = new Map<string, any>();

  constructor(x: number, y: number, name: string, isPlayer: boolean, private assets: Assets) {
    super(x, y);
    this.curCharacter = name; this.isPlayer = isPlayer;
    const l = cache.get(assets.currentMod + '|' + name);
    if (!l) throw new Error('Personaje sin precargar: ' + name);
    this.load(l);
  }

  private load(l: Loaded) {
    const j = l.json;
    if (l.missing) { this.color = 0x000000; this.alpha = 0.6; this.isFallback = true; }
    if (l.atlas) this.setAtlas(l.atlas);
    this.imageFile = j.image;
    this.jsonScale = j.scale ?? 1;
    this.scale.x = this.scale.y = this.jsonScale;
    this.updateHitbox();
    this.positionArray = j.position ?? [0, 0];
    this.cameraPosition = j.camera_position ?? [0, 0];
    this.healthIcon = j.healthicon ?? 'face';
    this.singDuration = j.sing_duration ?? 4;
    this.flipX = (!!j.flip_x) !== this.isPlayer;
    this.originalFlipX = !!j.flip_x;
    this.healthColorArray = j.healthbar_colors && j.healthbar_colors.length > 2 ? j.healthbar_colors : [161, 161, 161];
    this.vocalsFile = j.vocals_file ?? '';
    this.antialiasing = !j.no_antialiasing;
    for (const a of j.animations ?? []) {
      const name = '' + a.anim, prefix = '' + a.name;
      if (a.indices && a.indices.length > 0) this.addByIndices(name, prefix, a.indices, '', a.fps ?? 24, !!a.loop);
      else this.addByPrefix(name, prefix, a.fps ?? 24, !!a.loop);
      this.animOffsets.set(name, a.offsets && a.offsets.length > 1 ? [a.offsets[0], a.offsets[1]] : [0, 0]);
    }
    this.hasMissAnimations = ['singLEFTmiss', 'singDOWNmiss', 'singUPmiss', 'singRIGHTmiss'].some(n => this.animOffsets.has(n));
    this.recalculateDanceIdle(true);
    this.dance();
  }

  recalculateDanceIdle(first = false) {
    const last = this.danceIdle;
    this.danceIdle = this.animOffsets.has('danceLeft' + this.idleSuffix) && this.animOffsets.has('danceRight' + this.idleSuffix);
    if (first) this.danceEveryNumBeats = this.danceIdle ? 1 : 2;
    else if (last !== this.danceIdle) {
      let c = this.danceEveryNumBeats;
      c = this.danceIdle ? c / 2 : c * 2;
      this.danceEveryNumBeats = Math.round(Math.max(c, 1));
    }
  }

  get curAnimName() { return this.animName; }
  isAnimFinished() { return !this.cur || this.finished; }

  playAnim(name: string, force = false, reversed = false, frame = 0) {
    this.specialAnim = false;
    if (!this.hasAnim(name)) return false;
    this.play(name, force, reversed, frame);
    const o = this.animOffsets.get(name);
    if (o) { this.offset.x = o[0]; this.offset.y = o[1]; } else { this.offset.x = 0; this.offset.y = 0; }
    if (this.curCharacter.startsWith('gf-') || this.curCharacter === 'gf') {
      if (name === 'singLEFT') this.danced = true;
      else if (name === 'singRIGHT') this.danced = false;
      else if (name === 'singUP' || name === 'singDOWN') this.danced = !this.danced;
    }
    return true;
  }

  dance() {
    if (this.skipDance || this.specialAnim) return;
    if (this.danceIdle) {
      this.danced = !this.danced;
      this.playAnim((this.danced ? 'danceRight' : 'danceLeft') + this.idleSuffix);
    } else if (this.hasAnim('idle' + this.idleSuffix)) {
      this.playAnim('idle' + this.idleSuffix);
    }
  }

  update(dt: number, stepCrochet = 150, rate = 1) {
    if (!this.cur) { super.update(dt); return; }
    if (this.heyTimer > 0) {
      this.heyTimer -= dt * rate;
      if (this.heyTimer <= 0) {
        if (this.specialAnim && (this.animName === 'hey' || this.animName === 'cheer')) { this.specialAnim = false; this.dance(); }
        this.heyTimer = 0;
      }
    } else if (this.specialAnim && this.finished) {
      this.specialAnim = false; this.dance();
    } else if (this.animName.endsWith('miss') && this.finished) {
      this.dance(); this.finish();
    }
    if (this.animName.startsWith('sing')) this.holdTimer += dt;
    else if (this.isPlayer) this.holdTimer = 0;
    if (!this.isPlayer && this.holdTimer >= stepCrochet * (0.0011 / rate) * this.singDuration) {
      this.dance(); this.holdTimer = 0;
    }
    if (this.finished && this.animOffsets.has(this.animName + '-loop')) this.playAnim(this.animName + '-loop');
    super.update(dt);
  }
}
