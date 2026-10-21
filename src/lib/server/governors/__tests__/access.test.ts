/**
 * Board register authorization matrix (spec C.7 cases 22-26).
 */

import { FOUNDER_UID } from '@/lib/roles';
import { canEditRegister, isRegisterReader } from '@/lib/server/governors/access';

it('the Founder reads and edits by UID whatever their role string', () => {
  expect(isRegisterReader(FOUNDER_UID, 'member')).toBe(true);
  expect(canEditRegister(FOUNDER_UID, 'member')).toBe(true);
});

it('the National General Secretary reads and edits', () => {
  expect(isRegisterReader('ngs-uid', 'national_general_secretary')).toBe(true);
  expect(canEditRegister('ngs-uid', 'national_general_secretary')).toBe(true);
});

it('the Founder Patron reads but does not edit', () => {
  expect(isRegisterReader('patron-uid', 'founder_patron')).toBe(true);
  expect(canEditRegister('patron-uid', 'founder_patron')).toBe(false);
});

it('seated Governors (governor_* roles) read but do not edit', () => {
  expect(isRegisterReader('gov-uid', 'governor_seat_fa_1')).toBe(true);
  expect(isRegisterReader('gov-uid', 'governor_seat_me_2')).toBe(true);
  expect(canEditRegister('gov-uid', 'governor_seat_fa_1')).toBe(false);
});

it('the CTO alone does NOT read: canAccessAdmin is irrelevant to the register', () => {
  expect(isRegisterReader('cto-uid', 'chief_technology_officer')).toBe(false);
  expect(canEditRegister('cto-uid', 'chief_technology_officer')).toBe(false);
});

it('ordinary members and presidents do not read', () => {
  expect(isRegisterReader('m-uid', 'member')).toBe(false);
  expect(isRegisterReader('p-uid', 'president_national')).toBe(false);
  expect(isRegisterReader('x-uid', null)).toBe(false);
  expect(isRegisterReader('x-uid', undefined)).toBe(false);
});
