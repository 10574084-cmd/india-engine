import { VFS } from './vfs';
import { Atlas } from './display';
import { AudioSys } from './audio';

/**
 * Resolución de rutas estilo Psych (Paths.hx + Mods.hx) y carga con caché.
 * Orden de búsqueda de un archivo `images/x.png`:
 *   1. mods/<modActual>/        2. mods/ (raíz)       3. mods globales
 *   4. assets/week_assets/<nivel>/ (directorio del stage)
 *   5. assets/shared/           6. assets/
 */
const SSERAFIM_RE = /^(characters\/bf(-christmas|-car|-dark)?\.json|images\/characters\/(BOYFRIEND|bfChristmas|bfCar|dark\/bf_dark)\.(png|xml))$/i;

export class Assets {
  currentMod = '';
  /** skin alternativa de BF (carpeta skins/sserafim) */
  skinSserafim = false;
  currentLevel: string | null = null;
  private imgCache = new Map<string, ImageBitmap>();
  private atlasCache = new Map<string, Atlas | null>();
  private sndCache = new Map<string, AudioBuffer>();
  private missing = new Set<string>();

  constructor(public vfs: VFS, public audio: AudioSys) {}

  /** candidatos en orden de prioridad */
  candidates(file: string, ignoreMods = false): string[] {
    const out: string[] = [];
    if (!ignoreMods) {
      if (this.currentMod) out.push(`mods/${this.currentMod}/${file}`);
      out.push(`mods/${file}`);
      for (const g of this.vfs.globalMods) if (g !== this.currentMod) out.push(`mods/${g}/${file}`);
    }
    if (this.skinSserafim && SSERAFIM_RE.test(file)) out.push(`skins/sserafim/${file}`);
    if (this.currentLevel && this.currentLevel !== 'shared') out.push(`assets/week_assets/${this.currentLevel}/${file}`);
    out.push(`assets/shared/${file}`, `assets/${file}`);
    return out;
  }

  resolve(file: string, ignoreMods = false): string | null {
    for (const c of this.candidates(file, ignoreMods)) if (this.vfs.has(c)) return this.vfs.realPath(c)!;
    return null;
  }
  exists(file: string, ignoreMods = false) { return this.resolve(file, ignoreMods) !== null; }

  /** archivos en una carpeta (suma de todas las capas, sin repetir) */
  listAll(dir: string, ext?: string): { name: string; path: string }[] {
    const seen = new Set<string>(); const out: { name: string; path: string }[] = [];
    for (const c of this.candidates(dir)) {
      for (const f of this.vfs.listFiles(c, ext)) {
        const k = f.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push({ name: f, path: `${c}/${f}` }); }
      }
    }
    return out;
  }

  async text(file: string, ignoreMods = false): Promise<string | null> {
    const p = this.resolve(file, ignoreMods);
    return p ? this.vfs.text(p) : null;
  }
  async json<T = any>(file: string, ignoreMods = false): Promise<T | null> {
    const p = this.resolve(file, ignoreMods);
    if (!p) return null;
    try { return await this.vfs.json<T>(p); } catch (e) { console.warn('JSON inválido', p, e); return null; }
  }

  // ------------------------------------------------------------ imágenes
  async bitmap(path: string): Promise<ImageBitmap | null> {
    const c = this.imgCache.get(path);
    if (c) return c;
    try {
      const blob = await this.vfs.blob(path, 'image/png');
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
      this.imgCache.set(path, bmp);
      return bmp;
    } catch (e) {
      console.warn('No se pudo cargar imagen', path, e);
      return null;
    }
  }

  /** Imagen suelta (images/<key>.png) como atlas de un solo frame. */
  async image(key: string): Promise<Atlas | null> {
    const k = key.replace(/\.png$/i, '');
    const p = this.resolve(`images/${k}.png`);
    if (!p) return null;
    const ck = 'i:' + p;
    if (this.atlasCache.has(ck)) return this.atlasCache.get(ck)!;
    const bmp = await this.bitmap(p);
    const a = bmp ? Atlas.single(bmp) : null;
    this.atlasCache.set(ck, a);
    return a;
  }

  /** Versión síncrona: solo devuelve si ya está en caché. */
  peekImage(key: string): Atlas | null {
    const p = this.resolve(`images/${key.replace(/\.png$/i, '')}.png`);
    return p ? (this.atlasCache.get('i:' + p) ?? null) : null;
  }
  peekAtlas(key: string): Atlas | null {
    const p = this.resolve(`images/${key.replace(/\.png$/i, '')}.png`);
    return p ? (this.atlasCache.get('a:' + p) ?? null) : null;
  }

  /** Atlas animado: Sparrow (.xml), Packer (.txt), TexturePacker (.json) o imagen simple. */
  async atlas(key: string): Promise<Atlas | null> {
    if (key.includes(',')) {
      const parts = key.split(',').map(x => x.trim()).filter(Boolean);
      const list: Atlas[] = [];
      for (const k of parts) { const at = await this.atlas(k); if (at) list.push(at); }
      return list.length ? (list.length === 1 ? list[0] : Atlas.merge(list)) : null;
    }
    const k = key.replace(/\.png$/i, '');
    const png = this.resolve(`images/${k}.png`);
    if (!png) return null;
    const ck = 'a:' + png;
    if (this.atlasCache.has(ck)) return this.atlasCache.get(ck)!;
    const bmp = await this.bitmap(png);
    if (!bmp) { this.atlasCache.set(ck, null); return null; }
    let a: Atlas | null = null;
    const xml = this.resolve(`images/${k}.xml`), txt = this.resolve(`images/${k}.txt`), js = this.resolve(`images/${k}.json`);
    try {
      if (xml) a = Atlas.sparrow(bmp, await this.vfs.text(xml));
      else if (txt) a = Atlas.packer(bmp, await this.vfs.text(txt));
      else if (js) a = Atlas.texturePacker(bmp, await this.vfs.json(js));
    } catch (e) { console.warn('Atlas inválido', k, e); }
    if (!a || !a.frames.length) a = Atlas.single(bmp);
    this.atlasCache.set(ck, a);
    return a;
  }

  hasAtlasData(key: string) {
    const k = key.replace(/\.png$/i, '');
    return this.exists(`images/${k}.xml`) || this.exists(`images/${k}.txt`) || this.exists(`images/${k}.json`);
  }

  // ------------------------------------------------------------ audio
  private async decodeFirst(paths: (string | null)[]): Promise<AudioBuffer | null> {
    for (const p of paths) {
      if (!p) continue;
      const c = this.sndCache.get(p);
      if (c) return c;
      try {
        const b = await this.audio.decode(await this.vfs.bytes(p));
        this.sndCache.set(p, b);
        return b;
      } catch (e) { /* probar siguiente formato */ }
    }
    return null;
  }
  private audioPaths(base: string): (string | null)[] {
    return ['ogg', 'mp3', 'wav'].map(e => this.resolve(`${base}.${e}`));
  }
  sound(key: string) { return this.decodeFirst(this.audioPaths(`sounds/${key}`)); }
  music(key: string) { return this.decodeFirst(this.audioPaths(`music/${key}`)); }
  songFile(song: string, name: string) { return this.decodeFirst(this.audioPaths(`songs/${song}/${name}`)); }
  hasSongFile(song: string, name: string) { return this.audioPaths(`songs/${song}/${name}`).some(Boolean); }

  // ------------------------------------------------------------ fuentes
  private fonts = new Set<string>();
  async font(family: string, file: string) {
    if (this.fonts.has(family)) return;
    const p = this.resolve(file);
    if (!p) return;
    try {
      const ff = new FontFace(family, await this.vfs.bytes(p));
      await ff.load(); document.fonts.add(ff); this.fonts.add(family);
    } catch (e) { console.warn('Fuente no cargada', file, e); }
  }

  /** descarta imágenes/atlas en caché (p. ej. al cambiar de skin) */
  clearVisualCaches() { this.imgCache.clear(); this.atlasCache.clear(); this.missing.clear(); }
  clearMissing() { this.missing.clear(); }
}

export const formatSongPath = (s: string) => s.replace(/ /g, '-').toLowerCase();
