import { Camera, Drawable, Sprite, W, H } from '../engine/display';
import { Track } from '../engine/audio';
import type { PlayState, EventNote } from './playstate';
import { Character } from './character';

/**
 * Escenarios vanilla portados de los stages Haxe de Psych 0.7.3.
 * Cada clase replica create/createPost/update/beatHit/eventCalled del original.
 */

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const rndInt = (a: number, b: number, exclude: number[] = []) => {
  for (let i = 0; i < 40; i++) { const v = Math.floor(rnd(a, b + 1)); if (!exclude.includes(v)) return v; }
  return a;
};
const chance = (p: number) => Math.random() * 100 < p;

// ---- color HSB (FlxColor.saturation / brightness)
function rgbToHsv(c: number): [number, number, number] {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}
function hsvToRgb(h: number, s: number, v: number): number {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

/** BGSprite de Psych: imagen estática o animada por prefijo. */
export class BG extends Sprite {
  idleAnim: string | null = null;
  static async make(ps: PlayState, image: string | null, x = 0, y = 0, sx = 1, sy = 1, anims: string[] | null = null, loop = false): Promise<BG> {
    const s = new BG(x, y);
    const a = ps.e.assets;
    if (image) {
      if (anims) {
        const at = await a.atlas(image);
        if (at) {
          s.setAtlas(at);
          for (const an of anims) {
            s.addByPrefix(an, an, 24, loop);
            if (!s.idleAnim) { s.idleAnim = an; s.play(an); }
          }
        }
      } else {
        const at = await a.image(image);
        if (at) s.setAtlas(at);
      }
    }
    s.scrollFactor.x = sx; s.scrollFactor.y = sy;
    s.antialiasing = ps.prefs.antialiasing;
    return s;
  }
  dance(force = false) { if (this.idleAnim) this.play(this.idleAnim, force); }
  scaleBy(k: number) { this.setGraphicSize(Math.floor(this.width * k)); this.updateHitbox(); return this; }
}

export function solid(w: number, h: number, color: number, x = 0, y = 0, sf = 0): BG {
  const s = new BG(x, y); s.makeGraphic(w, h, color); s.scrollFactor.x = s.scrollFactor.y = sf; return s;
}

/** Grupo simple de sprites con alpha/visible/blend compartidos. */
export class Group implements Drawable {
  camera = 'game'; visible = true; alpha = 1; blend = '';
  items: Sprite[] = [];
  update(dt: number) { for (const i of this.items) i.update(dt); }
  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (!this.visible) return;
    for (const i of this.items) { const a = i.alpha; i.alpha = a * this.alpha; if (this.blend) i.blend = this.blend; i.draw(ctx, cam); i.alpha = a; }
  }
}

export abstract class StageImpl {
  defaultGF = '';
  phase: 'create' | 'post' = 'create';
  constructor(public ps: PlayState) {}
  get low() { return this.ps.prefs.lowQuality; }
  get a() { return this.ps.e.assets; }
  async create() {}
  createPost(): void | Promise<void> {}
  update(_dt: number) {}
  beatHit(_beat: number) {}
  countdownTick(_n: number) {}
  eventCalled(_name: string, _v1: string, _v2: string, _f1: number, _f2: number) {}
  async eventPushed(_ev: EventNote) {}
  destroy() {}

  add(o: Drawable) { (this.phase === 'create' ? this.ps.layerBack : this.ps.layerFront).push(o); return o; }
  addBehindGF(o: Drawable) { this.ps.layerBack.push(o); return o; }
  addBehindDad(o: Drawable) {
    const i = this.ps.layerChars.indexOf(this.ps.dad);
    this.ps.layerChars.splice(i < 0 ? 0 : i, 0, o); return o;
  }
  insertBefore(o: Drawable, ref: Drawable) {
    for (const l of [this.ps.layerBack, this.ps.layerFront]) { const i = l.indexOf(ref); if (i >= 0) { l.splice(i, 0, o); return o; } }
    return this.add(o);
  }
  insertAfter(o: Drawable, ref: Drawable) {
    for (const l of [this.ps.layerBack, this.ps.layerFront]) { const i = l.indexOf(ref); if (i >= 0) { l.splice(i + 1, 0, o); return o; } }
    return this.add(o);
  }
  sound(name: string, vol = 1) { void this.a.sound(name).then(b => this.ps.e.audio.playSound(b, vol)); }
  bg(image: string | null, x = 0, y = 0, sx = 1, sy = 1, anims: string[] | null = null, loop = false) { return BG.make(this.ps, image, x, y, sx, sy, anims, loop); }
  get chars(): (Character | null)[] { return [this.ps.boyfriend, this.ps.gf, this.ps.dad]; }
}

// =============================================================== Semana 1
class StageWeek1 extends StageImpl {
  black?: BG; light?: BG; fog?: Group;
  async create() {
    this.add(await this.bg('stageback', -600, -200, 0.9, 0.9));
    this.add((await this.bg('stagefront', -650, 600, 0.9, 0.9)).scaleBy(1.1));
    if (!this.low) {
      this.add((await this.bg('stage_light', -125, -100, 0.9, 0.9)).scaleBy(1.1));
      const l2 = (await this.bg('stage_light', 1225, -100, 0.9, 0.9)).scaleBy(1.1); l2.flipX = true; this.add(l2);
      this.add((await this.bg('stagecurtains', -500, -300, 1.3, 1.3)).scaleBy(0.9));
    }
  }
  async eventPushed(ev: EventNote) {
    if (ev.event !== 'Dadbattle Spotlight' || this.black) return;
    this.black = solid(W * 2, H * 2, 0x000000, -800, -400, 0); this.black.alpha = 0.25; this.black.visible = false; this.add(this.black);
    this.light = await this.bg('spotlight', 400, -400, 0, 0); this.light.alpha = 0.375; this.light.blend = 'add'; this.light.visible = false; this.add(this.light);
    const fog = new Group(); fog.alpha = 0; fog.blend = 'add'; fog.visible = false;
    for (const [x, dir] of [[-1550 + 200, 1], [1550 + 200, -1]] as [number, number][]) {
      const s = await this.bg('smoke', x, 660 + rnd(-20, 20), 1.2, 1.05);
      s.scaleBy(rnd(1.1, 1.22)); s.velocity.x = dir * rnd(15, 22); if (dir < 0) s.flipX = true;
      fog.items.push(s);
    }
    this.fog = fog; this.add(fog);
  }
  eventCalled(name: string, _v1: string, _v2: string, f1: number) {
    if (name !== 'Dadbattle Spotlight' || !this.black || !this.light || !this.fog) return;
    const ps = this.ps, val = Math.round(isNaN(f1) ? 0 : f1);
    if (val >= 1 && val <= 3) {
      if (val === 1) { this.black.visible = this.light.visible = this.fog.visible = true; ps.defaultCamZoom += 0.12; }
      const who = val > 2 ? ps.boyfriend : ps.dad;
      this.light.alpha = 0;
      ps.tweens.timer(0.12, 1, () => { this.light!.alpha = 0.375; });
      this.light.x = who.graphicMidX() - this.light.width / 2;
      this.light.y = who.y + who.height - this.light.height + 50;
      ps.tweens.tween(this.fog, { alpha: 0.7 }, 1.5, { ease: 'quadInOut' });
    } else {
      this.black.visible = this.light.visible = false;
      ps.defaultCamZoom -= 0.12;
      const fog = this.fog;
      ps.tweens.tween(fog, { alpha: 0 }, 0.7, { onComplete: () => { fog.visible = false; } });
    }
  }
}

// =============================================================== Spooky
class Spooky extends StageImpl {
  bg0!: BG; white!: BG;
  strikeBeat = 0; offsetBeats = 8;
  async create() {
    this.bg0 = this.low ? await this.bg('halloween_bg_low', -200, -100)
      : await this.bg('halloween_bg', -200, -100, 1, 1, ['halloweem bg0', 'halloweem bg lightning strike']);
    this.add(this.bg0);
  }
  createPost() {
    this.white = solid(W * 2, H * 2, 0xffffff, -800, -400, 0); this.white.alpha = 0; this.white.blend = 'add';
    this.add(this.white);
  }
  beatHit(beat: number) {
    if (chance(10) && beat > this.strikeBeat + this.offsetBeats) this.strike(beat);
  }
  strike(beat: number) {
    const ps = this.ps;
    this.sound('thunder_' + rndInt(1, 2));
    if (!this.low) this.bg0.play('halloweem bg lightning strike', true);
    this.strikeBeat = beat; this.offsetBeats = rndInt(8, 24);
    for (const c of [ps.boyfriend, ps.dad, ps.gf]) if (c && c.animOffsets.has('scared')) c.playAnim('scared', true);
    if (ps.prefs.camZooms) {
      ps.cams.game.zoom += 0.015; ps.cams.hud.zoom += 0.03;
      if (!ps.camZooming) {
        ps.tweens.tween(ps.cams.game, { zoom: ps.defaultCamZoom }, 0.5);
        ps.tweens.tween(ps.cams.hud, { zoom: 1 }, 0.5);
      }
    }
    if (ps.prefs.flashing) {
      this.white.alpha = 0.4;
      ps.tweens.tween(this.white, { alpha: 0.5 }, 0.075);
      ps.tweens.tween(this.white, { alpha: 0 }, 0.25, { delay: 0.15 });
    }
  }
}

// =============================================================== Philly
const PHILLY_COLORS = [0x31A2FD, 0x31FD8C, 0xFB33F5, 0xFD4531, 0xFBA633];

class GlowParticle extends BG {
  life = rnd(0.6, 0.9); decay = rnd(0.8, 1); origScale = rnd(0.75, 1);
  constructor(x: number, y: number, col: number, flashing: boolean) {
    super(x, y); this.color = col;
    if (!flashing) { this.decay *= 0.5; this.alpha = 0.5; }
    this.scale.x = this.scale.y = this.origScale;
    this.scrollFactor.x = rnd(0.3, 0.75); this.scrollFactor.y = rnd(0.65, 0.75);
    this.velocity.x = rnd(-40, 40); this.velocity.y = rnd(-175, -250);
    this.acceleration.x = rnd(-10, 10); this.acceleration.y = 25;
  }
  update(dt: number) {
    this.life -= dt;
    if (this.life < 0) {
      this.life = 0; this.alpha -= this.decay * dt;
      if (this.alpha > 0) this.scale.x = this.scale.y = this.origScale * this.alpha;
    }
    super.update(dt);
  }
}
class GlowGradient extends BG {
  originalY = 0; originalHeight = 400; intendedAlpha = 1;
  update(dt: number) {
    const nh = Math.round(this.height - 1000 * dt);
    if (nh > 0) { this.alpha = this.intendedAlpha; this.setGraphicSize(2000, nh); this.updateHitbox(); this.y = this.originalY + (this.originalHeight - this.height); }
    else { this.alpha = 0; this.y = -5000; }
    super.update(dt);
  }
  bop() { this.setGraphicSize(2000, this.originalHeight); this.updateHitbox(); this.y = this.originalY; this.alpha = this.intendedAlpha; }
}

class Philly extends StageImpl {
  window!: BG; street!: BG; train!: BG;
  curLight = -1; curLightEvent = -1;
  black?: BG; windowEvent?: BG; gradient?: GlowGradient; particles = new Group();
  // tren
  trainSound: Track | null = null;
  moving = false; finishing = false; startedMoving = false; frameTiming = 0; cars = 8; cooldown = 0;

  async create() {
    if (!this.low) this.add(await this.bg('philly/sky', -100, 0, 0.1, 0.1));
    const city = (await this.bg('philly/city', -10, 0, 0.3, 0.3)).scaleBy(0.85); this.add(city);
    this.window = (await this.bg('philly/window', city.x, city.y, 0.3, 0.3)).scaleBy(0.85); this.window.alpha = 0; this.add(this.window);
    if (!this.low) this.add(await this.bg('philly/behindTrain', -40, 50));
    this.train = await this.bg('philly/train', 2000, 360); this.add(this.train);
    this.trainSound = this.ps.e.audio.track(await this.a.sound('train_passes'));
    this.street = await this.bg('philly/street', -40, 50); this.add(this.street);
  }
  async eventPushed(ev: EventNote) {
    if (ev.event !== 'Philly Glow' || this.black) return;
    this.black = solid(W * 2, H * 2, 0x000000, W * -0.5, H * -0.5, 1); this.black.visible = false;
    this.insertBefore(this.black, this.street);
    this.windowEvent = (await this.bg('philly/window', this.window.x, this.window.y, 0.3, 0.3)).scaleBy(0.85); this.windowEvent.visible = false;
    this.insertAfter(this.windowEvent, this.black);
    this.gradient = new GlowGradient(-400, 225);
    const g = await this.a.image('philly/gradient'); if (g) this.gradient.setAtlas(g);
    this.gradient.scrollFactor.x = 0; this.gradient.scrollFactor.y = 0.75;
    this.gradient.originalY = 225; this.gradient.setGraphicSize(2000, 400); this.gradient.updateHitbox();
    this.gradient.visible = false; if (!this.ps.prefs.flashing) this.gradient.intendedAlpha = 0.7;
    this.insertAfter(this.gradient, this.black);
    await this.a.image('philly/particle');
    this.particles.visible = false;
    this.insertAfter(this.particles, this.gradient);
  }
  update(dt: number) {
    const ps = this.ps;
    this.window.alpha = Math.max(0, this.window.alpha - (ps.crochet / 1000) * dt * 1.5);
    this.particles.items = this.particles.items.filter(p => p.alpha > 0);
    // tren
    if (this.moving) {
      this.frameTiming += dt;
      if (this.frameTiming >= 1 / 24) {
        if ((this.trainSound?.time ?? 0) * 1000 >= 4700) {
          this.startedMoving = true;
          if (ps.gf) { ps.gf.playAnim('hairBlow'); ps.gf.specialAnim = true; }
        }
        if (this.startedMoving) {
          this.train.x -= 400;
          if (this.train.x < -2000 && !this.finishing) { this.train.x = -1150; this.cars -= 1; if (this.cars <= 0) this.finishing = true; }
          if (this.train.x < -4000 && this.finishing) this.restartTrain();
        }
        this.frameTiming = 0;
      }
    }
  }
  restartTrain() {
    const gf = this.ps.gf;
    if (gf) { gf.danced = false; gf.playAnim('hairFall'); gf.specialAnim = true; }
    this.train.x = W + 200; this.moving = false; this.cars = 8; this.finishing = false; this.startedMoving = false;
  }
  beatHit(beat: number) {
    if (!this.moving) this.cooldown++;
    if (beat % 8 === 4 && chance(30) && !this.moving && this.cooldown > 8) {
      this.cooldown = rndInt(-4, 0);
      this.moving = true;
      if (this.trainSound && !this.trainSound.playing) this.trainSound.play(0);
    }
    if (beat % 4 === 0) {
      this.curLight = rndInt(0, PHILLY_COLORS.length - 1, [this.curLight]);
      this.window.color = PHILLY_COLORS[this.curLight]; this.window.alpha = 1;
    }
  }
  private doFlash() {
    this.ps.cams.game.flash(0xffffff, 0.15);
  }
  eventCalled(name: string, _v1: string, _v2: string, f1: number) {
    if (name !== 'Philly Glow' || !this.black || !this.gradient || !this.windowEvent) return;
    const ps = this.ps, id = Math.round(isNaN(f1) || f1 <= 0 ? 0 : f1);
    const chars = [ps.boyfriend, ps.gf, ps.dad];
    if (id === 0) {
      if (this.gradient.visible) {
        this.doFlash();
        if (ps.prefs.camZooms) { ps.cams.game.zoom += 0.5; ps.cams.hud.zoom += 0.1; }
        this.black.visible = this.windowEvent.visible = this.gradient.visible = this.particles.visible = false;
        this.curLightEvent = -1;
        for (const c of chars) if (c) c.color = 0xffffff;
        this.street.color = 0xffffff;
      }
    } else if (id === 1) {
      this.curLightEvent = rndInt(0, PHILLY_COLORS.length - 1, [this.curLightEvent]);
      const color = PHILLY_COLORS[this.curLightEvent];
      if (!this.gradient.visible) {
        this.doFlash();
        if (ps.prefs.camZooms) { ps.cams.game.zoom += 0.5; ps.cams.hud.zoom += 0.1; }
        this.black.visible = true; this.black.alpha = 1; this.windowEvent.visible = this.gradient.visible = this.particles.visible = true;
      } else if (ps.prefs.flashing) {
        ps.cams.game.flash(color, 0.5);
      }
      const [h, s, v] = rgbToHsv(color);
      const charColor = hsvToRgb(h, Math.min(1, s * (ps.prefs.flashing ? 0.75 : 0.5)), v);
      for (const c of chars) if (c) c.color = charColor;
      for (const p of this.particles.items) p.color = color;
      this.gradient.color = color; this.windowEvent.color = color;
      this.street.color = hsvToRgb(h, s, v * 0.5);
    } else if (id === 2) {
      if (!this.low && this.curLightEvent >= 0) {
        const n = rndInt(8, 12), w = 2000 / n, color = PHILLY_COLORS[this.curLightEvent];
        for (let j = 0; j < 3; j++) for (let i = 0; i < n; i++) {
          const p = new GlowParticle(-400 + w * i + rnd(-w / 5, w / 5), this.gradient.originalY + 200 + rnd(0, 125) + j * 40, color, ps.prefs.flashing);
          const at = this.a.peekImage('philly/particle'); if (at) p.setAtlas(at);
          p.color = color; p.scale.x = p.scale.y = p.origScale; this.particles.items.push(p);
        }
      }
      this.gradient.bop();
    }
  }
  destroy() { this.trainSound?.destroy(); }
}

// =============================================================== Limo
class Dancer extends BG {
  dir = false;
  static async mk(ps: PlayState, x: number, y: number) {
    const d = new Dancer(x, y);
    const at = await ps.e.assets.atlas('limo/limoDancer'); if (at) d.setAtlas(at);
    d.addByIndices('danceLeft', 'bg dancer sketch PINK', [...Array(15).keys()], '', 24, false);
    d.addByIndices('danceRight', 'bg dancer sketch PINK', [...Array(15).keys()].map(i => i + 15), '', 24, false);
    d.play('danceLeft'); d.antialiasing = ps.prefs.antialiasing; return d;
  }
  dancing() { this.dir = !this.dir; this.play(this.dir ? 'danceRight' : 'danceLeft', true); }
}

class Limo extends StageImpl {
  dancers: Dancer[] = [];
  fastCar!: BG; canDrive = true; carTimer: ReturnType<PlayState['tweens']['timer']> | null = null;
  pole?: BG; light?: BG; corpse?: BG; corpse2?: BG; bgLimo?: BG; particles: BG[] = [];
  state: 'wait' | 'killing' | 'speedingOff' | 'speeding' | 'stopping' = 'wait';
  limoSpeed = 0; dancersDiff = 320;
  defaultGF = 'gf-car';

  async create() {
    this.add(await this.bg('limo/limoSunset', -120, -50, 0.1, 0.1));
    if (!this.low) {
      this.pole = await this.bg('gore/metalPole', -500, 220, 0.4, 0.4); this.add(this.pole);
      this.bgLimo = await this.bg('limo/bgLimo', -150, 480, 0.4, 0.4, ['background limo pink'], true); this.add(this.bgLimo);
      this.corpse = await this.bg('gore/noooooo', -500, this.pole.y - 130, 0.4, 0.4, ['Henchmen on rail'], true); this.add(this.corpse);
      this.corpse2 = await this.bg('gore/noooooo', -500, this.pole.y, 0.4, 0.4, ['henchmen death'], true); this.add(this.corpse2);
      for (let i = 0; i < 5; i++) {
        const d = await Dancer.mk(this.ps, 370 * i + this.dancersDiff + this.bgLimo.x, this.bgLimo.y - 400);
        d.scrollFactor.x = d.scrollFactor.y = 0.4; this.dancers.push(d); this.add(d);
      }
      this.light = await this.bg('gore/coldHeartKiller', this.pole.x - 180, this.pole.y - 80, 0.4, 0.4); this.add(this.light);
      this.resetKill();
      void this.a.sound('dancerdeath');
    }
    this.fastCar = await this.bg('limo/fastCarLol', -300, 160);
  }
  async createPost() {
    this.resetFastCar();
    this.addBehindGF(this.fastCar);
    void this.bg('limo/limoDrive', -120, 550, 1, 1, ['Limo stage'], true).then(l => { this.ps.layerBack.push(l); });
  }
  resetKill() {
    for (const s of [this.pole, this.light, this.corpse, this.corpse2]) if (s) { s.x = -500; s.visible = false; }
  }
  resetFastCar() {
    this.fastCar.x = -12600; this.fastCar.y = rndInt(140, 250); this.fastCar.velocity.x = 0; this.canDrive = true;
  }
  fastCarDrive() {
    this.sound('carPass' + rndInt(0, 1), 0.7);
    this.fastCar.velocity.x = (rndInt(170, 220) / (1 / 60)) * 3;
    this.canDrive = false;
    this.carTimer = this.ps.tweens.timer(2, 1, () => { this.resetFastCar(); this.carTimer = null; });
  }
  async spawnGore(img: string, x: number, y: number, anim: string, extra?: (s: BG) => void) {
    const p = await this.bg(img, x, y, 0.4, 0.4, [anim], false);
    extra?.(p); this.particles.push(p); this.ps.layerBack.push(p);
  }
  dancersParenting() { this.dancers.forEach((d, i) => { d.x = 370 * i + this.dancersDiff + this.bgLimo!.x; }); }
  beatHit() {
    if (!this.low) for (const d of this.dancers) d.dancing();
    if (chance(10) && this.canDrive) this.fastCarDrive();
  }
  eventCalled(name: string) {
    if (name !== 'Kill Henchmen' || this.low || this.state !== 'wait' || !this.pole) return;
    this.pole.x = -400; this.pole.visible = true; this.light!.visible = true; this.corpse!.visible = false; this.corpse2!.visible = false;
    this.state = 'killing';
  }
  update(dt: number) {
    if (this.low || !this.pole || !this.bgLimo) return;
    for (const p of [...this.particles]) if (p.finished) { this.ps.removeDrawable(p); this.particles.splice(this.particles.indexOf(p), 1); }
    switch (this.state) {
      case 'killing': {
        this.pole.x += 5000 * dt;
        this.light!.x = this.pole.x - 180; this.corpse!.x = this.light!.x - 50; this.corpse2!.x = this.light!.x + 35;
        this.dancers.forEach((d, i) => {
          if (d.x < W * 1.5 && this.light!.x > 370 * i + 170) {
            if (i === 0 || i === 3) {
              if (i === 0) this.sound('dancerdeath', 0.5);
              const diff = i === 3 ? ' 2 ' : ' ';
              void this.spawnGore('gore/noooooo', d.x + 200, d.y, 'hench leg spin' + diff + 'PINK');
              void this.spawnGore('gore/noooooo', d.x + 160, d.y + 200, 'hench arm spin' + diff + 'PINK');
              void this.spawnGore('gore/noooooo', d.x, d.y + 50, 'hench head spin' + diff + 'PINK');
              void this.spawnGore('gore/stupidBlood', d.x - 110, d.y + 20, 'blood', s => { s.flipX = true; s.angle = -57.5; });
            } else if (i === 1) this.corpse!.visible = true; else if (i === 2) this.corpse2!.visible = true;
            d.x += W * 2;
          }
        });
        if (this.pole.x > W * 2) { this.resetKill(); this.limoSpeed = 800; this.state = 'speedingOff'; }
        break;
      }
      case 'speedingOff':
        this.limoSpeed -= 4000 * dt; this.bgLimo.x -= this.limoSpeed * dt;
        if (this.bgLimo.x > W * 1.5) { this.limoSpeed = 3000; this.state = 'speeding'; }
        break;
      case 'speeding':
        this.limoSpeed = Math.max(1000, this.limoSpeed - 2000 * dt); this.bgLimo.x -= this.limoSpeed * dt;
        if (this.bgLimo.x < -275) { this.state = 'stopping'; this.limoSpeed = 800; }
        this.dancersParenting(); break;
      case 'stopping':
        this.bgLimo.x = -150 + (this.bgLimo.x + 150) * Math.exp(-dt * 9);
        if (Math.round(this.bgLimo.x) === -150) { this.bgLimo.x = -150; this.state = 'wait'; }
        this.dancersParenting(); break;
    }
  }
}

// =============================================================== Mall
class Mall extends StageImpl {
  upper?: BG; bottom!: BG; santa!: BG; heyTimer = 0;
  defaultGF = 'gf-christmas';
  async create() {
    this.add((await this.bg('christmas/bgWalls', -1000, -500, 0.2, 0.2)).scaleBy(0.8));
    if (!this.low) {
      this.upper = (await this.bg('christmas/upperBop', -240, -90, 0.33, 0.33, ['Upper Crowd Bob'])).scaleBy(0.85); this.add(this.upper);
      this.add((await this.bg('christmas/bgEscalator', -1100, -600, 0.3, 0.3)).scaleBy(0.9));
    }
    this.add(await this.bg('christmas/christmasTree', 370, -250, 0.4, 0.4));
    this.bottom = await this.bg('christmas/bottomBop', -300, 140, 0.9, 0.9, ['Bottom Level Boppers Idle']);
    this.bottom.addByPrefix('hey', 'Bottom Level Boppers HEY', 24, false); this.add(this.bottom);
    this.add(await this.bg('christmas/fgSnow', -600, 700));
    this.santa = await this.bg('christmas/santa', -840, 150, 1, 1, ['santa idle in fear']); this.add(this.santa);
    void this.a.sound('Lights_Shut_off');
  }
  everyoneDance() {
    if (!this.low) this.upper?.dance(true);
    if (this.heyTimer <= 0) this.bottom.dance(true);
    this.santa.dance(true);
  }
  countdownTick() { this.everyoneDance(); }
  beatHit() { this.everyoneDance(); }
  update(dt: number) { if (this.heyTimer > 0) { this.heyTimer -= dt; if (this.heyTimer <= 0) { this.heyTimer = 0; this.bottom.dance(true); } } }
  eventCalled(name: string, v1: string, _v2: string, _f1: number, f2: number) {
    if (name !== 'Hey!') return;
    if (['bf', 'boyfriend', '0'].includes(v1.toLowerCase().trim())) return;
    this.bottom.play('hey', true); this.heyTimer = isNaN(f2) ? 0.6 : f2;
  }
}

class MallEvil extends StageImpl {
  defaultGF = 'gf-christmas';
  async create() {
    this.add((await this.bg('christmas/evilBG', -400, -500, 0.2, 0.2)).scaleBy(0.8));
    this.add(await this.bg('christmas/evilTree', 300, -300, 0.2, 0.2));
    this.add(await this.bg('christmas/evilSnow', -200, 700));
  }
}

// =============================================================== Escuela (pixel)
const PX = 6;
class School extends StageImpl {
  defaultGF = 'gf-pixel';
  girls?: BG; isPissed = true; dir = false;
  async create() {
    const ps = this.ps;
    ps.pixelGameOver();
    const sky = await this.bg('weeb/weebSky', 0, 0, 0.1, 0.1); sky.antialiasing = false; this.add(sky);
    const rep = -200;
    const school = await this.bg('weeb/weebSchool', rep, 0, 0.6, 0.9); school.antialiasing = false; this.add(school);
    const street = await this.bg('weeb/weebStreet', rep, 0, 0.95, 0.95); street.antialiasing = false; this.add(street);
    const wid = Math.floor(sky.width * PX);
    if (!this.low) {
      const ft = await this.bg('weeb/weebTreesBack', rep + 170, 130, 0.9, 0.9); ft.setGraphicSize(Math.floor(wid * 0.8)); ft.updateHitbox(); ft.antialiasing = false; this.add(ft);
    }
    const trees = new BG(rep - 380, -800);
    const ta = await this.a.atlas('weeb/weebTrees'); if (ta) trees.setAtlas(ta);
    trees.addByFrames('treeLoop', [...Array(19).keys()], 12, true); trees.play('treeLoop');
    trees.scrollFactor.x = trees.scrollFactor.y = 0.85; trees.antialiasing = false; this.add(trees);
    if (!this.low) {
      const leaves = await this.bg('weeb/petals', rep, -40, 0.85, 0.85, ['PETALS ALL'], true);
      leaves.setGraphicSize(wid); leaves.updateHitbox(); leaves.antialiasing = false; this.add(leaves);
    }
    for (const s of [sky, school, street]) { s.setGraphicSize(wid); s.updateHitbox(); }
    trees.setGraphicSize(Math.floor(wid * 1.4)); trees.updateHitbox();
    if (!this.low) {
      const g = new BG(-100, 190); const at = await this.a.atlas('weeb/bgFreaks'); if (at) g.setAtlas(at);
      g.antialiasing = false; g.scrollFactor.x = g.scrollFactor.y = 0.9; this.girls = g;
      g.scale.x = g.scale.y = PX; g.updateHitbox();
      this.swapDance(); g.play('danceLeft'); this.add(g);
    }
  }
  swapDance() {
    const g = this.girls; if (!g) return;
    this.isPissed = !this.isPissed;
    const pre = this.isPissed ? 'BG fangirls dissuaded' : 'BG girls group';
    g.addByIndices('danceLeft', pre, [...Array(15).keys()], '', 24, false);
    g.addByIndices('danceRight', pre, [...Array(16).keys()].map(i => i + 15), '', 24, false);
    this.dance();
  }
  dance() { if (!this.girls) return; this.dir = !this.dir; this.girls.play(this.dir ? 'danceRight' : 'danceLeft', true); }
  beatHit() { this.dance(); }
  eventCalled(name: string) { if (name === 'BG Freaks Expression') this.swapDance(); }
}

/** Estela de FlxTrail: copias semitransparentes del personaje. */
class Trail implements Drawable {
  camera = 'game'; visible = true;
  private snaps: { x: number; y: number; ox: number; oy: number; frame: any; fx: boolean }[] = [];
  private frames = 0;
  constructor(private target: Character, private length = 4, private delay = 24, private alpha = 0.3, private diff = 0.069) {}
  update() {
    this.frames++;
    if (this.frames >= this.delay) {
      this.frames = 0;
      const t = this.target;
      this.snaps.unshift({ x: t.x, y: t.y, ox: t.offset.x, oy: t.offset.y, frame: t.currentFrame(), fx: t.flipX });
      if (this.snaps.length > this.length) this.snaps.pop();
    }
  }
  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    const t = this.target;
    if (!t.atlas) return;
    this.snaps.forEach((s, i) => {
      const f = s.frame; if (!f) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, (this.alpha - this.diff * i)) * t.alpha * cam.alpha;
      const px = s.x - s.ox - cam.scroll.x * t.scrollFactor.x, py = s.y - s.oy - cam.scroll.y * t.scrollFactor.y;
      ctx.translate(px + t.origin.x, py + t.origin.y);
      ctx.scale(t.scale.x * (s.fx ? -1 : 1), t.scale.y);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(t.atlas!.tinted(t.color) as any, f.x, f.y, f.w, f.h, -t.origin.x - f.fx, -t.origin.y - f.fy, f.w, f.h);
      ctx.restore();
    });
  }
}

class SchoolEvil extends StageImpl {
  defaultGF = 'gf-pixel';
  ghouls?: BG;
  async create() {
    this.ps.pixelGameOver();
    const bg = this.low ? await this.bg('weeb/animatedEvilSchool_low', 400, 200, 0.8, 0.9)
      : await this.bg('weeb/animatedEvilSchool', 400, 200, 0.8, 0.9, ['background 2'], true);
    bg.scale.x = bg.scale.y = PX; bg.antialiasing = false; this.add(bg);
  }
  createPost() { this.addBehindDad(new Trail(this.ps.dad)); }
  async eventPushed(ev: EventNote) {
    if (ev.event !== 'Trigger BG Ghouls' || this.low || this.ghouls) return;
    const g = await this.bg('weeb/bgGhouls', -100, 190, 0.9, 0.9, ['BG freaks glitch instance'], false);
    g.scaleBy(PX); g.visible = false; g.antialiasing = false;
    g.onAnimFinish = n => { if (n === 'BG freaks glitch instance') g.visible = false; };
    this.ghouls = g; this.addBehindGF(g);
  }
  eventCalled(name: string) {
    if (name === 'Trigger BG Ghouls' && !this.low && this.ghouls) { this.ghouls.dance(true); this.ghouls.visible = true; }
  }
}

// =============================================================== Tank
class TankmenBG extends Sprite {
  strumTime = 0; tankSpeed = 0.7; endingOffset = 0; goingRight = false; dead = false;
  static async mk(ps: PlayState, x: number, y: number, right: boolean) {
    const t = new TankmenBG(x, y); t.goingRight = right;
    const at = await ps.e.assets.atlas('tankmanKilled1'); if (at) t.setAtlas(at);
    t.addByPrefix('run', 'tankman running', 24, true);
    t.addByPrefix('shot', 'John Shot ' + rndInt(1, 2), 24, false);
    t.play('run'); if (t.cur) t.curFrame = rndInt(0, t.cur.frames.length - 1);
    t.antialiasing = ps.prefs.antialiasing; t.scale.x = t.scale.y = 0.8; t.updateHitbox();
    return t;
  }
  reset(x: number, y: number, right: boolean) {
    this.x = x; this.y = y; this.goingRight = right; this.endingOffset = rnd(50, 200); this.tankSpeed = rnd(0.6, 1); this.flipX = right;
  }
  tick(pos: number) {
    this.visible = this.x > -0.5 * W && this.x < 1.2 * W;
    if (this.animName === 'run') {
      const speed = (pos - this.strumTime) * this.tankSpeed;
      this.x = this.goingRight ? (0.02 * W - this.endingOffset) + speed : (0.74 * W + this.endingOffset) - speed;
    } else if (this.finished) this.dead = true;
    if (pos > this.strumTime && this.animName !== 'shot') {
      this.play('shot');
      if (this.goingRight) { this.offset.x = 300; this.offset.y = 200; }
    }
  }
}

class Tank extends StageImpl {
  tower?: BG; ground!: BG; fg: BG[] = []; men: TankmenBG[] = [];
  tankAngle = rnd(-90, 45); tankSpeed = rnd(5, 7); rolling!: BG;
  get defaultGF0() { return this.ps.songName === 'stress' ? 'pico-speaker' : 'gf-tankmen'; }
  constructor(ps: PlayState) { super(ps); this.defaultGF = ps.songName === 'stress' ? 'pico-speaker' : 'gf-tankmen'; }
  async create() {
    this.add(await this.bg('tankSky', -400, -400, 0, 0));
    if (!this.low) {
      const clouds = await this.bg('tankClouds', rndInt(-700, -100), rndInt(-20, 20), 0.1, 0.1); clouds.velocity.x = rnd(5, 15); this.add(clouds);
      this.add((await this.bg('tankMountains', -300, -20, 0.2, 0.2)).scaleBy(1.2));
      this.add((await this.bg('tankBuildings', -200, 0, 0.3, 0.3)).scaleBy(1.1));
    }
    this.add((await this.bg('tankRuins', -200, 0, 0.35, 0.35)).scaleBy(1.1));
    if (!this.low) {
      this.add(await this.bg('smokeLeft', -200, -100, 0.4, 0.4, ['SmokeBlurLeft'], true));
      this.add(await this.bg('smokeRight', 1100, -100, 0.4, 0.4, ['SmokeRight'], true));
      this.tower = await this.bg('tankWatchtower', 100, 50, 0.5, 0.5, ['watchtower gradient color']); this.add(this.tower);
    }
    this.rolling = await this.bg('tankRolling', 0, 0, 0.5, 0.5, ['BG tank w lighting'], true); this.add(this.rolling);
    this.add((await this.bg('tankGround', -420, -150)).scaleBy(1.15));
    const mk = async (img: string, x: number, y: number, sx: number, sy: number, an: string) => { const s = await this.bg(img, x, y, sx, sy, [an]); this.fg.push(s); };
    await mk('tank0', -500, 650, 1.7, 1.5, 'fg');
    if (!this.low) await mk('tank1', -300, 750, 2, 0.2, 'fg');
    await mk('tank2', 450, 940, 1.5, 1.5, 'foreground');
    if (!this.low) await mk('tank4', 1300, 900, 1.5, 1.5, 'fg');
    await mk('tank5', 1620, 700, 1.5, 1.5, 'fg');
    if (!this.low) await mk('tank3', 1300, 1200, 3.5, 2.5, 'fg');
  }
  async createPost() {
    for (const s of this.fg) this.ps.layerFront.push(s);
    const gf = this.ps.gf;
    if (!this.low && gf && gf.curCharacter === 'pico-speaker') {
      for (const n of gf.animationNotes) {
        if (chance(16)) {
          const t = await TankmenBG.mk(this.ps, 500, 200 + rndInt(50, 100), n[1] < 2);
          t.strumTime = n[0]; t.reset(500, 200 + rndInt(50, 100), n[1] < 2);
          this.men.push(t); this.ps.layerBack.push(t);
        }
      }
    }
  }
  everyoneDance() { if (!this.low) this.tower?.dance(); for (const s of this.fg) s.dance(); }
  countdownTick(n: number) { if (n % 2 === 0) this.everyoneDance(); }
  beatHit() { this.everyoneDance(); }
  update(dt: number) {
    this.tankAngle += dt * this.tankSpeed;
    const r = this.rolling;
    r.angle = this.tankAngle - 90 + 15;
    r.x = 400 + 1500 * Math.cos(Math.PI / 180 * (this.tankAngle + 180));
    r.y = 1300 + 1100 * Math.sin(Math.PI / 180 * (this.tankAngle + 180));
    const pos = this.ps.cond.songPosition;
    for (const t of [...this.men]) { t.tick(pos); if (t.dead) { this.ps.removeDrawable(t); this.men.splice(this.men.indexOf(t), 1); } }
  }
}

// ---------------------------------------------------------------
export function createStageImpl(ps: PlayState): StageImpl | null {
  switch (ps.stageName) {
    case 'stage': return new StageWeek1(ps);
    case 'spooky': return new Spooky(ps);
    case 'philly': return new Philly(ps);
    case 'limo': return new Limo(ps);
    case 'mall': return new Mall(ps);
    case 'mallEvil': return new MallEvil(ps);
    case 'school': return new School(ps);
    case 'schoolEvil': return new SchoolEvil(ps);
    case 'tank': return new Tank(ps);
  }
  return null;
}
