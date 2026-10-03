interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function ring(segments: number, radius: number, y: number, centerX = 0): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({ x: centerX + Math.cos(angle) * radius, y, z: Math.sin(angle) * radius });
  }
  return points;
}

function tubeBetweenRings(
  topRing: Vec3[],
  bottomRing: Vec3[],
  vertices: number[],
  indices: number[],
): void {
  const baseIndex = vertices.length / 3;
  const segments = topRing.length;

  for (const p of [...topRing, ...bottomRing]) {
    vertices.push(p.x, p.y, p.z);
  }

  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    const topA = baseIndex + i;
    const topB = baseIndex + next;
    const bottomA = baseIndex + segments + i;
    const bottomB = baseIndex + segments + next;

    indices.push(topA, bottomA, topB);
    indices.push(topB, bottomA, bottomB);
  }
}

export function buildTshirtGlb(colorHex: string): Buffer {
  const vertices: number[] = [];
  const indices: number[] = [];

  const segments = 16;
  const chestRing = ring(segments, 0.26, 1.37);
  const waistRing = ring(segments, 0.24, 1.05);
  tubeBetweenRings(chestRing, waistRing, vertices, indices);

  for (const side of [1, -1]) {
    const shoulderRing = ring(segments / 2, 0.09, 1.4, side * 0.28);
    const elbowRing = ring(segments / 2, 0.08, 1.24, side * 0.42);
    tubeBetweenRings(shoulderRing, elbowRing, vertices, indices);
  }

  const positions = new Float32Array(vertices);
  const useShort = vertices.length / 3 <= 65535;
  const indexArray = useShort ? new Uint16Array(indices) : new Uint32Array(indices);

  const positionsBuffer = Buffer.from(positions.buffer);
  const indicesBufferRaw = Buffer.from(indexArray.buffer);
  const pad = (4 - (indicesBufferRaw.length % 4)) % 4;
  const indicesBuffer = Buffer.concat([indicesBufferRaw, Buffer.alloc(pad, 0)]);

  const binBuffer = Buffer.concat([positionsBuffer, indicesBuffer]);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    minX = Math.min(minX, vertices[i]); maxX = Math.max(maxX, vertices[i]);
    minY = Math.min(minY, vertices[i + 1]); maxY = Math.max(maxY, vertices[i + 1]);
    minZ = Math.min(minZ, vertices[i + 2]); maxZ = Math.max(maxZ, vertices[i + 2]);
  }

  const [r, g, b] = hexToRgb(colorHex);

  const json = {
    asset: { version: '2.0', generator: 'ProjectZed placeholder-glb (no AI provider configured)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'PlaceholderTshirt' }],
    meshes: [
      {
        name: 'PlaceholderTshirt',
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }],
      },
    ],
    materials: [
      {
        name: 'Fabric',
        pbrMetallicRoughness: { baseColorFactor: [r, g, b, 1], metallicFactor: 0, roughnessFactor: 0.85 },
      },
    ],
    buffers: [{ byteLength: binBuffer.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionsBuffer.length, target: 34962 },
      { buffer: 0, byteOffset: positionsBuffer.length, byteLength: indicesBuffer.length, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: vertices.length / 3,
        type: 'VEC3',
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      {
        bufferView: 1,
        componentType: useShort ? 5123 : 5125,
        count: indices.length,
        type: 'SCALAR',
      },
    ],
  };

  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuffer.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(jsonPad, 0x20)]);

  const totalLength = 12 + 8 + paddedJson.length + 8 + binBuffer.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(paddedJson.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4);

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binBuffer.length, 0);
  binChunkHeader.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jsonChunkHeader, paddedJson, binChunkHeader, binBuffer]);
}
