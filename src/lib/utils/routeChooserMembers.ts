import type { Coordinate, WaterRoute } from '../types/index';
import { distanceBetweenMeters } from './coordinateUtils';
import { routeCentroid } from './routeCentroid';
import type { RownativePreviewInput } from './routePinClusters';

/** Routes whose centres lie within this distance are offered together in the chooser (#822 D2). */
export const CO_LOCATION_RADIUS_KM = 1;
const RADIUS_M = CO_LOCATION_RADIUS_KM * 1000;

export type ChooserMember =
  | { kind: 'route'; route: WaterRoute; centre: Coordinate }
  | { kind: 'preview'; preview: RownativePreviewInput; centre: Coordinate };

const memberName = (m: ChooserMember): string =>
  m.kind === 'route' ? m.route.name : (m.preview.name ?? m.preview.id);

function allMembers(
  routes: readonly WaterRoute[],
  previews: readonly RownativePreviewInput[],
): ChooserMember[] {
  const out: ChooserMember[] = [];
  const routeIds = new Set<string>();
  for (const route of routes) {
    routeIds.add(route.id);
    const centre = routeCentroid(route.coordinates);
    if (centre) out.push({ kind: 'route', route, centre });
  }
  for (const preview of previews) {
    if (routeIds.has(preview.id)) continue;
    if (!Number.isFinite(preview.lat) || !Number.isFinite(preview.lng)) continue;
    out.push({ kind: 'preview', preview, centre: { lat: preview.lat, lng: preview.lng } });
  }
  return out;
}

/** Default route first (D5), then alphabetical. */
function sortMembers(members: ChooserMember[], defaultRouteId: string | null): ChooserMember[] {
  const isDefault = (m: ChooserMember) => m.kind === 'route' && m.route.id === defaultRouteId;
  return members.sort((a, b) => {
    if (isDefault(a) !== isDefault(b)) return isDefault(a) ? -1 : 1;
    return memberName(a).localeCompare(memberName(b));
  });
}

/** The pin plus every route/preview within 1 km of it, or null when it stands alone. */
export function chooserMembersForPin(
  pin: { kind: 'route' | 'preview'; id: string },
  routes: readonly WaterRoute[],
  previews: readonly RownativePreviewInput[],
  defaultRouteId: string | null,
): ChooserMember[] | null {
  const members = allMembers(routes, previews);
  const self = members.find(
    (m) => m.kind === pin.kind && (m.kind === 'route' ? m.route.id : m.preview.id) === pin.id,
  );
  if (!self) return null;
  const near = members.filter((m) => distanceBetweenMeters(self.centre, m.centre) <= RADIUS_M);
  return near.length > 1 ? sortMembers(near, defaultRouteId) : null;
}

/** A cluster's members when every pair lies within 1 km (D3), else null so it keeps zooming in. */
export function chooserMembersForCluster(
  cluster: { routeIds: readonly string[]; rownativePreviewIds: readonly string[] },
  routes: readonly WaterRoute[],
  previews: readonly RownativePreviewInput[],
  defaultRouteId: string | null,
): ChooserMember[] | null {
  const routeIds = new Set(cluster.routeIds);
  const previewIds = new Set(cluster.rownativePreviewIds);
  const members = allMembers(routes, previews).filter((m) =>
    m.kind === 'route' ? routeIds.has(m.route.id) : previewIds.has(m.preview.id),
  );
  if (members.length < 2) return null;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (distanceBetweenMeters(members[i].centre, members[j].centre) > RADIUS_M) return null;
    }
  }
  return sortMembers(members, defaultRouteId);
}
