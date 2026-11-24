import { describe, expect, it } from 'vitest';
import {
  CO_LOCATION_RADIUS_KM,
  chooserMembersForCluster,
  chooserMembersForPin,
  type ChooserMember,
} from '../lib/utils/routeChooserMembers';
import type { WaterRoute } from '../lib/types/index';

const route = (id: string, name: string, lat: number, lng: number): WaterRoute => ({
  id,
  name,
  description: '',
  distance: 2,
  difficulty: 'easy',
  location: '',
  coordinates: [
    { lat, lng },
    { lat, lng },
  ],
  elevationGain: 0,
  estimatedTime: 10,
  tags: [],
  createdAt: new Date(0),
});

const preview = (id: string, name: string, lat: number, lng: number) => ({
  id,
  name,
  distanceMeters: 3000,
  lat,
  lng,
});

const names = (members: ChooserMember[] | null) =>
  members?.map((m) => (m.kind === 'route' ? m.route.name : m.preview.name)) ?? null;

// Two courses at Dan's Stonehaven harbour share one centre (rownative 175 / 181).
const STONEHAVEN_A = preview('175', 'Stonehaven Return', 56.9605, -2.2015);
const STONEHAVEN_B = preview('181', 'CCRC - Stonehaven Return', 56.9605, -2.2015);
// ~6 km south.
const CATTERLINE = preview('176', 'Catterline Return', 56.9065, -2.2075);

describe('chooser members (#822 FR2/FR7)', () => {
  it('uses a 1 km co-location radius', () => {
    expect(CO_LOCATION_RADIUS_KM).toBe(1);
  });

  it('opens on a pin with a neighbour within 1 km, listing both', () => {
    const out = chooserMembersForPin(
      { kind: 'preview', id: '175' },
      [],
      [STONEHAVEN_A, STONEHAVEN_B, CATTERLINE],
      null,
    );
    expect(names(out)).toEqual(['CCRC - Stonehaven Return', 'Stonehaven Return']);
  });

  it('returns null for an isolated pin, so it behaves as before', () => {
    expect(chooserMembersForPin({ kind: 'preview', id: '176' }, [], [STONEHAVEN_A, CATTERLINE], null)).toBeNull();
  });

  it('mixes the user’s routes with previews, default route first', () => {
    const mine = route('mine', 'Zeta harbour loop', 56.961, -2.201);
    const out = chooserMembersForPin({ kind: 'route', id: 'mine' }, [mine], [STONEHAVEN_A, STONEHAVEN_B], 'mine');
    expect(names(out)).toEqual(['Zeta harbour loop', 'CCRC - Stonehaven Return', 'Stonehaven Return']);
  });

  it('skips a preview the user already imported', () => {
    const imported = route('175', 'Stonehaven Return', 56.9605, -2.2015);
    const out = chooserMembersForPin({ kind: 'route', id: '175' }, [imported], [STONEHAVEN_A, STONEHAVEN_B], null);
    expect(out?.map((m) => `${m.kind}:${m.kind === 'route' ? m.route.id : m.preview.id}`)).toEqual([
      'preview:181',
      'route:175',
    ]);
  });

  it('opens on a cluster whose members all lie within 1 km', () => {
    const out = chooserMembersForCluster(
      { routeIds: [], rownativePreviewIds: ['175', '181'] },
      [],
      [STONEHAVEN_A, STONEHAVEN_B, CATTERLINE],
      null,
    );
    expect(names(out)).toEqual(['CCRC - Stonehaven Return', 'Stonehaven Return']);
  });

  it('returns null for a cluster spanning more than 1 km, so it still zooms in', () => {
    expect(
      chooserMembersForCluster(
        { routeIds: [], rownativePreviewIds: ['175', '181', '176'] },
        [],
        [STONEHAVEN_A, STONEHAVEN_B, CATTERLINE],
        null,
      ),
    ).toBeNull();
  });
});
