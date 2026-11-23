/** Preferencias y puntuaciones, guardadas en localStorage (con tolerancia a que no exista). */
export interface Prefs {
  downScroll: boolean; middleScroll: boolean; opponentStrums: boolean; ghostTapping: boolean;
  noteOffset: number; ratingOffset: number;
  sickWindow: number; goodWindow: number; badWindow: number;
  hideHud: boolean; timeBarType: 'Time Left' | 'Time Elapsed' | 'Song Name' | 'Disabled';
  camZooms: boolean; scoreZoom: boolean; healthBarAlpha: number; antialiasing: boolean; lowQuality: boolean;
  hitsoundVolume: number; volume: number; flashing: boolean; comboStacking: boolean; botplay: boolean;
  scrollSpeed: number; practice: boolean; healthGain: number; healthLoss: number;
  keys: Record<string, string[]>;
}

export const defaultPrefs = (): Prefs => ({
  downScroll: false, middleScroll: false, opponentStrums: true, ghostTapping: true,
  noteOffset: 0, ratingOffset: 0, sickWindow: 45, goodWindow: 90, badWindow: 135,
  hideHud: false, timeBarType: 'Time Left', camZooms: true, scoreZoom: true, healthBarAlpha: 1,
  antialiasing: true, lowQuality: false, hitsoundVolume: 0, volume: 1, flashing: true, comboStacking: true, botplay: false,
  scrollSpeed: 0, practice: false, healthGain: 1, healthLoss: 1,
  keys: {
    left: ['KeyA', 'ArrowLeft'], down: ['KeyS', 'ArrowDown'], up: ['KeyW', 'ArrowUp'], right: ['KeyD', 'ArrowRight'],
    accept: ['Enter', 'Space'], back: ['Escape', 'Backspace'], pause: ['Enter', 'Escape'], reset: ['KeyR'],
    uiLeft: ['KeyA', 'ArrowLeft'], uiDown: ['KeyS', 'ArrowDown'], uiUp: ['KeyW', 'ArrowUp'], uiRight: ['KeyD', 'ArrowRight'],
  },
});

const PK = 'india.prefs.v1', SK = 'india.scores.v1';
const get = (k: string): any => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const set = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

export function loadPrefs(): Prefs {
  const d = defaultPrefs(), s = get(PK);
  if (!s) return d;
  return { ...d, ...s, keys: { ...d.keys, ...(s.keys ?? {}) } };
}
export const savePrefs = (p: Prefs) => set(PK, p);

export interface ScoreEntry { score: number; rating: number; misses: number }
export function getScore(id: string): ScoreEntry | null { return (get(SK) ?? {})[id] ?? null; }
export function saveScore(id: string, e: ScoreEntry) {
  const all = get(SK) ?? {};
  if (!all[id] || all[id].score < e.score) { all[id] = e; set(SK, all); }
}
/** datos persistentes de mods (initSaveData/getDataFromSave de Lua) */
export const modSave = {
  load(name: string): Record<string, any> { return (get('india.mod.' + name) ?? {}); },
  store(name: string, data: Record<string, any>) { set('india.mod.' + name, data); },
};
