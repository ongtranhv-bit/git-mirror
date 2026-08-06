import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const roots = ['src', 'test', 'scripts'];
const failures = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:ts|mjs)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/\s+$/.test(line)) failures.push(`${path}:${index + 1}: trailing whitespace`);
        if (line.includes('\t')) failures.push(`${path}:${index + 1}: tab character`);
      });
    }
  }
}
for (const root of roots) await walk(root);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('lint: PASS');
