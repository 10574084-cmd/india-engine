import { Camera, Sprite, W, H } from '../engine/display';
import type { Engine } from '../engine/engine';

const EXTS = ['mp4', 'webm', 'ogv', 'mov', 'm4v'];

/** Busca videos/<nombre>.<ext> en los mods y en los assets. */
export function resolveVideo(e: Engine, name: string): string | null {
  const n = name.replace(/\.(mp4|webm|ogv|mov|m4v)$/i, '');
  for (const ext of EXTS) { const p = e.assets.resolve(`videos/${n}.${ext}`); if (p) return p; }
  return null;
}

/**
 * Video pintado en el canvas. Es un Sprite para que las rutas de Lua (x, y, scale, alpha,
 * camera…) funcionen igual que con cualquier otro sprite.
 */
export class VideoSprite extends Sprite {
  video: HTMLVideoElement;
  ended = false; failed = false;
  fullscreen = false;
  onEnd?: () => void;
  private url = '';
  private started = false;
  constructor(private e: Engine, path: string, loop = false) {
    super(0, 0);
    const v = document.createElement('video');
    v.playsInline = true; v.preload = 'auto'; v.loop = loop;
    v.volume = Math.min(1, Math.max(0, e.prefs.volume));
    this.video = v;
    v.addEventListener('loadedmetadata', () => { this.width = v.videoWidth; this.height = v.videoHeight; });
    v.addEventListener('ended', () => { if (!loop) this.finish(); });
    v.addEventListener('error', () => { this.failed = true; console.warn('[video] no se pudo reproducir', path, v.error?.message); this.finish(); });
    void e.assets.vfs.blob(path, /\.webm$/i.test(path) ? 'video/webm' : 'video/mp4').then(b => {
      this.url = URL.createObjectURL(b); v.src = this.url;
      void v.play().then(() => { this.started = true; }).catch(err => { console.warn('[video] reproducción bloqueada', err); this.failed = true; this.finish(); });
    }).catch(() => { this.failed = true; this.finish(); });
  }
  get duration() { return this.video.duration || 0; }
  get time() { return this.video.currentTime; }
  finish() { if (this.ended) return; this.ended = true; this.onEnd?.(); }
  pause() { this.video.pause(); }
  resume() { void this.video.play().catch(() => {}); }
  setVolume(v: number) { this.video.volume = Math.min(1, Math.max(0, v)); }
  destroy() {
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
  }
  draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    const v = this.video;
    if (!this.visible || !this.started || v.readyState < 2 || !v.videoWidth) return;
    ctx.save();
    ctx.globalAlpha = this.alpha * cam.alpha;
    if (this.fullscreen) {
      const k = Math.min(W / v.videoWidth, H / v.videoHeight), w = v.videoWidth * k, h = v.videoHeight * k;
      ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      const w = v.videoWidth * this.scale.x, h = v.videoHeight * this.scale.y;
      const px = this.x - cam.scroll.x * this.scrollFactor.x, py = this.y - cam.scroll.y * this.scrollFactor.y;
      ctx.translate(px + w / 2, py + h / 2);
      if (this.angle) ctx.rotate(this.angle * Math.PI / 180);
      ctx.drawImage(v, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }
}
