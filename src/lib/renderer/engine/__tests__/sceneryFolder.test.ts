import { describe, it, expect } from 'vitest';
import { sceneryFolderFor } from '../sceneryFolder';

/** Where the engine fetches a scenery model from, by its id (#449 FR5 / AC9). */
describe('sceneryFolderFor', () => {
  it('keeps each kit tier in its own folder', () => {
    expect(sceneryFolderFor('a09-gazebo-hexagonal')).toBe('tier-a');
    expect(sceneryFolderFor('c01-bridge-arch-masonry')).toBe('tier-c');
    expect(sceneryFolderFor('e04-english-oak')).toBe('tier-e');
    expect(sceneryFolderFor('f45-treeline-strip')).toBe('tier-f');
    expect(sceneryFolderFor('g03-islet')).toBe('tier-g');
    expect(sceneryFolderFor('l01-barnes-railway-bridge')).toBe('tier-l');
  });

  it('puts a generated tier-r model under its course id', () => {
    expect(sceneryFolderFor('r-1-south-cove-gazebo')).toBe('tier-r/1');
    expect(sceneryFolderFor('r-153-newell-boathouse')).toBe('tier-r/153');
  });

  it('falls back to tier-a for an id it does not recognise', () => {
    expect(sceneryFolderFor('scull')).toBe('tier-a');
    expect(sceneryFolderFor('')).toBe('tier-a');
  });
});
