import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const isSource = process.argv.includes('--source');
const allowed = isSource ? ['src', 'assets', 'scripts', 'tests', 'docs', '.github'] : ['src', 'assets', 'docs'];
const rootFiles = isSource ? ['manifest.json', 'manager.html', 'README.md', 'PRIVACY.md', 'LICENSE', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes'] : ['manifest.json', 'manager.html', 'README.md', 'PRIVACY.md', 'LICENSE'];
async function walk(dir) { const found = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) found.push(...await walk(path)); else found.push(path); } return found; }
const files = rootFiles.map(file => join(root, file));
for (const dir of allowed) { try { files.push(...await walk(join(root, dir))); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
function crc32(data) { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
const local = [], directory = []; let offset = 0;
for (const path of files.sort()) {
  const data = await readFile(path), name = Buffer.from(relative(root, path).replaceAll('\\', '/'));
  const compressed = deflateRawSync(data), crc = crc32(data);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  local.push(header, name, compressed); directory.push(central, name); offset += header.length + name.length + compressed.length;
}
const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
await mkdir(join(root, 'dist'), { recursive: true });
const filename = 'chaoxing-courseware-downloader-v' + pkg.version + (isSource ? '-source' : '') + '.zip';
await writeFile(join(root, 'dist', filename), Buffer.concat([...local, central, end]));
console.log('Created dist/' + filename + ' (' + files.length + ' allowlisted files)');
