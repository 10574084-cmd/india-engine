import JSZip from 'jszip';

/**
 * Sistema de archivos virtual de India Engine.
 *
 * Todo el contenido (assets base y mods) se monta aquí con rutas estilo Psych:
 *   assets/shared/images/...      -> juego base
 *   assets/songs/<cancion>/...    -> canciones base
 *   mods/<nombre>/images/...      -> un mod
 * Las búsquedas no distinguen mayúsculas/minúsculas (muchos mods fallan en Linux por eso).
 */

type Reader = () => Promise<ArrayBuffer>;
interface Entry { path: string; read: Reader }

export const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+/g, '/');

const MOD_DIRS = new Set([
  'characters', 'data', 'images', 'songs', 'stages', 'weeks', 'scripts', 'custom_events',
  'custom_notetypes', 'sounds', 'music', 'shaders', 'videos', 'fonts', 'achievements', 'pack.json', 'pack.png',
]);

export class VFS {
  private files = new Map<string, Entry>();
  private textCache = new Map<string, string>();
  /** carpetas de mods detectadas */
  mods = new Set<string>();
  /** mods con "runsGlobally": true en su pack.json */
  globalMods = new Set<string>();
  hasBase = false;

  add(path: string, read: Reader) {
    const p = norm(path);
    this.files.set(p.toLowerCase(), { path: p, read });
    const m = /^mods\/([^/]+)\//i.exec(p);
    if (m) this.mods.add(m[1]);
  }

  has(path: string) { return this.files.has(norm(path).toLowerCase()); }

  realPath(path: string) { return this.files.get(norm(path).toLowerCase())?.path; }

  async bytes(path: string): Promise<ArrayBuffer> {
    const e = this.files.get(norm(path).toLowerCase());
    if (!e) throw new Error('Archivo no encontrado: ' + path);
    return e.read();
  }

  async blob(path: string, type = ''): Promise<Blob> {
    return new Blob([await this.bytes(path)], type ? { type } : undefined);
  }

  async text(path: string): Promise<string> {
    const key = norm(path).toLowerCase();
    const c = this.textCache.get(key);
    if (c !== undefined) return c;
    const buf = await this.bytes(path);
    let t = new TextDecoder('utf-8').decode(buf);
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // BOM
    this.textCache.set(key, t);
    return t;
  }

  async json<T = any>(path: string): Promise<T> {
    let t = (await this.text(path)).trim();
    // Psych recorta basura al final del JSON ("while(!rawJson.endsWith('}'))")
    const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (last >= 0 && last < t.length - 1) t = t.slice(0, last + 1);
    return JSON.parse(t);
  }

  /** nombres de archivo directamente dentro de `dir` */
  listFiles(dir: string, ext?: string): string[] {
    const d = norm(dir).replace(/\/$/, '').toLowerCase() + '/';
    const out: string[] = [];
    for (const [k, e] of this.files) {
      if (!k.startsWith(d)) continue;
      const rest = e.path.slice(d.length);
      if (rest.includes('/')) continue;
      if (ext && !rest.toLowerCase().endsWith(ext.toLowerCase())) continue;
      out.push(rest);
    }
    return out.sort();
  }

  /** subcarpetas directas de `dir` */
  listDirs(dir: string): string[] {
    const d = norm(dir).replace(/\/$/, '').toLowerCase() + '/';
    const out = new Set<string>();
    for (const [k, e] of this.files) {
      if (!k.startsWith(d)) continue;
      const rest = e.path.slice(d.length);
      const i = rest.indexOf('/');
      if (i > 0) out.add(rest.slice(0, i));
    }
    return [...out].sort();
  }

  removeMod(name: string) {
    const p = `mods/${name}/`.toLowerCase();
    for (const k of [...this.files.keys()]) if (k.startsWith(p)) this.files.delete(k);
    this.mods.delete(name);
    this.globalMods.delete(name);
  }

  // ---------------------------------------------------------------- montaje

  /**
   * Monta un .zip. Detecta si es el paquete base (contiene assets/shared) o un mod.
   * Devuelve una descripción de lo que se montó.
   */
  async addZip(file: Blob, fileName = 'mod.zip'): Promise<{ kind: 'base' | 'mod'; names: string[]; count: number }> {
    const zip = await JSZip.loadAsync(file);
    const entries: { path: string; zf: JSZip.JSZipObject }[] = [];
    zip.forEach((p, zf) => { if (!zf.dir && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(p)) entries.push({ path: norm(p), zf }); });
    return this.mountEntries(entries.map(e => ({ path: e.path, read: () => e.zf.async('arraybuffer') })), fileName.replace(/\.[^.]+$/, ''));
  }

  /** Monta una carpeta elegida con <input webkitdirectory> o arrastrada. */
  async addFiles(files: File[]) {
    const items = files.map(f => ({
      path: norm((f as any).webkitRelativePath || f.name),
      read: () => f.arrayBuffer(),
    }));
    const root = items[0]?.path.split('/')[0] ?? 'mod';
    return this.mountEntries(items, root);
  }

  private mountEntries(items: { path: string; read: Reader }[], fallbackName: string) {
    // ¿Paquete base? (contiene assets/shared/)
    const baseItem = items.find(i => /(^|\/)assets\/shared\//i.test(i.path));
    if (baseItem) {
      const idx = baseItem.path.toLowerCase().indexOf('assets/shared/');
      const rootLen = idx; // prefijo antes de "assets/"
      let count = 0;
      for (const it of items) {
        const p = it.path;
        if (p.length <= rootLen) continue;
        const rel = p.slice(rootLen);
        if (/^assets\//i.test(rel)) { this.add(rel, it.read); count++; }
        else if (/^mods\//i.test(rel)) { this.add(rel, it.read); count++; }
      }
      this.hasBase = true;
      return Promise.resolve({ kind: 'base' as const, names: ['base'], count });
    }

    // ¿Contiene una carpeta mods/<x>/ ya armada?
    const modsRooted = items.filter(i => /(^|\/)mods\/[^/]+\//i.test(i.path));
    if (modsRooted.length > items.length / 2) {
      const names = new Set<string>();
      for (const it of modsRooted) {
        const m = /(^|\/)(mods\/[^/]+\/.*)$/i.exec(it.path)!;
        this.add(m[2], it.read);
        names.add(m[2].split('/')[1]);
      }
      return Promise.resolve({ kind: 'mod' as const, names: [...names], count: modsRooted.length });
    }

    // Mod suelto: buscar la raíz (primer segmento que sea carpeta conocida o pack.json)
    const rootCounts = new Map<string, number>();
    for (const it of items) {
      const segs = it.path.split('/');
      for (let i = 0; i < segs.length; i++) {
        if (MOD_DIRS.has(segs[i].toLowerCase())) {
          const root = segs.slice(0, i).join('/');
          rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
          break;
        }
      }
    }
    let bestRoot = '';
    let bestN = -1;
    for (const [r, n] of rootCounts) if (n > bestN) { bestRoot = r; bestN = n; }
    const name = (bestRoot ? bestRoot.split('/').pop()! : fallbackName).trim() || 'mod';
    const prefix = bestRoot ? bestRoot + '/' : '';
    let count = 0;
    for (const it of items) {
      if (prefix && !it.path.startsWith(prefix)) continue;
      this.add(`mods/${name}/${it.path.slice(prefix.length)}`, it.read);
      count++;
    }
    return Promise.resolve({ kind: 'mod' as const, names: [name], count });
  }

  /** Monta archivos servidos por HTTP con un manifest { files: string[] } (ver scripts/extract-psych.mjs). */
  async addManifest(baseUrl: string, manifestUrl: string) {
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error('No hay manifest: ' + manifestUrl);
    const m: { files: string[] } = await res.json();
    for (const f of m.files) {
      this.add(f, async () => {
        const r = await fetch(baseUrl + encodeURI(f));
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + f);
        return r.arrayBuffer();
      });
    }
    if (m.files.some(f => /^assets\/shared\//i.test(f))) this.hasBase = true;
    return m.files.length;
  }

  /** Lee pack.json de cada mod para saber cuáles son globales. */
  async scanPacks() {
    this.globalMods.clear();
    for (const m of this.mods) {
      try {
        const p = `mods/${m}/pack.json`;
        if (this.has(p)) {
          const j = await this.json(p);
          if (j?.runsGlobally) this.globalMods.add(m);
        }
      } catch { /* ignorar pack.json roto */ }
    }
  }
}
