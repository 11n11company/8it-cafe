const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcBody = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcBody);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, crcBody, crcBuf]);
}

function createPng(width, height, isMaskable = false) {
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Raw image scanlines
  const rawData = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;

  const bgR = 0x06, bgG = 0x3F, bgB = 0x2E; // Deep Green #063F2E
  const accentR = 0x9E, accentG = 0xE2, accentB = 0xB3; // Mint Green #9EE2B3
  const whiteR = 0xFF, whiteG = 0xFF, whiteB = 0xFF; // White #FFFFFF

  const cx = width / 2;
  const cy = height / 2;
  const cornerRadius = isMaskable ? 0 : width * 0.22;

  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0; // filter byte: None
    for (let x = 0; x < width; x++) {
      // Check rounded rect if not maskable
      let alpha = 255;
      if (!isMaskable) {
        const dx = Math.abs(x - cx) - (cx - cornerRadius);
        const dy = Math.abs(y - cy) - (cy - cornerRadius);
        if (dx > 0 && dy > 0 && (dx * dx + dy * dy > cornerRadius * cornerRadius)) {
          alpha = 0;
        }
      }

      if (alpha === 0) {
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        continue;
      }

      // Draw stylized badge inside
      // Inner circle / emblem area
      const distToCenter = Math.hypot(x - cx, y - cy);
      const isInnerRing = distToCenter > (width * 0.36) && distToCenter < (width * 0.38);

      // Central symbol pattern (Stylized '8' and 'it')
      // Top circle of 8: center at (cx - width*0.08, cy - height*0.06), radius width*0.11
      const d8top = Math.hypot(x - (cx - width * 0.08), y - (cy - height * 0.07));
      const in8top = d8top < (width * 0.12) && d8top > (width * 0.05);

      // Bottom circle of 8: center at (cx - width*0.08, cy + height*0.08), radius width*0.13
      const d8bot = Math.hypot(x - (cx - width * 0.08), y - (cy + height * 0.08));
      const in8bot = d8bot < (width * 0.14) && d8bot > (width * 0.06);

      // 'i' stem and dot
      const inIStem = x >= (cx + width * 0.05) && x <= (cx + width * 0.09) && y >= (cy - height * 0.05) && y <= (cy + height * 0.18);
      const inIDot = Math.hypot(x - (cx + width * 0.07), y - (cy - height * 0.13)) < (width * 0.025);

      // 't' stem and bar
      const inTStem = x >= (cx + width * 0.13) && x <= (cx + width * 0.17) && y >= (cy - height * 0.12) && y <= (cy + height * 0.18);
      const inTBar = x >= (cx + width * 0.10) && x <= (cx + width * 0.20) && y >= (cy - height * 0.05) && y <= (cy - height * 0.01);

      if (in8top || in8bot || inIStem || inIDot || inTStem || inTBar) {
        rawData[offset++] = whiteR;
        rawData[offset++] = whiteG;
        rawData[offset++] = whiteB;
        rawData[offset++] = 255;
      } else if (isInnerRing) {
        rawData[offset++] = accentR;
        rawData[offset++] = accentG;
        rawData[offset++] = accentB;
        rawData[offset++] = 100;
      } else {
        // Subtle vertical gradient on green
        const factor = y / height;
        const r = Math.round(bgR + 4 * factor);
        const g = Math.round(bgG - 14 * factor);
        const b = Math.round(bgB - 10 * factor);
        rawData[offset++] = r;
        rawData[offset++] = g;
        rawData[offset++] = b;
        rawData[offset++] = 255;
      }
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([header, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(__dirname, '../frontend/public/icons');
fs.mkdirSync(iconsDir, { recursive: true });

const targets = [
  { file: 'icon-192x192.png', size: 192, maskable: false },
  { file: 'icon-192x192-maskable.png', size: 192, maskable: true },
  { file: 'icon-512x512.png', size: 512, maskable: false },
  { file: 'icon-512x512-maskable.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false }
];

for (const t of targets) {
  const buf = createPng(t.size, t.size, t.maskable);
  const targetPath = path.join(iconsDir, t.file);
  fs.writeFileSync(targetPath, buf);
  console.log(`Generated: ${targetPath} (${buf.length} bytes)`);
}

// Also write apple-touch-icon to frontend/public root
fs.copyFileSync(
  path.join(iconsDir, 'apple-touch-icon.png'),
  path.join(__dirname, '../frontend/public/apple-touch-icon.png')
);
console.log('Icons generated successfully.');
