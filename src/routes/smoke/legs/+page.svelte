<!--
  #742 VP-22 — parallel-legs smoke page.

  Mounts the engine on the recorded "LOL! Lake Quinsigamond - Lap of the
  Lake" gate chain (rownative course 115): 8.7 km down the lake and back
  with the legs about 40 m apart. No map data, so the water is the route
  ribbon on both legs. `webgpu-parallel-legs.spec.ts` sets
  `window.__SMOKE_LEGS_METERS` and forces frames to traverse the course,
  reading `__ROWER3D_CLEARANCE.surface` under the hull at each step.
  Hidden route, same convention as /smoke/water.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { attach, type RideRenderer } from '../../../lib/renderer';
  import { resolveCourseGeometry, type RownativeCourseGeometryInput } from '../../../lib/services/rownativeGeometry';
  import { toEngineRoute } from '../../../lib/ui/sceneryRoute';
  import { routeTotalDistanceMeters } from '../../../lib/utils/geoUtils';
  import lap from '../../../__tests__/fixtures/rownative/115.json';

  type SmokeWindow = Window & { __SMOKE_LEGS_METERS?: number };

  let canvas: HTMLCanvasElement | null = null;
  let renderer: RideRenderer | null = null;
  let status = 'pending';
  let totalMeters = 0;

  onMount(async () => {
    if (!canvas) return;
    const course = lap as unknown as RownativeCourseGeometryInput;
    const resolved = await resolveCourseGeometry(course);
    totalMeters = routeTotalDistanceMeters(resolved.coordinates);
    const route = toEngineRoute(
      {
        id: `rownative-${course.id}`,
        name: course.name ?? course.id,
        description: '',
        distance: totalMeters / 1000,
        difficulty: 'easy',
        location: '',
        coordinates: resolved.coordinates,
        elevationGain: 0,
        estimatedTime: 0,
        tags: [],
        createdAt: new Date('2026-01-01'),
      },
      null,
      'medium',
    );
    const r = await attach(canvas, {
      testMode: true,
      tier: 'medium',
      route,
      getFrame: () => {
        const metres = (window as SmokeWindow).__SMOKE_LEGS_METERS ?? 0;
        return {
          paceSPer500: 120,
          distanceMeters: metres,
          cadence: 24,
          isPlaying: true,
          holdBoat: false,
          finished: false,
          intensityFactor: 1,
          elapsedSeconds: metres / 4,
          ghost: null,
        };
      },
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

<main data-testid="webgpu-parallel-legs-smoke" data-status={status} data-total-meters={Math.round(totalMeters)}>
  <h1>WebGPU parallel-legs smoke</h1>
  <canvas bind:this={canvas} width="320" height="240" style="width: 320px; height: 240px"></canvas>
</main>
