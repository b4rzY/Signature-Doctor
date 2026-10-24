import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
let count = 0;
async function walk(dir) {
  for (const file of await readdir(new URL(dir, root), { withFileTypes: true })) {
    if (file.name.startsWith('.') || file.name === 'node_modules' || file.name === 'tmp') continue;
    const path = join(dir, file.name);
    if (file.isDirectory()) await walk(`${path}/`);
    else if (file.name.endsWith('.mjs')) {
      const check = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(path, root))], { encoding: 'utf8' });
      if (check.status !== 0) { process.stderr.write(check.stderr); process.exit(1); }
      count++;
    }
  }
}
await walk('');
for (const file of ['public/index.html', 'public/styles.css', 'examples/angelscript-connect.as', 'README.md']) await readFile(new URL(file, root));
console.log(`Syntax checked ${count} JavaScript modules; required entry files present.`);
