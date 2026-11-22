import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const passesDir = join(dirname(fileURLToPath(import.meta.url)), '../../passes');

/** Reads `const NAME: f32 = <number>;` out of a pass's WGSL source. */
export const wgslConst = (file: string, name: string): number => {
  const src = readFileSync(join(passesDir, file), 'utf8');
  const m = src.match(new RegExp(`const\\s+${name}\\s*:\\s*f32\\s*=\\s*(-?[0-9.]+)\\s*;`));
  if (!m) throw new Error(`${file} has no f32 const ${name}`);
  return Number(m[1]);
};

export const wgslSource = (file: string): string => readFileSync(join(passesDir, file), 'utf8');
