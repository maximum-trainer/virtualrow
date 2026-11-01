<!--
  #493 AC6 follow-up — polygon-water smoke page.

  Mounts the WebGPU engine with a canned `SceneryRoute` whose
  `lakePolygons` field carries a single square lake with one small
  island hole. The Playwright spec `webgpu-polygon-water.spec.ts`
  loads this and reads `__ROWER3D_POLYGON_WATER` to tell the Phase 3+
  polygon path from the ribbon fallback (and to assert that the kill
  switch `__VIRTUALROW_POLYGON_WATER = false` flips the engine over
  to the ribbon). Hidden route, same convention as /smoke/engine.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { attach, type RideRenderer } from '../../../lib/renderer';

  let canvas: HTMLCanvasElement | null = null;
  let renderer: RideRenderer | null = null;
  let status = 'pending';

  // A square lake centred at the scene origin with one small square
  // island hole. 160 scene units per side so the simplifier keeps the
  // 4 outer vertices under every tier cap (polygonWaterMaxVertices is
  // 256 at `basic`).
  const lakePolygons = [
    {
      outer: [
        { x: -80, z: -80 },
        { x: 80, z: -80 },
        { x: 80, z: 80 },
        { x: -80, z: 80 },
      ],
      holes: [
        [
          { x: -8, z: -8 },
          { x: 8, z: -8 },
          { x: 8, z: 8 },
          { x: -8, z: 8 },
        ],
      ],
    },
  ];

  onMount(async () => {
    if (!canvas) return;
    const r = await attach(canvas, {
      testMode: true,
      // `isSceneryRoute` demands a `pools` array; empty is fine — this
      // smoke only exercises the lake-polygon telemetry seam.
      route: { pools: [], lakePolygons },
    });
    if (r) {
      renderer = r;
      status = 'ready';
    } else {
      status = 'unavailable';
    }
  });

  onDestroy(() => {
    renderer?.dispose();
    renderer = null;
  });
</script>

<main data-testid="webgpu-polygon-water-smoke" data-status={status}>
  <h1>WebGPU polygon-water smoke</h1>
  <canvas bind:this={canvas} width="320" height="240" style="width: 320px; height: 240px"></canvas>
</main>
