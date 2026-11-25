import { Assets } from '../engine/assets';
import { Sprite } from '../engine/display';
import type { PlayState } from './playstate';

export interface StageFile {
  directory: string; defaultZoom: number; isPixelStage?: boolean; stageUI?: string;
  boyfriend: number[]; girlfriend: number[]; opponent: number[]; hide_girlfriend: boolean;
  camera_boyfriend: number[]; camera_opponent: number[]; camera_girlfriend: number[]; camera_speed?: number;
}

export const defaultStage = (): StageFile => ({
  directory: '', defaultZoom: 0.9, isPixelStage: false, stageUI: 'normal',
  boyfriend: [770, 100], girlfriend: [400, 130], opponent: [100, 100], hide_girlfriend: false,
  camera_boyfriend: [0, 0], camera_opponent: [0, 0], camera_girlfriend: [0, 0], camera_speed: 1,
});

export async function loadStageFile(assets: Assets, name: string): Promise<StageFile | null> {
  const j = await assets.json<Partial<StageFile>>(`stages/${name}.json`);
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
