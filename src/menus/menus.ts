import { Engine, State, ENGINE_NAME, ENGINE_VERSION } from '../engine/engine';
import { W, H } from '../engine/display';
import { getScore } from '../engine/save';
import { PlayState } from '../game/playstate';
import { stageForSong } from '../game/chart';

export interface SongEntry { song: string; mod: string; week: string; color: number; icon: string; diffs: string[]; weekName: string }

const rgb = (c: number) => '#' + (c & 0xffffff).toString(16).padStart(6, '0');

/** Lista canciones de weeks/*.json del juego base y de cada mod. */
export async function discoverSongs(e: Engine): Promise<SongEntry[]> {
  const out: SongEntry[] = [];
  const v = e.vfs;
  const scan = async (dir: string, mod: string) => {
    const order: string[] = [];
    try { if (v.has(`${dir}/weekList.txt`)) order.push(...(await v.text(`${dir}/weekList.txt`)).split(/\r?\n/).map(s => s.trim()).filter(Boolean)); } catch { /* */ }
    for (const f of v.listFiles(dir, '.json')) { const n = f.replace(/\.json$/i, ''); if (!order.includes(n)) order.push(n); }
    for (const wk of order) {
      const p = `${dir}/${wk}.json`;
      if (!v.has(p)) continue;
      try {
        const j = await v.json<any>(p);
        if (!j.songs || j.hideFreeplay) continue;
        const diffs = String(j.difficulties || 'Easy, Normal, Hard').split(',').map((s: string) => s.trim()).filter(Boolean);
        for (const s of j.songs) {
          const c = s[2] ?? [146, 113, 253];
          out.push({ song: s[0], icon: s[1] ?? 'face', color: (c[0] << 16) | (c[1] << 8) | c[2], mod, week: wk, diffs: diffs.length ? diffs : ['Normal'], weekName: j.storyName ?? wk });
        }
      } catch (err) { console.warn('week inválida', p, err); }
    }
  };
  await scan('assets/shared/weeks', '');
  for (const m of [...v.mods].sort()) {
    await scan(`mods/${m}/weeks`, m);
    // mods sin weeks: canciones sueltas con chart en data/<cancion>/
    if (!out.some(s => s.mod === m)) {
      for (const d of v.listDirs(`mods/${m}/data`)) {
        if (v.listFiles(`mods/${m}/data/${d}`, '.json').some(f => /^[^/]+\.json$/i.test(f) && f.toLowerCase() !== 'events.json'))
          out.push({ song: d, icon: 'face', color: 0x9271fd, mod: m, week: '', diffs: ['Normal'], weekName: m });
      }
    }
  }
  return out;
}

export const diffSuffix = (d: string) => (d.toLowerCase() === 'normal' ? '' : '-' + d.toLowerCase().replace(/ /g, '-'));

type Screen = 'title' | 'main' | 'freeplay' | 'options' | 'credits';

export class MenuState implements State {
  screen: Screen = 'title';
  sel = 0;
  songs: SongEntry[] = [];
  diffIdx = 0;
  t = 0;
  msg = '';
  private optSel = 0;
  private bg = 0x9271fd;
  private bgCur = 0x2b2b4a;
  constructor(private e: Engine, start: Screen = 'title') { this.screen = start; }

  async init() {
    await this.e.assets.font('vcr', 'fonts/vcr.ttf');
    this.e.assets.currentMod = '';
    this.songs = await discoverSongs(this.e);
  }

  reload() { void discoverSongs(this.e).then(s => { this.songs = s; }); }

  private items(): string[] {
    switch (this.screen) {
      case 'main': return ['Freeplay', 'Options', 'Credits'];
      default: return [];
    }
  }

  private get options() {
    const p = this.e.prefs;
    return [
      { name: 'Downscroll', get: () => p.downScroll, set: () => { p.downScroll = !p.downScroll; } },
      { name: 'Middlescroll', get: () => p.middleScroll, set: () => { p.middleScroll = !p.middleScroll; } },
      { name: 'Ghost Tapping', get: () => p.ghostTapping, set: () => { p.ghostTapping = !p.ghostTapping; } },
      { name: 'Opponent Strums', get: () => p.opponentStrums, set: () => { p.opponentStrums = !p.opponentStrums; } },
      { name: 'Hide HUD', get: () => p.hideHud, set: () => { p.hideHud = !p.hideHud; } },
      { name: 'Camera Zooms', get: () => p.camZooms, set: () => { p.camZooms = !p.camZooms; } },
      { name: 'Low Quality', get: () => p.lowQuality, set: () => { p.lowQuality = !p.lowQuality; } },
      { name: 'Botplay', get: () => p.botplay, set: () => { p.botplay = !p.botplay; } },
      { name: 'Practice Mode', get: () => p.practice, set: () => { p.practice = !p.practice; } },
      { name: 'Hitsound', get: () => p.hitsoundVolume > 0, set: () => { p.hitsoundVolume = p.hitsoundVolume > 0 ? 0 : 0.5; } },
      { name: 'Time Bar: ' + p.timeBarType, get: () => true, set: () => { const o = ['Time Left', 'Time Elapsed', 'Song Name', 'Disabled'] as const; p.timeBarType = o[(o.indexOf(p.timeBarType) + 1) % 4]; } },
      { name: 'Note Offset: ' + p.noteOffset + 'ms  (←/→)', get: () => true, set: () => {} },
    ];
  }

  keyDown(code: string) {
    const inp = this.e.input;
    const acts = inp.actionOf(code);
    const up = acts.includes('uiUp'), down = acts.includes('uiDown'), left = acts.includes('uiLeft'), right = acts.includes('uiRight');
    const ok = acts.includes('accept'), back = acts.includes('back');
    void this.e.audio.resume();
    if (this.screen === 'title') { if (ok) { this.screen = 'main'; this.sel = 0; } return; }
    if (this.screen === 'main') {
      const n = this.items().length;
      if (up) this.sel = (this.sel + n - 1) % n;
      if (down) this.sel = (this.sel + 1) % n;
      if (back) this.screen = 'title';
      if (ok) { this.screen = (['freeplay', 'options', 'credits'] as Screen[])[this.sel]; this.sel = 0; this.optSel = 0; this.diffIdx = 0; }
      return;
    }
    if (this.screen === 'freeplay') {
      const n = this.songs.length;
      if (back) { this.screen = 'main'; this.sel = 0; return; }
      if (!n) return;
      if (up) { this.sel = (this.sel + n - 1) % n; this.diffIdx = 0; }
      if (down) { this.sel = (this.sel + 1) % n; this.diffIdx = 0; }
      const s = this.songs[this.sel];
      if (left) this.diffIdx = (this.diffIdx + s.diffs.length - 1) % s.diffs.length;
      if (right) this.diffIdx = (this.diffIdx + 1) % s.diffs.length;
      if (ok) void this.play(s);
      return;
    }
    if (this.screen === 'options') {
      const o = this.options, n = o.length;
      if (up) this.optSel = (this.optSel + n - 1) % n;
      if (down) this.optSel = (this.optSel + 1) % n;
      if (ok) { o[this.optSel].set(); this.e.savePrefs(); }
      if (this.optSel === n - 1) {
        if (left) { this.e.prefs.noteOffset -= 5; this.e.savePrefs(); }
        if (right) { this.e.prefs.noteOffset += 5; this.e.savePrefs(); }
      }
      if (back) { this.screen = 'main'; this.sel = 1; }
      return;
    }
    if (this.screen === 'credits' && back) { this.screen = 'main'; this.sel = 2; }
  }

  async play(s: SongEntry) {
    const diff = s.diffs[this.diffIdx % s.diffs.length];
    const e = this.e;
    const start = () => {
      void e.switchState(() => new PlayState(e, {
        song: s.song, diffName: diff, diffSuffix: diffSuffix(diff), mod: s.mod,
        onExit: () => { void e.switchState(() => new MenuState(e, 'freeplay')); },
        onRestart: () => start(),
      })).catch(err => { console.error(err); e.toast('No se pudo iniciar: ' + err.message, '#ff7777', 8); e.switchState(new MenuState(e, 'freeplay')); });
    };
    start();
  }

  update(dt: number) {
    this.t += dt;
    if (this.screen === 'freeplay' && this.songs[this.sel]) this.bg = this.songs[this.sel].color;
    else this.bg = 0x2b2b4a;
    const lerp = (a: number, b: number) => { const f = 1 - Math.exp(-dt * 5); const c = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * f); return (c(16) << 16) | (c(8) << 8) | c(0); };
    this.bgCur = lerp(this.bgCur, this.bg);
  }

  private text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, align: CanvasTextAlign = 'left', alpha = 1, color = '#fff') {
    ctx.save(); ctx.globalAlpha = alpha; ctx.font = `${size}px "vcr", monospace`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size / 6); ctx.strokeStyle = '#000'; ctx.strokeText(s, x, y); ctx.fillStyle = color; ctx.fillText(s, x, y); ctx.restore();
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = rgb(this.bgCur); ctx.fillRect(0, 0, W, H);
    // patrón suave
    ctx.save(); ctx.globalAlpha = 0.08; ctx.fillStyle = '#fff';
    for (let i = 0; i < 14; i++) { const x = ((i * 137 + this.t * 20) % (W + 200)) - 100; ctx.beginPath(); ctx.arc(x, 120 + (i * 53) % 520, 60 + (i % 4) * 20, 0, 7); ctx.fill(); }
    ctx.restore();
    const has = this.e.vfs.hasBase;
    if (this.screen === 'title') {
      const bump = 1 + Math.sin(this.t * 4) * 0.015;
      ctx.save(); ctx.translate(W / 2, 250); ctx.scale(bump, bump);
      this.text(ctx, 'INDIA', 0, -40, 130, 'center'); this.text(ctx, 'ENGINE', 0, 70, 130, 'center'); ctx.restore();
      this.text(ctx, 'Press ENTER to start', W / 2, 560, 36, 'center', 0.6 + 0.4 * Math.sin(this.t * 4));
      this.text(ctx, `v${ENGINE_VERSION}`, 14, H - 20, 18);
      if (!has) this.text(ctx, 'Sin assets base: usa "Cargar assets base (.zip)" arriba', W / 2, 640, 20, 'center', 1, '#ffcc66');
      return;
    }
    if (this.screen === 'main') {
      this.items().forEach((it, i) => this.text(ctx, it, W / 2, 250 + i * 90, 64, 'center', i === this.sel ? 1 : 0.5));
      this.text(ctx, `${ENGINE_NAME} v${ENGINE_VERSION}`, 12, H - 22, 18);
      return;
    }
    if (this.screen === 'freeplay') {
      if (!this.songs.length) {
        this.text(ctx, 'No hay canciones.', W / 2, 300, 40, 'center');
        this.text(ctx, 'Carga los assets base o agrega un mod (.zip) desde la barra superior.', W / 2, 360, 22, 'center');
        return;
      }
      const n = this.songs.length;
      for (let k = -4; k <= 4; k++) {
        const i = (((this.sel + k) % n) + n) % n; if (n < 2 * 4 + 1 && Math.abs(k) > Math.floor(n / 2)) continue;
        const s = this.songs[i];
        this.text(ctx, s.song, 120 + Math.abs(k) * 22, 360 + k * 70, 48, 'left', k === 0 ? 1 : 0.45);
        if (s.mod) this.text(ctx, s.mod, 120 + Math.abs(k) * 22, 360 + k * 70 + 26, 16, 'left', k === 0 ? 0.8 : 0.3, '#ccc');
      }
      const s = this.songs[this.sel], d = s.diffs[this.diffIdx % s.diffs.length];
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(W - 420, 20, 400, 120);
      const sc = getScore(`${s.mod}|${s.song.toLowerCase().replace(/ /g, '-')}|${d}`);
      this.text(ctx, `Best: ${sc ? sc.score : 0}`, W - 400, 50, 28);
      this.text(ctx, `< ${d.toUpperCase()} >`, W - 400, 95, 28);
      this.text(ctx, `Stage: ${stageForSong({ song: s.song } as any)}`.replace(/^Stage: .*/, s.mod ? `Mod: ${s.mod}` : 'Base game'), W - 400, 125, 16, 'left', 0.7);
      this.text(ctx, 'ENTER: jugar   ESC: volver', W / 2, H - 24, 18, 'center', 0.7);
      return;
    }
    if (this.screen === 'options') {
      this.text(ctx, 'OPTIONS', W / 2, 60, 56, 'center');
      this.options.forEach((o, i) => {
        const on = o.get();
        this.text(ctx, o.name, 330, 130 + i * 44, 30, 'left', i === this.optSel ? 1 : 0.5);
        if (!/:|\(/.test(o.name)) this.text(ctx, on ? 'ON' : 'OFF', 900, 130 + i * 44, 30, 'left', i === this.optSel ? 1 : 0.5, on ? '#7fff7f' : '#ff8f8f');
      });
      return;
    }
    if (this.screen === 'credits') {
      this.text(ctx, 'CREDITS', W / 2, 90, 56, 'center');
      const lines = [
        `${ENGINE_NAME}`,
        'Motor de Friday Night Funkin\' para navegador con soporte de mods.',
        '',
        'Charts, personajes, stages y API Lua compatibles',
        'con los mods de la generación 0.7.x.',
        'Ver NOTICE.md para los créditos y licencias completos.',
      ];
      lines.forEach((l, i) => this.text(ctx, l, W / 2, 200 + i * 44, 26, 'center', 0.9));
    }
  }

  destroy() {}
}

/** Arranca una canción directamente (útil para pruebas y accesos directos). */
export function startSong(e: Engine, song: string, diffName = 'Hard', mod = '') {
  const start = () => {
    void e.switchState(() => new PlayState(e, {
      song, diffName, diffSuffix: diffSuffix(diffName), mod,
      onExit: () => { void e.switchState(() => new MenuState(e, 'freeplay')); },
      onRestart: () => start(),
    }));
  };
  start();
}
