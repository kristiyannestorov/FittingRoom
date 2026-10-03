import { InvalidGlbError, parseGlb } from './glb';

function buildGlb(json: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const padding = (4 - (jsonBuffer.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(padding, 0x20)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(paddedJson.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);

  return Buffer.concat([header, chunkHeader, paddedJson]);
}

describe('parseGlb', () => {
  it('rejects a buffer with bad magic bytes', () => {
    expect(() => parseGlb(Buffer.from('not a glb at all'))).toThrow(InvalidGlbError);
  });

  it('rejects a well-formed GLB with no meshes', () => {
    const buffer = buildGlb({ asset: { version: '2.0' }, meshes: [] });
    expect(() => parseGlb(buffer)).toThrow(InvalidGlbError);
  });

  it('parses mesh and triangle counts from a valid GLB', () => {
    const buffer = buildGlb({
      asset: { version: '2.0' },
      accessors: [{ count: 300 }],
      meshes: [{ primitives: [{ indices: 0, mode: 4 }] }],
    });
    const result = parseGlb(buffer);
    expect(result.meshCount).toBe(1);
    expect(result.triangleCount).toBe(100);
  });
});
