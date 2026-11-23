/**
 * #734 VP-16 AC1 — "no lattice": the share of a luma patch's spectral
 * energy held by its single strongest non-DC frequency. A checkerboard
 * puts nearly all of it in a handful of bins; a natural water surface
 * spreads it over many.
 *
 * Water seen from a camera also brightens smoothly with distance (Fresnel),
 * which is not a lattice but would land in the lowest bins. So each row
 * (one distance from the camera, near enough) has its mean removed first,
 * and a Hann window keeps the patch's edges from leaking energy.
 */
export const latticePeakShare = (grid: readonly (readonly number[])[]): number => {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  if (h < 2 || w < 2) return 0;
  const hann = (i: number, n: number): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const rows = grid.map((row, y) => {
    const mean = row.reduce((a, b) => a + b, 0) / w;
    return row.map((v, x) => (v - mean) * hann(x, w) * hann(y, h));
  });
  // Separable DFT: along x per row, then along y per column.
  const re: Float64Array[] = [];
  const im: Float64Array[] = [];
  for (let y = 0; y < h; y += 1) {
    const r = new Float64Array(w);
    const i = new Float64Array(w);
    for (let k = 0; k < w; k += 1) {
      for (let x = 0; x < w; x += 1) {
        const a = (-2 * Math.PI * k * x) / w;
        r[k] += rows[y][x] * Math.cos(a);
        i[k] += rows[y][x] * Math.sin(a);
      }
    }
    re.push(r);
    im.push(i);
  }
  let total = 0;
  let peak = 0;
  for (let kx = 0; kx < w; kx += 1) {
    for (let ky = 0; ky < h; ky += 1) {
      let r = 0;
      let i = 0;
      for (let y = 0; y < h; y += 1) {
        const a = (-2 * Math.PI * ky * y) / h;
        const c = Math.cos(a);
        const s = Math.sin(a);
        r += re[y][kx] * c - im[y][kx] * s;
        i += re[y][kx] * s + im[y][kx] * c;
      }
      const p = r * r + i * i;
      total += p;
      if (kx !== 0 || ky !== 0) peak = Math.max(peak, p);
    }
  }
  // Below this the patch is flat and what is left is rounding noise.
  return total > 1e-12 ? peak / total : 0;
};
