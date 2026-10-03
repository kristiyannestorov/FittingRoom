const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;

export interface ParsedGlb {
  meshCount: number;
  triangleCount: number;
}

export class InvalidGlbError extends Error {}

export function parseGlb(buffer: Buffer): ParsedGlb {
  if (buffer.length < 20) {
    throw new InvalidGlbError('File is too small to be a valid GLB');
  }
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new InvalidGlbError('File is not a valid GLB (bad magic bytes)');
  }

  const totalLength = buffer.readUInt32LE(8);
  if (totalLength > buffer.length) {
    throw new InvalidGlbError('GLB header length does not match file size');
  }

  const jsonChunkLength = buffer.readUInt32LE(12);
  const jsonChunkType = buffer.readUInt32LE(16);
  if (jsonChunkType !== CHUNK_TYPE_JSON) {
    throw new InvalidGlbError('GLB first chunk is not JSON');
  }

  let json: {
    meshes?: { primitives: { indices?: number; mode?: number }[] }[];
    accessors?: { count: number }[];
  };
  try {
    json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonChunkLength));
  } catch {
    throw new InvalidGlbError('GLB JSON chunk is not valid JSON');
  }

  const meshes = json.meshes ?? [];
  if (meshes.length === 0) {
    throw new InvalidGlbError('GLB contains no meshes');
  }

  const accessors = json.accessors ?? [];
  let triangleCount = 0;
  for (const mesh of meshes) {
    for (const primitive of mesh.primitives) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      if (primitive.indices === undefined) continue;
      const accessor = accessors[primitive.indices];
      if (accessor) triangleCount += Math.floor(accessor.count / 3);
    }
  }

  return { meshCount: meshes.length, triangleCount };
}
