import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';

import RowerAppearancePicker from '../lib/ui/RowerAppearancePicker.svelte';
import {
  DEFAULT_ROWER_APPEARANCE,
  type RowerAppearancePreference,
} from '../lib/services/rowerAppearanceService';
import { TOP_PALETTE } from '../components/rower3d/rowerAppearance';

// #542 P1 Row screen: RowerAppearancePicker ported to Svelte, same DOM/testid.
describe('RowerAppearancePicker.svelte', () => {
  it('renders the disclosure with a row per appearance slot', () => {
    const { container } = render(RowerAppearancePicker, {
      appearance: DEFAULT_ROWER_APPEARANCE,
      onChange: vi.fn(),
    });
    expect(container.querySelector('details[data-testid="rower-appearance"]')).not.toBeNull();
    expect(container.querySelector('.rower-appearance-summary')?.textContent).toBe(
      'Rower appearance',
    );
    const labels = Array.from(container.querySelectorAll('.rower-appearance-label')).map((n) =>
      n.textContent,
    );
    // Default hat is 'none', so the hat-colour row is hidden.
    expect(labels).toEqual(['Top', 'Shorts', 'Shoes', 'Hair', 'Hairstyle', 'Hat']);
  });

  it('shows the hat-colour row only when a hat is worn', () => {
    const appearance: RowerAppearancePreference = { ...DEFAULT_ROWER_APPEARANCE, hat: 'cap' };
    const { container } = render(RowerAppearancePicker, { appearance, onChange: vi.fn() });
    const labels = Array.from(container.querySelectorAll('.rower-appearance-label')).map((n) =>
      n.textContent,
    );
    expect(labels).toContain('Hat colour');
  });

  it('reports a slot change when a swatch is picked', async () => {
    const onChange = vi.fn();
    const { container } = render(RowerAppearancePicker, {
      appearance: DEFAULT_ROWER_APPEARANCE,
      onChange,
    });
    // The first swatch row is "Top"; pick a colour other than the current one.
    const topRow = container.querySelector('.rower-appearance-swatches')!;
    const swatches = topRow.querySelectorAll('.rower-appearance-swatch');
    const target = TOP_PALETTE.find((o) => o.id !== DEFAULT_ROWER_APPEARANCE.top)!;
    const index = TOP_PALETTE.findIndex((o) => o.id === target.id);
    await fireEvent.click(swatches[index]);
    expect(onChange).toHaveBeenCalledWith('top', target.id);
  });

  it('shows the Male / Female / Auto switch outside the collapsed disclosure (#672)', () => {
    const { container, getByRole } = render(RowerAppearancePicker, {
      appearance: DEFAULT_ROWER_APPEARANCE,
      onChange: vi.fn(),
      crew: 'female',
      onCrewChange: vi.fn(),
    });
    const female = getByRole('radio', { name: 'Female' });
    expect(female.getAttribute('aria-checked')).toBe('true');
    expect(getByRole('radio', { name: 'Male' }).getAttribute('aria-checked')).toBe('false');
    expect(getByRole('radio', { name: 'Auto' })).toBeTruthy();
    // A closed <details> hides its content from role queries, so the switch
    // must not live inside it.
    expect(container.querySelector('details')?.contains(female)).toBe(false);
  });

  it('reports a rower change when Male is picked (#672)', async () => {
    const onCrewChange = vi.fn();
    const { getByRole } = render(RowerAppearancePicker, {
      appearance: DEFAULT_ROWER_APPEARANCE,
      onChange: vi.fn(),
      crew: 'auto',
      onCrewChange,
    });
    await fireEvent.click(getByRole('radio', { name: 'Male' }));
    expect(onCrewChange).toHaveBeenCalledWith('male');
  });
});
