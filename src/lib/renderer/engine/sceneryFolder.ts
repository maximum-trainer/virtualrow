/**
 * The folder under `public/assets/scenery/` a scenery model is served from,
 * by its id: the kit tiers by their letter, and a model the monthly llm-cad
 * run generated (`r-<course>-<name>`, #449 FR5) under its course id.
 */
const GENERATED = /^r-(\d+)-/;

export const sceneryFolderFor = (id: string): string => {
  const generated = GENERATED.exec(id);
  if (generated) return `tier-r/${generated[1]}`;
  const prefix = id[0]?.toLowerCase() ?? 'a';
  return `tier-${'abcdefgl'.includes(prefix) ? prefix : 'a'}`;
};
