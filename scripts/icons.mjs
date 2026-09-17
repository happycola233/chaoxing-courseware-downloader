import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
function crc32(data) { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const text = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([text, data]))); return Buffer.concat([length, text, data, crc]); }
await mkdir(join(root, 'assets'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = x / size, b = y / size;
    let color = [23, 118, 105, 255];
    const radius = .18;
    const cx = Math.max(radius, Math.min(1 - radius, a)), cy = Math.max(radius, Math.min(1 - radius, b));
    if (Math.hypot(a - cx, b - cy) > radius) color = [0, 0, 0, 0];
    if (a > .24 && a < .65 && b > .18 && b < .73) color = [227, 238, 220, 255];
    if (a > .30 && a < .65 && b > .25 && b < .81) color = [255, 255, 250, 255];
    if (a > .38 && a < .58 && ((b > .36 && b < .39) || (b > .45 && b < .48))) color = [118, 165, 143, 255];
    if ((a > .69 && a < .77 && b > .47 && b < .72) || (b > .65 && b < .80 && Math.abs(a - .73) < (.80 - b))) color = [239, 195, 141, 255];
    const offset = y * (1 + size * 4) + 1 + x * 4;
    raw.set(color, offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  await writeFile(join(root, 'assets', 'icon' + size + '.png'), png);
}
console.log('Generated local extension icons.');
