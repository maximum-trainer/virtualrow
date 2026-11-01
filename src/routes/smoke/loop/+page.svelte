<!--
  #647 Phase 5 loop smoke page. Mounts the WebGPU engine on a bare canvas
  with a short straight-line route and a stub `getFrame` whose cumulative
  `distanceMeters` grows past the route length, with `loop: true`. The
  Playwright smoke reads `__ROWER3D_POS.progress` across time to confirm
  the boat wraps at the seam (AC5) on a real GPU runner.

  Hidden route under /smoke/loop, no UI link points here.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { attach, type RideFrame, type RideRenderer } from '../../../lib/renderer';

  let canvas: HTMLCanvasElement | null = null;
  let renderer: RideRenderer | null = null;
  let status = 'pending';

  // A 100 m straight line south along -Z. The engine's own curve builder
  // handles two-point routes.
  const ROUTE = {
    curvePoints: [
      [0, 0, 0],
      [0, 0, -100],
    ] as const,
    totalDistanceMeters: 100,
  };

  // Boat speed: 50 m/s along the route, so progress crosses the seam about
  // every two seconds. Fast enough that a 10 s Playwright poll sees several
  // wraps without the harness waiting ages.
  const start = Date.now();
  const stub = (): RideFrame => {
    const elapsed = (Date.now() - start) / 1000;
    const distance = 50 * elapsed;
    return {
      paceSPer500: 100,
      distanceMeters: distance,
      cadence: 24,
      isPlaying: true,
      holdBoat: false,
      finished: false,
      intensityFactor: 1,
      elapsedSeconds: elapsed,
      ghost: null,
      loop: true,
    };
  };

  onMount(async () => {
    if (!canvas) return;
    const r = await attach(canvas, {
      testMode: true,
      route: {
        pools: [],
        curvePoints: ROUTE.curvePoints as unknown as readonly [number, number, number][],
        totalDistanceMeters: ROUTE.totalDistanceMeters,
      },
      getFrame: stub,
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

<main data-testid="webgpu-loop-smoke" data-status={status}>
  <h1>WebGPU loop smoke</h1>
  <canvas bind:this={canvas} width="320" height="240" style="width: 320px; height: 240px"></canvas>
</main>
