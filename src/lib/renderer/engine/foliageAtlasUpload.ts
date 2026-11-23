import type { FoliageAtlas } from '../../scenery/foliageAtlasPaint';

/**
 * #729 FR2 — upload a packed foliage atlas: one `writeTexture` per mip
 * level, every layer in it. Returns false (and writes nothing) on a queue
 * without `writeTexture`, as the attach-test mock is; the atlas stays blank
 * there, which no test depends on.
 */
export const uploadFoliageAtlas = (queue: GPUQueue, texture: GPUTexture, atlas: FoliageAtlas): boolean => {
  if (typeof queue.writeTexture !== 'function') return false;
  atlas.mips.forEach((level, mipLevel) => {
    queue.writeTexture(
      { texture, origin: { x: 0, y: 0, z: 0 }, mipLevel },
      level.pixels as BufferSource,
      { bytesPerRow: level.size * 4, rowsPerImage: level.size },
      { width: level.size, height: level.size, depthOrArrayLayers: atlas.layers },
    );
  });
  return true;
};
