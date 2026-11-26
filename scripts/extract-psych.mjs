// Uso: npm run extract -- ruta/a/FNF-PsychEngine-0.7.3.zip [--mod ruta/a/mod.zip ...]
// Extrae assets/ a public/, instala los mods indicados en public/mods/ (juego base incluido, p. ej. Pico Mix)
// y genera public/vfs-manifest.json.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const modZips = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--mod' && args[i + 1]) { modZips.push(args[i + 1]); args.splice(i, 2); i--; }
const zip = args[0];
if (!zip || !existsSync(zip)) { console.error('Uso: npm run extract -- <FNF-PsychEngine-0.7.3.zip>'); process.exit(1); }
const tmp = join('.extract-tmp');
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
execSync(`unzip -q -o "${zip}" "*/assets/*" -d "${tmp}"`, { stdio: 'inherit' });
const root = join(tmp, readdirSync(tmp)[0]);
rmSync('public/assets', { recursive: true, force: true });
mkdirSync('public', { recursive: true });
execSync(`cp -r "${join(root, 'assets')}" public/assets`);
rmSync(tmp, { recursive: true, force: true });
// mods incluidos en el juego base
rmSync('public/mods', { recursive: true, force: true });
for (const mz of modZips) {
  if (!existsSync(mz)) { console.error('No existe el mod: ' + mz); process.exit(1); }
  const mt = join('.extract-mod');
  rmSync(mt, { recursive: true, force: true }); mkdirSync(mt, { recursive: true });
  execSync(`unzip -q -o "${mz}" -d "${mt}"`, { stdio: 'inherit' });
  const entries = readdirSync(mt);
  // si el zip trae una sola carpeta, esa carpeta es el mod; si no, el nombre del zip
  const modRoot = entries.length === 1 && statSync(join(mt, entries[0])).isDirectory() ? join(mt, entries[0]) : mt;
  const modName = modRoot === mt ? mz.split('/').pop().replace(/\.zip$/i, '') : entries[0];
  mkdirSync('public/mods', { recursive: true });
  execSync(`cp -r "${modRoot}" "public/mods/${modName}"`);
  rmSync(mt, { recursive: true, force: true });
  console.log('Mod incluido: ' + modName);
}
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(relative('public', p).replace(/\\/g, '/')); } })('public/assets');
if (existsSync('public/mods')) (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(relative('public', p).replace(/\\/g, '/')); } })('public/mods');
writeFileSync('public/vfs-manifest.json', JSON.stringify({ files }));
console.log(`Listo: ${files.length} archivos en public/assets`);
