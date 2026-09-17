import { readdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const ignored = new Set(['node_modules', '.git', 'dist', 'work', 'downloads', 'private']);
async function walk(dir) { const files = []; for (const item of await readdir(dir, { withFileTypes: true })) { if (ignored.has(item.name)) continue; const path = join(dir, item.name); if (item.isDirectory()) files.push(...await walk(path)); else files.push(path); } return files; }
const files = await walk(root); let failures = 0;
for (const path of files.filter(p => /\.(?:js|mjs)$/.test(p))) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(relative(root, path), result.stderr); failures++; }
}
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
for (const path of [manifest.background.service_worker, ...Object.values(manifest.icons), 'manager.html']) {
  try { await access(join(root, path)); } catch { console.error('Missing packaged file:', path); failures++; }
}
if (manifest.manifest_version !== 3 || manifest.permissions.includes('cookies') || manifest.host_permissions.includes('<all_urls>')) { console.error('Manifest permission check failed.'); failures++; }
const suspicious = [
  /(?:enc|openc|cpi|courseId|chapterId|clazzid|signature|at_|ak_|ad_)\s*[=:]\s*["']?(?:[0-9]{7,}|[a-f0-9]{24,})/i,
  /eyJ[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/,
  /(?:vc3|p_auth_token|cx_p_token|jrose|DSSTASH_LOG)\s*=/i,
  /C:[\\/]+Users[\\/]+[^\s"'<>]+/i
];
for (const path of files.filter(p => ['.js', '.mjs', '.html', '.css', '.md', '.json', '.yml'].includes(extname(p)) && !p.endsWith('package-lock.json'))) {
  const content = await readFile(path, 'utf8');
  if (suspicious.some(pattern => pattern.test(content))) { console.error('Potential private value in:', relative(root, path), '(value omitted)'); failures++; }
}
if (failures) { console.error(failures + ' check(s) failed.'); process.exitCode = 1; }
else console.log('Syntax, manifest assets, permission scope and secret-pattern checks passed (' + files.length + ' files).');
