import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(appDir, '../../dist/apps/lobster-studio');

await mkdir(distDir, { recursive: true });

for (const file of ['index.html', 'styles.css', 'README.md']) {
  await cp(path.join(appDir, file), path.join(distDir, file));
}
