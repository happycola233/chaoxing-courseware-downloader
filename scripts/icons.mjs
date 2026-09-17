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
  const lines = [[.5,.24,.5,.59],[.36,.46,.5,.60],[.5,.60,.64,.46],[.26,.64,.26,.76],[.26,.76,.74,.76],[.74,.76,.74,.64]];
  function distance(x,y,x1,y1,x2,y2) {
    const t = Math.max(0, Math.min(1, ((x-x1)*(x2-x1)+(y-y1)*(y2-y1))/((x2-x1)**2+(y2-y1)**2)));
    return Math.hypot(x-x1-t*(x2-x1),y-y1-t*(y2-y1));
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0,0,0,0];
    for (let sy=0;sy<4;sy++) for (let sx=0;sx<4;sx++) {
      const a = (x+(sx+.5)/4)/size, b = (y+(sy+.5)/4)/size;
      const cx = Math.max(.24, Math.min(.76,a)), cy = Math.max(.24, Math.min(.76,b));
      const inside = Math.hypot(a-cx,b-cy) <= .2;
      const ink = lines.some(line => distance(a,b,...line) <= .031);
      const color = inside ? (ink ? [255,255,255,255] : [37,99,235,255]) : [0,0,0,0];
      for (let i=0;i<4;i++) sum[i] += color[i];
    }
    const color = sum.map(c => Math.round(c/16));
    const offset = y * (1 + size * 4) + 1 + x * 4;
    raw.set(color, offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  await writeFile(join(root, 'assets', 'icon' + size + '.png'), png);
}
console.log('Generated local extension icons.');
