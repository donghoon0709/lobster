import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(appDir, '../../dist/apps/lobster-studio');
const distScriptsDir = path.join(distDir, 'scripts');

await mkdir(distDir, { recursive: true });
await mkdir(distScriptsDir, { recursive: true });

for (const file of ['index.html', 'styles.css', 'README.md']) {
  await cp(path.join(appDir, file), path.join(distDir, file));
}

for (const file of ['serve.mjs', 'studio-api.mjs']) {
  await cp(path.join(appDir, 'scripts', file), path.join(distScriptsDir, file));
}
