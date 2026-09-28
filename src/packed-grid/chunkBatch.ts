import { PACKED_GRID_CHUNK_LIMIT, parsePackedGridChunk, type PackedGridChunk } from "./packedGrid";

export const GRID_TRANSFER_BATCH_SIZE = 16;
export interface PackedGridBatch { generation: bigint; chunks: PackedGridChunk[] }

/** MGB1 envelope around unchanged, individually hash-validated PackedGrid v1 chunks. */
export async function parseGridChunkBatch(buffer: ArrayBuffer, indices: readonly number[]): Promise<PackedGridBatch> {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0) !== 0x4d474231) throw new Error("Invalid grid batch header");
  const count = view.getUint32(4);
  if (count < 1 || count > GRID_TRANSFER_BATCH_SIZE || count !== indices.length) throw new Error("Invalid grid batch count");
  let offset = 8;
  const chunks: PackedGridChunk[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 4 > buffer.byteLength) throw new Error("Truncated grid batch length");
    const length = view.getUint32(offset); offset += 4;
    if (length < 1 || length > PACKED_GRID_CHUNK_LIMIT || offset + length > buffer.byteLength) throw new Error("Invalid grid batch length");
    const chunk = await parsePackedGridChunk(buffer.slice(offset, offset + length));
    if (chunk.descriptor.index !== indices[i] || (chunks.length && chunk.generation !== chunks[0].generation)) {
      throw new Error("Grid batch identity/order mismatch");
    }
    chunks.push(chunk); offset += length;
  }
  if (offset !== buffer.byteLength) throw new Error("Unexpected grid batch trailing bytes");
  return { generation: chunks[0].generation, chunks };
}
