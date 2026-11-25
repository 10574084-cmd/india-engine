import { Assets } from '../engine/assets';
import { Drawable, Sprite } from '../engine/display';
import { parseColor } from '../lua/host';
import type { PlayState } from './playstate';

export interface StageFile {
  directory: string; defaultZoom: number; isPixelStage?: boolean; stageUI?: string;
  boyfriend: number[]; girlfriend: number[]; opponent: number[]; hide_girlfriend: boolean;
  camera_boyfriend: number[]; camera_opponent: number[]; camera_girlfriend: number[]; camera_speed?: number;
  objects?: any[]; preload?: any;
}

export const defaultStage = (): StageFile => ({
  directory: '', defaultZoom: 0.9, isPixelStage: false, stageUI: 'normal',
  boyfriend: [770, 100], girlfriend: [400, 130], opponent: [100, 100], hide_girlfriend: false,
  camera_boyfriend: [0, 0], camera_opponent: [0, 0], camera_girlfriend: [0, 0], camera_speed: 1,
});

/** Busca el JSON del stage en mods, mods globales y assets (también data/stages y nombres con otra capitalización). */
export async function loadStageFile(assets: Assets, name: string): Promise<StageFile | null> {
  const n = String(name).replace(/\.json$/i, '');
  const j = (await assets.json<Partial<StageFile>>(`stages/${n}.json`))
    ?? (await assets.json<Partial<StageFile>>(`data/stages/${n}.json`))
    ?? (await assets.json<Partial<StageFile>>(`stages/${n.toLowerCase()}.json`))
    ?? (await assets.json<Partial<StageFile>>(`stages/${n.replace(/ /g, '-')}.json`));
  if (!j) return null;
  return { ...defaultStage(), ...j } as StageFile;
}

/**
 * Stage nativo. Solo el escenario "stage" de la semana 1 está portado a TypeScript.
 * Los demás escenarios vanilla (spooky, philly, limo, mall, school, tank) eran código Haxe;
 * los mods traen sus propios escenarios en Lua (stages/<nombre>.lua) que sí se ejecutan.
 */
export async function buildNativeStage(ps: PlayState) {
  if (ps.scripts.stageHandledByScript) return;
  if (ps.stage.objects && ps.stage.objects.length) { await buildStageObjects(ps, ps.stage.objects); return; }
  const a = ps.e.assets;
  const add = async (key: string, x: number, y: number, sf: number, scale = 1, flip = false, blend = '') => {
    const at = await a.image(key);
    if (!at) return null;
    const s = new Sprite(x, y).loadGraphic(at.img);
    s.scrollFactor.x = s.scrollFactor.y = sf;
    if (scale !== 1) { s.scale.x = s.scale.y = scale; s.updateHitbox(); }
    s.flipX = flip; s.blend = blend;
    ps.layerBack.push(s);
    return s;
  };
  if (!a.exists(`stages/${ps.stageName}.lua`)) {
    // Escenario vanilla no portado: fondo neutro para que sea jugable
    const bg = new Sprite(-600, -300).makeGraphic(3000, 1800, 0xff1b1b2a);
    bg.scrollFactor.x = bg.scrollFactor.y = 0.2;
    const floor = new Sprite(-600, 520).makeGraphic(3000, 800, 0xff2d2d44);
    ps.layerBack.push(bg, floor);
    ps.e.toast(`Escenario "${ps.stageName}" no portado aún: usando fondo neutro`, '#ffcc66', 6);
  }
}


// ---------------------------------------------------------------------------
// Objetos declarados en el JSON del stage (Psych 1.0): sprites, animados, cuadrados y marcadores de personaje
export interface StageLayout { back: Drawable[]; marks: { char: string; items: Drawable[] }[]; front: Drawable[] }

export async function buildStageObjects(ps: PlayState, objects: any[]): Promise<void> {
  const a = ps.e.assets, low = ps.prefs.lowQuality;
  const layout: StageLayout = { back: [], marks: [], front: [] };
  let cur: Drawable[] = layout.back;
  const charTypes = ['gf', 'girlfriend', 'dad', 'opponent', 'boyfriend', 'bf'];
  const pair = (v: any, d: number): [number, number] => Array.isArray(v) ? [Number(v[0] ?? d), Number(v[1] ?? v[0] ?? d)] : (typeof v === 'number' ? [v, v] : [d, d]);
  for (const o of objects ?? []) {
    if (!o || typeof o !== 'object') continue;
    const type = String(o.type ?? 'sprite').toLowerCase();
    if (charTypes.includes(type)) {
      const char = type === 'girlfriend' ? 'gf' : type === 'opponent' ? 'dad' : type === 'bf' ? 'boyfriend' : type;
      const m = { char, items: [] as Drawable[] }; layout.marks.push(m); cur = m.items; continue;
    }
    const f = String(o.filters ?? '').toLowerCase();
    if ((f === 'low_quality' && !low) || (f === 'high_quality' && low)) continue;
    const spr = new Sprite(Number(o.x ?? 0), Number(o.y ?? 0));
    const animated = type === 'animatedsprite' || type === 'animated' || (Array.isArray(o.animations) && o.animations.length > 0);
    if (type === 'square' || type === 'gradient' || (!o.image && (o.scale || o.width))) {
      const [w, h] = pair(o.scale ?? [o.width ?? 100, o.height ?? 100], 100);
      const col = type === 'gradient' && Array.isArray(o.colors) ? o.colors[0] : o.color;
      spr.makeGraphic(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), parseColor(col ?? 'FFFFFF'));
    } else if (o.image) {
      const at = animated ? await a.atlas(String(o.image)) : await a.image(String(o.image));
      if (!at) { console.warn('[stage] imagen no encontrada:', o.image); continue; }
      spr.setAtlas(at);
      if (animated) {
        for (const an of o.animations ?? []) {
          const name = String(an.anim ?? an.name), pre = String(an.name ?? an.prefix ?? name);
          if (Array.isArray(an.indices) && an.indices.length) spr.addByIndices(name, pre, an.indices, '', an.fps ?? 24, !!an.loop);
          else spr.addByPrefix(name, pre, an.fps ?? 24, !!an.loop);
        }
        const first = o.firstAnimation ?? o.animations?.[0]?.anim; if (first) spr.play(String(first));
      }
      if (o.scale && type !== 'square') { const [sx, sy] = pair(o.scale, 1); spr.scale.x = sx; spr.scale.y = sy; spr.updateHitbox(); }
    }
    const [scx, scy] = pair(o.scroll, 1); spr.scrollFactor.x = scx; spr.scrollFactor.y = scy;
    spr.flipX = !!o.flipX; spr.flipY = !!o.flipY;
    spr.antialiasing = o.antialiasing === false ? false : ps.prefs.antialiasing && !ps.isPixelStage;
    if (typeof o.alpha === 'number') spr.alpha = o.alpha;
    if (typeof o.angle === 'number') spr.angle = o.angle;
    if (o.color && type !== 'square') spr.color = parseColor(o.color) & 0xffffff;
    if (o.blend) spr.blend = String(o.blend).toLowerCase();
    if (o.name) { spr.tag = String(o.name); ps.luaSprites.set(String(o.name), spr); }
    cur.push(spr);
    if (cur === layout.back) ps.layerBack.push(spr);
  }
  ps.stageLayout = layout;
}

/** Coloca los objetos entre los personajes según los marcadores del JSON (se llama cuando ya existen gf/dad/bf). */
export function applyStageLayout(ps: PlayState) {
  const L = ps.stageLayout; if (!L || !L.marks.length) { for (const m of L?.marks ?? []) for (const o of m.items) ps.layerFront.push(o); return; }
  const by: Record<string, Drawable | null> = { gf: ps.gf, dad: ps.dad, boyfriend: ps.boyfriend };
  const chars: Drawable[] = []; const last = L.marks.length - 1;
  L.marks.forEach((m, i) => {
    const c = by[m.char]; if (c) chars.push(c);
    for (const o of m.items) (i === last ? ps.layerFront : chars).push(o);
  });
  for (const c of Object.values(by)) if (c && !chars.includes(c)) chars.push(c);
  ps.layerChars.length = 0; ps.layerChars.push(...chars);
}
