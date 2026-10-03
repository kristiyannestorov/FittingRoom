import { deflateSync } from 'node:zlib';

export function solidColorPng(hex: string, size = 512): Buffer {
  const [r, g, b] = hexToRgb(hex);
  const [br, bg, bb] = [r, g, b].map((c) => Math.max(0, Math.round(c * 0.75)));

  const rowLength = size * 3 + 1;
  const raw = Buffer.alloc(rowLength * size);
  const borderWidth = Math.max(2, Math.round(size * 0.015));

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0;
    const onBorder = y < borderWidth || y >= size - borderWidth;
    for (let x = 0; x < size; x += 1) {
      const pixelStart = rowStart + 1 + x * 3;
      const border = onBorder || x < borderWidth || x >= size - borderWidth;
      raw[pixelStart] = border ? br : r;
      raw[pixelStart + 1] = border ? bg : g;
      raw[pixelStart + 2] = border ? bb : b;
    }
  }

  return encodePng(raw, size, size);
}

function hexToRgb(hex: string): [number, number, number] {
  const normalised = hex.replace('#', '');
  return [
    parseInt(normalised.slice(0, 2), 16),
    parseInt(normalised.slice(2, 4), 16),
    parseInt(normalised.slice(4, 6), 16),
  ];
}

function encodePng(raw: Buffer, width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const idatData = deflateSync(raw);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

let crcTable: number[] | null = null;

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c;
    }
  }

  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
