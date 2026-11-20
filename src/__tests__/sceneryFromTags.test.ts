import { describe, expect, it } from 'vitest';
import { mapOsmTagsToSceneryProfile } from '../lib/utils/sceneryFromTags';

describe('mapOsmTagsToSceneryProfile', () => {
  it('maps land use to a scenery profile', () => {
    expect(mapOsmTagsToSceneryProfile({ landuse: 'residential' })).toBe('residential');
    expect(mapOsmTagsToSceneryProfile({ landuse: 'industrial' })).toBe('commercial');
    expect(mapOsmTagsToSceneryProfile({ natural: 'sand' })).toBe('beach');
    expect(mapOsmTagsToSceneryProfile()).toBe('fallback');
  });

  it('#712 FR2: broadleaf wood reads as woodland, needleleaf forest as forest-high', () => {
    expect(mapOsmTagsToSceneryProfile({ natural: 'wood' })).toBe('woodland');
    expect(mapOsmTagsToSceneryProfile({ landuse: 'forest' })).toBe('woodland');
    expect(mapOsmTagsToSceneryProfile({ natural: 'wood', leaf_type: 'needleleaved' })).toBe('forest-high');
    expect(mapOsmTagsToSceneryProfile({ landuse: 'forest', leaf_type: 'needleleaved' })).toBe('forest-high');
  });

  it('#712 FR2: parks and gardens read as parkland', () => {
    for (const leisure of ['park', 'garden', 'recreation_ground', 'golf_course', 'common']) {
      expect(mapOsmTagsToSceneryProfile({ leisure })).toBe('parkland');
    }
    for (const landuse of ['allotments', 'cemetery']) {
      expect(mapOsmTagsToSceneryProfile({ landuse })).toBe('parkland');
    }
    expect(mapOsmTagsToSceneryProfile({ leisure: 'marina' })).toBe('fallback');
  });

  it('#712 FR2: scrub / heath / rough grassland read as scrub', () => {
    for (const natural of ['scrub', 'heath', 'grassland']) {
      expect(mapOsmTagsToSceneryProfile({ natural })).toBe('scrub');
    }
    for (const landuse of ['scrub', 'heath']) {
      expect(mapOsmTagsToSceneryProfile({ landuse })).toBe('scrub');
    }
  });

  it('#712 FR2: `place=` settles a segment regardless of landuse', () => {
    expect(mapOsmTagsToSceneryProfile({ place: 'city' })).toBe('small-city');
    expect(mapOsmTagsToSceneryProfile({ place: 'town' })).toBe('town');
    expect(mapOsmTagsToSceneryProfile({ place: 'suburb' })).toBe('town');
    expect(mapOsmTagsToSceneryProfile({ place: 'village' })).toBe('village');
    expect(mapOsmTagsToSceneryProfile({ place: 'hamlet' })).toBe('village');
  });

  it('#712 FR2: residential building values take the residential profile', () => {
    for (const building of ['residential', 'house', 'apartments', 'terrace']) {
      expect(mapOsmTagsToSceneryProfile({ building })).toBe('residential');
    }
    // Any other building value still falls to commercial, as today.
    expect(mapOsmTagsToSceneryProfile({ building: 'warehouse' })).toBe('commercial');
    expect(mapOsmTagsToSceneryProfile({ building: 'church' })).toBe('commercial');
  });

  it('#712 FR2: orchard / vineyard land uses read as orchard', () => {
    expect(mapOsmTagsToSceneryProfile({ landuse: 'orchard' })).toBe('orchard');
    expect(mapOsmTagsToSceneryProfile({ landuse: 'vineyard' })).toBe('orchard');
  });

  it('#712 FR2: farmland / grass / meadow stay farmland', () => {
    for (const landuse of ['farmland', 'grass', 'meadow']) {
      expect(mapOsmTagsToSceneryProfile({ landuse })).toBe('farmland');
    }
  });

  it('#712 FR2: forest beats place=city (higher priority)', () => {
    expect(mapOsmTagsToSceneryProfile({ natural: 'wood', place: 'city' })).toBe('woodland');
  });

  it('#712 FR2: place=city beats residential landuse (settlements are the stronger signal)', () => {
    expect(mapOsmTagsToSceneryProfile({ place: 'city', landuse: 'residential' })).toBe('small-city');
  });
});
