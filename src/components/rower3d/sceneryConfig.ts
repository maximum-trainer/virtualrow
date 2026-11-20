// ============================================================================
// SCENERY PROFILE CONFIG — data-driven visual parameters per OSM scenery profile
//
// Provides the rendering-layer complement to SCENERY_PROFILE_CONFIG in
// routeEnrichmentService.ts.  While the enrichment service stores abstract
// density numbers used for element-placement logic, this module exposes the
// concrete visual properties consumed by vegetationComponents and
// bankComponents when selecting species, scaling trees, filtering ground cover,
// and sizing buildings.
// ============================================================================

import type { SceneryProfile } from '../../lib/services/routeEnrichmentService';

export interface SceneryProfileConfig {
  trees: {
    /**
     * Relative density 0–1.  Scales the number of tree clusters placed per
     * scene unit (1.0 = maximum / dense forest density).
     */
    density: number;
    /**
     * Allowed species types.  Matched against TreeSpeciesEntry.type from
     * themeConfig so that forest routes prefer pines/oaks and beach routes
     * prefer palms.  When none of the theme's species match, all species are
     * used as a fallback.
     */
    species: string[];
    /**
     * #686 D3b — per-species planting weights, same length as `species`.
     * Weights are normalised at pick time so `[6, 3, 1]`, `[60, 30, 10]`
     * and `[0.6, 0.3, 0.1]` all mean the same thing. Undefined means
     * uniform across the allowed species (today's behaviour).
     *
     * Pattern: the first entry is the dominant species, the second the
     * co-dominant, then any long-tail. Dan asked for a non-uniform mix
     * so a bank reads as "mostly oak, some willow, a few ornamental"
     * instead of the monoculture that uniform selection gave when the
     * species list had one broadleaf dominating the three.
     */
    biomeMix?: readonly number[];
    /** [min, max] scale multiplier applied to each tree instance. */
    scaleRange: [number, number];
  };
  groundCover: {
    /** Relative density 0–1.  Scales instance counts for reeds, rocks, etc. */
    density: number;
    /**
     * Ground cover types to show.  Matched against GroundCoverTypeEntry.type
     * from themeConfig.  Types not listed here are hidden for this profile.
     */
    types: string[];
  };
  buildings: {
    /**
     * Probability 0–1 that a landscape slot becomes a building rather than a
     * tree or mountain.  Kept in sync with buildingDensity in
     * SCENERY_PROFILE_CONFIG for consistency.
     */
    probability: number;
    /**
     * [min, max] height multiplier applied to building box geometry.
     * A value of 1.0 = the baseline 12.5 scene-unit height.
     */
    heightRange: [number, number];
  };
}

export const SCENERY_PROFILES: Record<SceneryProfile, SceneryProfileConfig> = {
  forest: {
    trees: {
      density: 1.0,
      species: ['pine', 'oak', 'willow', 'cypress'],
      // Pine-dominated forest, oak co-dominant, willow + cypress as
      // long-tail markers. 50 / 30 / 15 / 5 descending.
      biomeMix: [50, 30, 15, 5],
      scaleRange: [0.85, 1.4],
    },
    groundCover: {
      density: 0.85,
      types: ['rock', 'grass', 'reed'],
    },
    buildings: {
      probability: 0.05,
      heightRange: [0.5, 0.8],
    },
  },

  residential: {
    trees: {
      density: 0.55,
      species: ['oak', 'willow', 'ornamental'],
      // Oak-dominated residential, willow second, ornamental accent.
      // 60 / 30 / 10 — Dan's recommended default for a three-species mix.
      biomeMix: [60, 30, 10],
      scaleRange: [0.7, 1.1],
    },
    groundCover: {
      density: 0.55,
      types: ['grass', 'flower'],
    },
    buildings: {
      probability: 0.4,
      heightRange: [0.8, 1.2],
    },
  },

  commercial: {
    trees: {
      density: 0.15,
      species: ['ornamental'],
      scaleRange: [0.6, 0.9],
    },
    groundCover: {
      density: 0.2,
      types: ['debris', 'rock'],
    },
    buildings: {
      probability: 0.8,
      heightRange: [1.0, 2.0],
    },
  },

  farmland: {
    trees: {
      density: 0.22,
      species: ['oak', 'willow', 'bare'],
      // Hedgerow oak + willow dominant, bare (stumps / dead trees) a
      // sparse accent. 60 / 30 / 10.
      biomeMix: [60, 30, 10],
      scaleRange: [0.7, 1.0],
    },
    groundCover: {
      density: 0.45,
      types: ['grass', 'flower', 'reed'],
    },
    buildings: {
      probability: 0.08,
      heightRange: [0.6, 0.9],
    },
  },

  beach: {
    trees: {
      density: 0.18,
      species: ['palm', 'ornamental'],
      // Palms dominate a beach silhouette; ornamentals as accent.
      // Two-species mix at 75 / 25.
      biomeMix: [75, 25],
      scaleRange: [0.6, 1.0],
    },
    groundCover: {
      density: 0.35,
      types: ['reed', 'grass'],
    },
    buildings: {
      probability: 0.04,
      heightRange: [0.5, 0.7],
    },
  },

  wetland: {
    trees: {
      density: 0.3,
      species: ['willow', 'bare'],
      // Willow-heavy wetland, bare stumps as accent. 80 / 20.
      biomeMix: [80, 20],
      scaleRange: [0.65, 1.0],
    },
    groundCover: {
      density: 0.8,
      types: ['reed', 'grass', 'rock'],
    },
    buildings: {
      probability: 0.03,
      heightRange: [0.4, 0.6],
    },
  },

  fallback: {
    trees: {
      density: 0.45,
      species: ['pine', 'oak', 'willow'],
      // Generic mixed-wood fallback — oak-majority with pine and willow
      // co-dominant enough to break the monoculture read. 50 / 30 / 20.
      biomeMix: [50, 30, 20],
      scaleRange: [0.7, 1.1],
    },
    groundCover: {
      density: 0.5,
      types: ['grass', 'reed', 'rock'],
    },
    buildings: {
      probability: 0.1,
      heightRange: [0.7, 1.0],
    },
  },

  // #712 FR1 phase 1 — richer biome variants. New profiles alias existing
  // species / ground-cover / kit entries until phase 2 ships the authored kit
  // extensions (#712 D4 minimum set).

  scrub: {
    trees: { density: 0.08, species: ['bare', 'ornamental'], biomeMix: [70, 30], scaleRange: [0.5, 0.8] },
    groundCover: { density: 0.4, types: ['rock', 'grass'] },
    buildings: { probability: 0, heightRange: [0.4, 0.6] },
  },
  woodland: {
    trees: {
      density: 0.75,
      species: ['oak', 'willow', 'cypress', 'pine'],
      // Broadleaf-dominant mix — oak-heavy with willow + cypress co-dominant,
      // pine the long-tail accent.
      biomeMix: [50, 25, 15, 10],
      scaleRange: [0.8, 1.3],
    },
    groundCover: { density: 0.7, types: ['grass', 'rock', 'flower'] },
    buildings: { probability: 0.02, heightRange: [0.5, 0.8] },
  },
  'forest-medium': {
    trees: {
      density: 1,
      species: ['pine', 'oak', 'willow', 'cypress'],
      biomeMix: [50, 30, 15, 5],
      scaleRange: [0.85, 1.4],
    },
    groundCover: { density: 0.85, types: ['rock', 'grass', 'reed'] },
    buildings: { probability: 0.05, heightRange: [0.5, 0.8] },
  },
  'forest-high': {
    trees: {
      density: 1,
      species: ['pine', 'cypress', 'oak'],
      // Old-growth conifer-heavy canopy — pine dominant, cypress co-dominant,
      // broadleaf accent.
      biomeMix: [65, 25, 10],
      scaleRange: [0.95, 1.6],
    },
    groundCover: { density: 0.9, types: ['rock', 'reed', 'grass'] },
    buildings: { probability: 0.03, heightRange: [0.4, 0.7] },
  },
  village: {
    trees: {
      density: 0.5,
      species: ['oak', 'willow', 'ornamental'],
      biomeMix: [55, 30, 15],
      scaleRange: [0.7, 1.1],
    },
    groundCover: { density: 0.5, types: ['grass', 'flower'] },
    buildings: { probability: 0.35, heightRange: [0.6, 1.0] },
  },
  town: {
    trees: {
      density: 0.3,
      species: ['ornamental', 'oak'],
      biomeMix: [70, 30],
      scaleRange: [0.65, 0.95],
    },
    groundCover: { density: 0.35, types: ['grass', 'flower', 'debris'] },
    buildings: { probability: 0.7, heightRange: [0.9, 1.5] },
  },
  'small-city': {
    trees: {
      density: 0.15,
      species: ['ornamental'],
      scaleRange: [0.6, 0.9],
    },
    groundCover: { density: 0.2, types: ['debris', 'rock'] },
    buildings: { probability: 0.9, heightRange: [1.5, 3.5] },
  },
  parkland: {
    trees: {
      density: 0.4,
      species: ['oak', 'ornamental', 'willow'],
      biomeMix: [50, 30, 20],
      scaleRange: [0.8, 1.2],
    },
    groundCover: { density: 0.6, types: ['grass', 'flower'] },
    buildings: { probability: 0.02, heightRange: [0.5, 0.8] },
  },
  orchard: {
    trees: {
      density: 0.6,
      species: ['ornamental'],
      scaleRange: [0.7, 0.9],
    },
    groundCover: { density: 0.3, types: ['grass'] },
    buildings: { probability: 0.03, heightRange: [0.5, 0.7] },
  },
};
