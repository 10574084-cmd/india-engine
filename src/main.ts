import { Engine } from './engine/engine';
import { MenuState } from './menus/menus';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const engine = new Engine(canvas);
(window as any).india = engine;

async function boot() {
  // En desarrollo, si hay public/vfs-manifest.json (npm run extract) se monta solo.
  try {
    const n = await engine.vfs.addManifest('./', './vfs-manifest.json');
    status.textContent = `Assets base cargados (${n} archivos)`;
  } catch { status.textContent = 'Sin assets base: cárgalos con el botón'; }
  await engine.vfs.scanPacks();
  await engine.switchState(new MenuState(engine));
  engine.start();
}

async function refresh() {
  await engine.vfs.scanPacks();
  const s = engine.state as any;
  if (s?.reload) s.reload();
  status.textContent = `${engine.vfs.hasBase ? 'Base ✓' : 'Sin base'} · mods: ${engine.vfs.mods.size}`;
}

function wire(btn: string, input: string, fn: (files: File[]) => Promise<void>) {
  const b = document.getElementById(btn)!, i = document.getElementById(input) as HTMLInputElement;
  b.addEventListener('click', () => i.click());
  i.addEventListener('change', async () => {
    const files = [...(i.files ?? [])]; i.value = '';
    if (!files.length) return;
    status.textContent = 'Cargando…';
    try { await fn(files); } catch (err) { console.error(err); engine.toast('Error al cargar: ' + (err as Error).message, '#ff7777', 8); }
    await refresh();
  });
}
const zip = async (files: File[]) => {
  for (const f of files) { const r = await engine.vfs.addZip(f, f.name); engine.toast(`${r.kind === 'base' ? 'Assets base' : 'Mod ' + r.names.join(', ')} cargado (${r.count} archivos)`, '#7fff7f'); }
};
wire('btn-base', 'in-base', zip);
wire('btn-mod', 'in-mod', zip);
wire('btn-folder', 'in-folder', async files => { const r = await engine.vfs.addFiles(files); engine.toast(`${r.kind === 'base' ? 'Assets base' : 'Mod ' + r.names.join(', ')} cargado`, '#7fff7f'); });

// arrastrar y soltar .zip / carpetas
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])].filter(f => /\.zip$/i.test(f.name));
  if (files.length) { try { await zip(files); await refresh(); } catch (err) { engine.toast('Error: ' + (err as Error).message, '#ff7777', 8); } }
});

boot();
