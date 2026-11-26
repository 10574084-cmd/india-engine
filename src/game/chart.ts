import { Assets, formatSongPath } from '../engine/assets';

export interface SwagSection {
  sectionNotes: any[][]; sectionBeats: number; mustHitSection: boolean; gfSection: boolean;
  bpm: number; changeBPM: boolean; altAnim: boolean; lengthInSteps?: number;
}
export interface SwagSong {
  song: string; notes: SwagSection[]; events: any[]; bpm: number; needsVoices: boolean; speed: number;
  player1: string; player2: string; gfVersion: string; stage: string;
  gameOverChar?: string; gameOverSound?: string; gameOverLoop?: string; gameOverEnd?: string;
  disableNoteRGB?: boolean; arrowSkin?: string; splashSkin?: string; player3?: string;
  [k: string]: any;
}

/** Interpreta booleanos de charts raros: true/false, 1/0, "true"/"false". */
function toBool(v: any): boolean {
  if (typeof v === 'string') { const t = v.trim().toLowerCase(); return !(t === '' || t === 'false' || t === '0' || t === 'no'); }
  return !!v;
}

/** Resumen de un chart: cuántas notas caen de cada lado (para diagnosticar charts raros). */
export function chartStats(s: SwagSong) {
  let player = 0, opponent = 0, high = 0, sustains = 0;
  for (const sec of s.notes) for (const n of sec.sectionNotes) {
    if (n[1] < 0) continue;
    const must = n[1] > 3 ? !sec.mustHitSection : sec.mustHitSection;
    if (must) player++; else opponent++;
    if (n[1] > 7) high++;
    if (n[2] > 0) sustains++;
  }
  return { player, opponent, notesOver8: high, sustains, sections: s.notes.length };
}

/** Carga data/<cancion>/<cancion>[-dif].json con las mismas reglas que Song.hx (incluye charts viejos). */
export async function loadChart(assets: Assets, songFolder: string, difficultySuffix: string, fileName?: string): Promise<SwagSong | null> {
  const folder = formatSongPath(songFolder);
  const base = formatSongPath(fileName ?? songFolder);
  const raw = await assets.json<any>(`data/${folder}/${base}${difficultySuffix}.json`)
    ?? await assets.json<any>(`data/${folder}/${base}.json`);
  if (!raw) return null;
  const s: SwagSong = raw.song && typeof raw.song === 'object' ? raw.song : raw;
  if (!s.notes) return null;
  if (s.gfVersion == null) { s.gfVersion = s.player3 ?? ''; }
  s.player1 ??= 'bf'; s.player2 ??= 'dad'; s.speed ??= 1; s.needsVoices ??= true;
  s.bpm ??= 100;
  let bad = 0;
  for (const sec of s.notes) {
    sec.sectionNotes = Array.isArray(sec.sectionNotes) ? sec.sectionNotes : [];
    sec.sectionBeats = Number(sec.sectionBeats ?? (sec.lengthInSteps ? sec.lengthInSteps / 4 : 4)) || 4;
    sec.mustHitSection = toBool(sec.mustHitSection);
    sec.gfSection = toBool(sec.gfSection);
    sec.altAnim = toBool(sec.altAnim);
    sec.changeBPM = toBool(sec.changeBPM);
    // notas: tiempo y dirección siempre numéricos (algunos charts los guardan como texto)
    sec.sectionNotes = sec.sectionNotes.filter(n => {
      if (!Array.isArray(n)) { bad++; return false; }
      n[0] = Number(n[0]); n[1] = Number(n[1]);
      if (n[2] !== undefined && typeof n[2] !== 'string') n[2] = Number(n[2]) || 0;
      else if (typeof n[2] === 'string' && n[2] !== '' && !isNaN(Number(n[2]))) n[2] = Number(n[2]);
      if (isNaN(n[0]) || isNaN(n[1])) { bad++; return false; }
      return true;
    });
  }
  if (bad) console.warn(`[chart] ${bad} notas inválidas ignoradas en ${folder}`);
  if (!s.events) {
    s.events = [];
    for (const sec of s.notes) {
      for (let i = sec.sectionNotes.length - 1; i >= 0; i--) {
        const n = sec.sectionNotes[i];
        if (n[1] < 0) { s.events.push([n[0], [[n[2], n[3], n[4]]]]); sec.sectionNotes.splice(i, 1); }
      }
    }
  }
  // events.json aparte (editor de charts de Psych)
  const ev = await assets.json<any>(`data/${folder}/events.json`);
  const evl = ev?.song?.events ?? ev?.events;
  if (Array.isArray(evl)) s.events = s.events.concat(evl);
  s.events.sort((a, b) => a[0] - b[0]);
  return s;
}

export function stageForSong(song: SwagSong): string {
  if (song.stage) return song.stage;
  switch ((song.song ?? '').toLowerCase().replace(/ /g, '-')) {
    case 'spookeez': case 'south': case 'monster': return 'spooky';
    case 'pico': case 'blammed': case 'philly': case 'philly-nice': return 'philly';
    case 'milf': case 'satin-panties': case 'high': return 'limo';
    case 'cocoa': case 'eggnog': return 'mall';
    case 'winter-horrorland': return 'mallEvil';
    case 'senpai': case 'roses': return 'school';
    case 'thorns': return 'schoolEvil';
    case 'ugh': case 'guns': case 'stress': return 'tank';
    default: return 'stage';
  }
}
