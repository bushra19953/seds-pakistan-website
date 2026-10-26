/**
 * DEFECT 3 panel contract (source): the Settlement tab must SHOW
 * computed figures read-only and keep the one genuine manual
 * adjustment (complimentary passes) clearly separated.
 *
 * On base f7885fa0 the panel renders editable <Input> fields for
 * grossTicketCount, ticketPrice and capacity, initialized from the
 * stored settlement (zeros when nothing was ever saved) — so these
 * assertions fail there.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const panel = readFileSync(
  join(process.cwd(), 'src/components/admin/events/event-settlement-panel.tsx'),
  'utf8',
);

describe('settlement panel: computed figures are read-only, manual input is separated', () => {
  it('loads the computed figures from the computed route', () => {
    expect(panel).toContain('/api/admin/events/profit-settlement/computed');
  });

  it('has no editable inputs for the computed figures', () => {
    expect(panel).not.toContain('id="grossTicketCount"');
    expect(panel).not.toContain('id="ticketPrice"');
    expect(panel).not.toContain('id="capacity"');
    expect(panel).not.toContain('setGrossTicketCount');
    expect(panel).not.toContain('setTicketPrice');
    expect(panel).not.toContain('setCapacity');
  });

  it('keeps complimentary passes as the only manual adjustment, in its own labelled block', () => {
    expect(panel).toContain('id="complimentaryCount"');
    expect(panel).toMatch(/Manual adjustment/i);
  });

  it('still saves/signs through the existing settlement route with the computed figures', () => {
    expect(panel).toContain('"/api/admin/events/profit-settlement"');
    expect(panel).toContain('signAs');
  });
});
