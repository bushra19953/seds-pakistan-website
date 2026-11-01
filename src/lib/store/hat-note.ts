/**
 * Company hat notes (spec 3.3). Client-safe constants: no server imports.
 * Every shop money action is proposed under the MzM Corporation company
 * hat, and the note text lives here only, never hardcoded at call sites.
 */
export const SHOP_HAT_NOTE = 'Acting for MzM Corporation (company hat) on this shop action.';

export function payoutHatNote(businessName: string, periodStart: string, periodEnd: string): string {
  return (
    'MzM Corporation (company hat): weekly vendor payout for ' +
    businessName +
    ', week ' +
    periodStart +
    ' to ' +
    periodEnd +
    '.'
  );
}
