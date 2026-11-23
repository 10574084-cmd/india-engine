import { Assets } from '../engine/assets';
import { Atlas, Camera, Drawable, Sprite, Src, rgb } from '../engine/display';

/** Barra (vida / tiempo): relleno de dos colores bajo la imagen del marco, como Bar.hx de Psych. */
export class Bar implements Drawable {
  x = 0; y = 0; alpha = 1; visible = true; camera = 'hud';
  leftToRight = true;
  leftColor = 0xff0000; rightColor = 0x66ff33;
  value = 1; min = 0; max = 2;
  scale = { x: 1, y: 1 };
  scrollFactor = { x: 0, y: 0 };
  width = 0; height = 0;
  private img: Src | null = null;
  constructor(public atlas: Atlas | null, x: number, y: number) {
    this.x = x; this.y = y;
    if (atlas) { this.img = atlas.img; this.width = atlas.frames[0].w; this.height = atlas.frames[0].h; }
    else { this.width = 601; this.height = 19; }
  }
  get percent() { return ((this.value - this.min) / (this.max - this.min)) * 100; }
  get barWidth() { return this.width - 8; }
  screenCenterX() { this.x = (1280 - this.width) / 2; }
  setColors(l: number, r: number) { this.leftColor = l; this.rightColor = r; }
  update() {}
  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    if (!this.visible || this.alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = this.alpha * cam.alpha;
    const bw = this.barWidth, bh = this.height - 8, bx = this.x + 4, by = this.y + 4;
    const p = Math.min(100, Math.max(0, this.percent)) / 100;
    const fillW = bw * p;
    // leftToRight=true: left=barra "llena"; false: la parte llena crece desde la derecha
    if (this.leftToRight) {
      ctx.fillStyle = rgb(this.leftColor); ctx.fillRect(bx, by, fillW, bh);
      ctx.fillStyle = rgb(this.rightColor); ctx.fillRect(bx + fillW, by, bw - fillW, bh);
    } else {
      ctx.fillStyle = rgb(this.leftColor); ctx.fillRect(bx, by, bw - fillW, bh);
      ctx.fillStyle = rgb(this.rightColor); ctx.fillRect(bx + bw - fillW, by, fillW, bh);
    }
    if (this.img) ctx.drawImage(this.img as any, this.x, this.y);
    ctx.restore();
  }
}

/** Icono de vida (2 o 3 frames cuadrados). */
export class HealthIcon extends Sprite {
  char = '';
  isPlayer: boolean;
  constructor(public assets: Assets, public name: string, isPlayer: boolean, atlas: Atlas | null) {
    super();
    this.isPlayer = isPlayer; this.camera = 'hud';
    this.setIcon(name, atlas);
  }
  setIcon(name: string, atlas: Atlas | null) {
    this.name = name; this.char = name;
    if (!atlas) { this.visible = false; return; }
    this.visible = true;
    const img = atlas.img, w = (img as any).width, h = (img as any).height;
    const frames = Math.max(1, Math.round(w / h));
    const g = Atlas.grid(img, Math.floor(w / frames), h);
    this.setAtlas(g);
    this.addByFrames('idle', [0], 0, false);
    this.play('idle');
    this.flipX = this.isPlayer;
    this.scrollFactor.x = this.scrollFactor.y = 0;
    this.width = this.frameWidth; this.height = this.frameHeight;
    this.antialiasing = !/-pixel$/.test(name);
  }
  setFrame(i: number) { this.staticFrame = Math.min(i, (this.atlas?.frames.length ?? 1) - 1); this.curFrame = this.staticFrame; this.cur = null; }
  get frameCount() { return this.atlas?.frames.length ?? 1; }
}

/** Busca el icono con las mismas reglas que HealthIcon.hx. */
export async function loadIconAtlas(assets: Assets, name: string): Promise<Atlas | null> {
  let n = 'icons/' + name;
  if (!assets.exists(`images/${n}.png`)) n = 'icons/icon-' + name;
  if (!assets.exists(`images/${n}.png`)) n = 'icons/icon-face';
  return assets.image(n);
}
