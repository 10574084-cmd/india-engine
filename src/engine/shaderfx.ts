/** Efectos de shader emulados en Canvas2D (por píxel, con caché por frame). */
export interface ShaderFx { name: string; params: Record<string, any>; cache: WeakMap<object, Map<string, HTMLCanvasElement>>; apply(d: Uint8ClampedArray): void }

const GRAY = [0.3098039215686275, 0.607843137254902, 0.0823529411764706];
const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;

function adjustColor(p: Record<string, any>) {
  const hue = +p.hue || 0, sat = +p.saturation || 0, bri = +p.brightness || 0, con = +p.contrast || 0;
  const a = hue * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // columnas de mat3 de GLSL
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.213 - c * 0.213 + s * 0.143, 0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 - s * 0.715, 0.715 + c * 0.285 + s * 0.140, 0.715 - c * 0.715 + s * 0.715,
    0.072 - c * 0.072 + s * 0.928, 0.072 - c * 0.072 - s * 0.283, 0.072 + c * 0.928 + s * 0.072,
  ];
  let cv = 1 + con / 100;
  if (cv > 1) cv = ((0.00852259 * Math.exp(4.76454 * (cv - 1))) * 1.01 - 0.0086078159) * 10 + 1;
  let sv = sat; if (sv > 0) sv *= 3; sv = 1 + sv / 100;
  const add = bri / 255;
  return (d: Uint8ClampedArray) => {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      let r = d[i] / 255 + add, g = d[i + 1] / 255 + add, b = d[i + 2] / 255 + add;
      const r2 = m[0] * r + m[3] * g + m[6] * b, g2 = m[1] * r + m[4] * g + m[7] * b, b2 = m[2] * r + m[5] * g + m[8] * b;
      r = clamp01((r2 - 0.25) * cv + 0.25); g = clamp01((g2 - 0.25) * cv + 0.25); b = clamp01((b2 - 0.25) * cv + 0.25);
      const gr = r * GRAY[0] + g * GRAY[1] + b * GRAY[2];
      d[i] = clamp01(gr + (r - gr) * sv) * 255; d[i + 1] = clamp01(gr + (g - gr) * sv) * 255; d[i + 2] = clamp01(gr + (b - gr) * sv) * 255;
    }
  };
}

export const SUPPORTED_SHADERS = new Set(['adjustColor']);

export function makeFx(name: string, params: Record<string, any>): ShaderFx | null {
  if (name === 'adjustColor') return { name, params, cache: new WeakMap(), apply: adjustColor(params) };
  return null;
}

/** devuelve el recorte del frame con el efecto aplicado (cacheado) */
export function fxFrame(fx: ShaderFx, src: CanvasImageSource & object, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  let m = fx.cache.get(src); if (!m) { m = new Map(); fx.cache.set(src, m); }
  const k = x + ',' + y + ',' + w + ',' + h;
  let c = m.get(k);
  if (!c) {
    c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(src as any, x, y, w, h, 0, 0, w, h);
    const id = g.getImageData(0, 0, c.width, c.height); fx.apply(id.data); g.putImageData(id, 0, 0);
    m.set(k, c);
  }
  return c;
}
