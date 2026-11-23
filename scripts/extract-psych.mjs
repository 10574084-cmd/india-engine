// Uso: npm run extract -- ruta/a/FNF-PsychEngine-0.7.3.zip
// Extrae assets/ (y mods/ si hay) a public/ y genera public/vfs-manifest.json para desarrollo local.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const zip = process.argv[2];
if (!zip || !existsSync(zip)) { console.error('Uso: npm run extract -- <FNF-PsychEngine-0.7.3.zip>'); process.exit(1); }
const tmp = join('.extract-tmp');
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
execSync(`unzip -q -o "${zip}" "*/assets/*" -d "${tmp}"`, { stdio: 'inherit' });
const root = join(tmp, readdirSync(tmp)[0]);
rmSync('public/assets', { recursive: true, force: true });
mkdirSync('public', { recursive: true });
execSync(`cp -r "${join(root, 'assets')}" public/assets`);
rmSync(tmp, { recursive: true, force: true });
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(relative('public', p).replace(/\\/g, '/')); } })('public/assets');
writeFileSync('public/vfs-manifest.json', JSON.stringify({ files }));
console.log(`Listo: ${files.length} archivos en public/assets`);
