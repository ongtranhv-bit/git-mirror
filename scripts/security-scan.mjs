import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const roots = ['src', 'dist'];
const findings = [];
const patterns = [
  { name: 'private key', regex: /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----/ },
  { name: 'GitHub token', regex: /\bgh[opurs]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'credential in HTTPS URL', regex: /https:\/\/[^\s/@:]+:[^\s/@]+@/ },
  { name: 'Firebase auth query', regex: /[?&]auth=[A-Za-z0-9._-]{8,}/ },
];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:js|ts|json|map)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      for (const pattern of patterns) {
        if (pattern.regex.test(text)) findings.push(`${path}: ${pattern.name}`);
      }
    }
  }
}

for (const root of roots) await walk(root);
if (findings.length > 0) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log('security-scan: PASS (no private keys, provider token shapes, auth query values, or credential URLs)');
