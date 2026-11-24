<!--
  In-map chooser for routes that start within 1 km of each other (#822 FR2-FR5).
  Positioned inside the map's pin layer, so it works over MapLibre and over the
  SVG fallback alike.
-->
<script lang="ts">
  import type { ChooserMember } from '../utils/routeChooserMembers';
  import { formatRouteDistanceKm, formatSnapshotDistance } from '../utils/geometryProvenance';

  interface Props {
    members: readonly ChooserMember[];
    anchor: { x: number; y: number };
    containerSize: { w: number; h: number };
    defaultRouteId: string | null;
    onPick: (member: ChooserMember) => void;
    onClose: () => void;
  }

  let { members, anchor, containerSize, defaultRouteId, onPick, onClose }: Props = $props();

  const WIDTH = 280;
  const GAP = 14;
  const EDGE = 8;

  let popupEl = $state<HTMLDivElement | undefined>(undefined);
  let height = $state(0);

  const left = $derived(
    Math.max(EDGE, Math.min(anchor.x - WIDTH / 2, Math.max(EDGE, containerSize.w - WIDTH - EDGE))),
  );
  const top = $derived.by(() => {
    const below = anchor.y + GAP;
    if (below + height <= containerSize.h - EDGE) return below;
    const above = anchor.y - GAP - height;
    return Math.max(EDGE, above);
  });

  const itemKey = (m: ChooserMember) => (m.kind === 'route' ? `r:${m.route.id}` : `rn:${m.preview.id}`);
  const memberName = (m: ChooserMember) => (m.kind === 'route' ? m.route.name : (m.preview.name ?? m.preview.id));
  const memberDistance = (m: ChooserMember) =>
    m.kind === 'route'
      ? formatRouteDistanceKm(m.route.distance)
      : formatSnapshotDistance(m.preview.distanceMeters);

  const items = () => Array.from(popupEl?.querySelectorAll<HTMLButtonElement>('[data-testid="route-chooser-item"]') ?? []);

  $effect(() => {
    items()[0]?.focus();
  });

  $effect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (popupEl && e.target instanceof Node && !popupEl.contains(e.target)) onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
    list[next]?.focus();
  }
</script>

<div
  class="route-chooser"
  data-testid="route-chooser-popup"
  role="dialog"
  aria-label={`${members.length} routes start here — choose one`}
  tabindex="-1"
  bind:this={popupEl}
  bind:clientHeight={height}
  style="left: {left}px; top: {top}px; width: {WIDTH}px;"
  onkeydown={onKeydown}
>
  <p class="route-chooser__title">{members.length} routes start here</p>
  <ul class="route-chooser__list">
    {#each members as member (itemKey(member))}
      {@const isDefault = member.kind === 'route' && member.route.id === defaultRouteId}
      <li>
        <button
          type="button"
          class="route-chooser__item"
          data-testid="route-chooser-item"
          data-kind={member.kind}
          onclick={() => onPick(member)}
        >
          <span class="route-chooser__name">
            {#if isDefault}<span class="route-chooser__star" aria-label="Default route">★</span>{/if}
            {memberName(member)}
          </span>
          <span class="route-chooser__meta">
            {#if memberDistance(member)}<span>{memberDistance(member)}</span>{/if}
            {#if member.kind === 'route'}
              <span class="badge badge-{member.route.difficulty}">{member.route.difficulty}</span>
            {:else}
              <span class="badge badge-source">rownative.icu</span>
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>
</div>
