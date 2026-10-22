/**
 * Event detail tab logic (the /admin/events/[id] combine): the retired
 * registrations and profit-split routes redirect here with ?tab= set,
 * so those values must resolve to the Attendees / Settlement tabs and
 * unknown values must fall back to Overview instead of stranding the
 * user on a blank tab.
 */

import { resolveEventDetailTab } from '../detail-tabs';

describe('resolveEventDetailTab', () => {
  it.each([
    ['overview', 'overview'],
    ['attendees', 'attendees'],
    ['settlement', 'settlement'],
  ])('maps ?tab=%s to the %s tab', (raw, expected) => {
    expect(resolveEventDetailTab(raw)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['registrations'], ['profit-split'], ['ATTENDEES'], ['edit']])(
    'falls back to Overview for %p',
    (raw) => {
      expect(resolveEventDetailTab(raw as string | null)).toBe('overview');
    },
  );
});
