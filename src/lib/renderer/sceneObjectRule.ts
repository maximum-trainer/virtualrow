/**
 * #890 FR9 / FR10 — the engine scene-object rule (#623, CLAUDE.md) as a check.
 *
 * A scene object with an authored kit counterpart is drawn from its GLB through
 * `sceneryMeshPass`; nothing else under `src/lib/renderer` synthesises
 * triangles for it. Every renderer file that issues a draw call or builds an
 * index buffer is listed here with the reason it may. `sceneObjectRule.test.ts`
 * fails `npm run verify` on any such file that is not, so a new runtime
 * geometry path is a deliberate, reviewed entry rather than a quiet addition.
 */

export const GEOMETRY_ROLES = [
  /** Draws authored GLBs (the kit path). */
  'kit',
  /** Still procedural for a category that has, or will have, a kit entry; moves to the kit within #890 (FR11). */
  'procedural-in-scope',
  /** A standing exception the rule names (#623, #890 FR10): geographic strips and the SSR/test boat. */
  'exception',
  /** Particles, weather and debug overlays: no scene object a model could stand for. */
  'effect',
  /** Full-screen, shadow, culling and buffer plumbing: draws no scene object of its own. */
  'infrastructure',
] as const;

export type GeometryRole = (typeof GEOMETRY_ROLES)[number];

export interface GeometryAllowlistEntry {
  file: string;
  role: GeometryRole;
  reason: string;
}

/** Sorted by path; one entry per file. */
export const GEOMETRY_ALLOWLIST: readonly GeometryAllowlistEntry[] = [
  { file: 'src/lib/renderer/engine/msaa.ts', role: 'infrastructure', reason: 'Resolves the multisampled target with a full-screen triangle.' },
  { file: 'src/lib/renderer/engine/postFx.ts', role: 'infrastructure', reason: 'Bloom, SSAO, DOF and FXAA full-screen passes.' },
  { file: 'src/lib/renderer/engine/sceneryMeshBuffers.ts', role: 'kit', reason: 'Uploads the decoded kit GLB vertex and index buffers.' },
  { file: 'src/lib/renderer/engine/sceneryPass.ts', role: 'procedural-in-scope', reason: 'Sprite and cone-stack flora, reeds and rocks; trees move to the tier-E kit (#890 FR2, FR11).' },
  { file: 'src/lib/renderer/engine/shadowStage.ts', role: 'infrastructure', reason: 'Re-draws the lit groups into the shadow cascades.' },
  { file: 'src/lib/renderer/engine/textures.ts', role: 'infrastructure', reason: 'Generates mip levels with a full-screen blit.' },
  { file: 'src/lib/renderer/engine/uniforms.ts', role: 'infrastructure', reason: 'Packs uniform blocks; its integer arrays are not geometry.' },
  { file: 'src/lib/renderer/passes/bank.ts', role: 'exception', reason: 'Draws the geographic bank strip (#623 exception).' },
  { file: 'src/lib/renderer/passes/boat.ts', role: 'kit', reason: 'Draws the scull and crew from the boat GLBs; fleet placeholder slots follow #577 / #713.' },
  { file: 'src/lib/renderer/passes/buildings.ts', role: 'procedural-in-scope', reason: 'OSM footprint extrusion, kept until the generic building kit lands (#623 D3-a, #890 FR3).' },
  { file: 'src/lib/renderer/passes/clouds.ts', role: 'effect', reason: 'Cloud layer over the sky.' },
  { file: 'src/lib/renderer/passes/oarSplashParticles.ts', role: 'effect', reason: 'Oar splash particles.' },
  { file: 'src/lib/renderer/passes/rainOverlay.ts', role: 'effect', reason: 'Full-screen rain overlay.' },
  { file: 'src/lib/renderer/passes/sceneryCull.ts', role: 'infrastructure', reason: 'GPU instance cull writing indirect draw arguments.' },
  { file: 'src/lib/renderer/passes/sceneryMesh.ts', role: 'kit', reason: 'The kit mesh pass every authored scene object is drawn through.' },
  { file: 'src/lib/renderer/passes/sky.ts', role: 'exception', reason: 'Draws the geographic sky dome (#623 exception).' },
  { file: 'src/lib/renderer/passes/wakeParticles.ts', role: 'effect', reason: 'Boat wake particles.' },
  { file: 'src/lib/renderer/passes/water.ts', role: 'exception', reason: 'Draws the geographic water strip (#623 exception).' },
  { file: 'src/lib/renderer/passes/waterDebug.ts', role: 'effect', reason: 'Debug lines over the water footprint.' },
  { file: 'src/lib/renderer/passes/waterPolygon.ts', role: 'exception', reason: 'Draws mapped lake and river polygons (#623 exception).' },
  { file: 'src/lib/renderer/plan/bankStrip.ts', role: 'exception', reason: 'Geographic bank strip along the course (#890 FR10).' },
  { file: 'src/lib/renderer/plan/boatMesh.ts', role: 'exception', reason: 'SSR / test-only boat fallback, never user-facing (#623, #890 FR10).' },
  { file: 'src/lib/renderer/plan/boatMeshLoader.ts', role: 'kit', reason: 'Reads the boat GLB into vertex and index arrays.' },
  { file: 'src/lib/renderer/plan/buildings.ts', role: 'procedural-in-scope', reason: 'Plans the OSM footprint prisms the buildings pass extrudes (#890 FR3).' },
  { file: 'src/lib/renderer/plan/groundPlane.ts', role: 'exception', reason: 'Geographic ground plane under the banks.' },
  { file: 'src/lib/renderer/plan/instanceCells.ts', role: 'infrastructure', reason: 'Bins instances into cull cells; its index arrays are instance ids.' },
  { file: 'src/lib/renderer/plan/instancePools.ts', role: 'infrastructure', reason: 'Batches scenery instances into pools; its index arrays are instance ids.' },
  { file: 'src/lib/renderer/plan/islandLand.ts', role: 'exception', reason: 'Geographic island land inside mapped lakes (#890 FR10).' },
  { file: 'src/lib/renderer/plan/lakeShore.ts', role: 'exception', reason: 'Geographic lake shore ring (#890 FR10).' },
  { file: 'src/lib/renderer/plan/ringBankStrip.ts', role: 'exception', reason: 'Geographic bank ring around a lap course (#890 FR10).' },
  { file: 'src/lib/renderer/plan/waterPolygon.ts', role: 'exception', reason: 'Triangulates mapped water polygons (#890 FR10).' },
  { file: 'src/lib/renderer/plan/waterStrip.ts', role: 'exception', reason: 'Geographic water strip along the course (#890 FR10).' },
];

const DRAW_CALL = /\.(?:draw|drawIndexed|drawIndirect|drawIndexedIndirect)\(/;
const INDEX_BUFFER = /new Uint(?:16|32)Array\(/;

/** Whether a source file issues a draw call or builds an index-sized integer array. */
export const makesGeometry = (text: string): boolean => DRAW_CALL.test(text) || INDEX_BUFFER.test(text);

/** One message per renderer file that makes geometry and is not on the allowlist. */
export const sceneObjectViolations = (
  sources: ReadonlyArray<{ file: string; text: string }>,
  allowlist: readonly GeometryAllowlistEntry[] = GEOMETRY_ALLOWLIST,
): string[] => {
  const listed = new Set(allowlist.map((entry) => entry.file));
  return sources
    .filter(({ file, text }) => !listed.has(file) && makesGeometry(text))
    .map(
      ({ file }) =>
        `${file} draws or builds geometry but is not on GEOMETRY_ALLOWLIST (src/lib/renderer/sceneObjectRule.ts). ` +
        'A scene object with a kit model is drawn from its GLB through sceneryMeshPass (CLAUDE.md, #623, #890); ' +
        'anything else needs an entry with its role and reason.',
    );
};
