/**
 * What to race on a row (#338). Lives in its own module (not the component)
 * so both the picker and the cross-view session state can import the type
 * under plain `tsc`, which does not read a Svelte `<script module>` export.
 */
export type GhostChoice =
  | { kind: 'none' }
  | { kind: 'best' }
  | {
      kind: 'pace';
      paceSPer500: number;
      /**
       * Optional name of what the pace represents, used by the HUD label
       * (#415 AC4.4). Where set, the HUD reads "on {displayName}" rather
       * than "on a 2:13 pace"; where absent, the pace itself is the label,
       * as #338 drew it. The field is optional so the type still accepts a
       * plain pace from the picker.
       */
      displayName?: string;
    };
