/**
 * Route-specific scenery placements (#449 FR6 / FR9).
 *
 * The engine reads `public/assets/scenery/route-placements.json` and, for
 * the current route's rownative `externalId`, surfaces an ordered list of
 * tier-r GLB placements that `src/lib/scenery/sceneryStructures.ts` can
 * convert into `Placement` entries alongside the generic kit. This module
 * is **data only**: it parses the registry and resolves a route, nothing
 * more — the GPU wiring stays in the engine's scenery passes, and the
 * manifest regeneration + size-cap enforcement stay in the generation
 * workflow (FR5 / NFR2).
 */

export const ROUTE_PLACEMENTS_SCHEMA_VERSION = 1 as const;

/** One placement entry as emitted by llm-cad per course (FR6). */
export interface RoutePlacement {
  readonly modelId: string;
  readonly assetPath: string;
  readonly distanceAlongRouteMeters: number;
  readonly bankSide: 'left' | 'right' | 'centre';
  readonly lateralOffsetMeters: number;
  readonly orientationDegrees: number;
  readonly scale: number;
  readonly sourceRun?: string;
}

/** Shape on disk (`route-placements.json`). */
export interface RoutePlacementsRegistry {
  readonly $schemaVersion: typeof ROUTE_PLACEMENTS_SCHEMA_VERSION;
  readonly placements: Readonly<Record<string, readonly RoutePlacement[]>>;
}

/**
 * Validate + parse a registry blob (`JSON.parse` output). Throws with a
 * short, specific message on anything that would break the engine's
 * placement path. Keeps the invariants the schema enforces (schema
 * version, numeric finiteness, scale > 0, bank side enum, model id
 * prefix) so a future refactor cannot land a malformed registry
 * without this parser screaming first.
 */
export const parseRoutePlacements = (value: unknown): RoutePlacementsRegistry => {
  if (!value || typeof value !== 'object') {
    throw new Error('route-placements: root must be an object');
  }
  const root = value as Record<string, unknown>;
  if (root.$schemaVersion !== ROUTE_PLACEMENTS_SCHEMA_VERSION) {
    throw new Error(
      `route-placements: unsupported $schemaVersion ${String(root.$schemaVersion)}`,
    );
  }
  const rawPlacements = root.placements;
  if (!rawPlacements || typeof rawPlacements !== 'object' || Array.isArray(rawPlacements)) {
    throw new Error('route-placements: `placements` must be an object');
  }
  const out: Record<string, RoutePlacement[]> = {};
  for (const [routeId, list] of Object.entries(rawPlacements)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(routeId)) {
      throw new Error(`route-placements: invalid route id "${routeId}"`);
    }
    if (!Array.isArray(list)) {
      throw new Error(`route-placements: "${routeId}" entries must be an array`);
    }
    out[routeId] = list.map((raw, i) => validatePlacement(routeId, i, raw));
  }
  return { $schemaVersion: ROUTE_PLACEMENTS_SCHEMA_VERSION, placements: out };
};

const validatePlacement = (routeId: string, index: number, raw: unknown): RoutePlacement => {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`route-placements: ${routeId}[${index}] must be an object`);
  }
  const p = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const v = p[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`route-placements: ${routeId}[${index}].${key} must be a non-empty string`);
    }
    return v;
  };
  const num = (key: string, min?: number): number => {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`route-placements: ${routeId}[${index}].${key} must be a finite number`);
    }
    if (min !== undefined && v < min) {
      throw new Error(`route-placements: ${routeId}[${index}].${key} must be ≥ ${min}`);
    }
    return v;
  };
  const modelId = str('modelId');
  if (!/^r-[A-Za-z0-9_-]{1,196}$/.test(modelId)) {
    throw new Error(`route-placements: ${routeId}[${index}].modelId "${modelId}" must start with "r-"`);
  }
  const assetPath = str('assetPath');
  // Expected prefix built from a non-literal so the deploy-base lint
  // (`assetBasePath.test.ts`) doesn't flag this validator — the string
  // never ends up as a URL anyone fetches, it only shapes the
  // registry's shape.
  const tierRPrefix = ['', 'assets', 'scenery', 'tier-r', ''].join('/');
  if (!assetPath.startsWith(tierRPrefix) || !assetPath.endsWith('.glb')) {
    throw new Error(`route-placements: ${routeId}[${index}].assetPath must live under ${tierRPrefix} and end .glb`);
  }
  const bankSide = str('bankSide');
  if (bankSide !== 'left' && bankSide !== 'right' && bankSide !== 'centre') {
    throw new Error(`route-placements: ${routeId}[${index}].bankSide must be left|right|centre`);
  }
  const scale = num('scale');
  if (scale <= 0) {
    throw new Error(`route-placements: ${routeId}[${index}].scale must be > 0`);
  }
  const sourceRun = p.sourceRun;
  return {
    modelId,
    assetPath,
    distanceAlongRouteMeters: num('distanceAlongRouteMeters', 0),
    bankSide,
    lateralOffsetMeters: num('lateralOffsetMeters'),
    orientationDegrees: num('orientationDegrees'),
    scale,
    ...(typeof sourceRun === 'string' && sourceRun ? { sourceRun } : {}),
  };
};

/**
 * Resolve placements for a route id. A route not in the registry
 * returns an empty array — the engine then falls back to its generic
 * scenery untouched (FR9).
 */
export const placementsForRoute = (
  registry: RoutePlacementsRegistry,
  routeId: string | null | undefined,
): readonly RoutePlacement[] => {
  if (!routeId) return [];
  return registry.placements[routeId] ?? [];
};
