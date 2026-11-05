/**
 * International Aerospace Masterclass Series 2026: individual enrolment logic.
 *
 * Pure validation and window logic for the common dual nation enrolment
 * intake. The API route at src/app/api/grand-prix/registrations/route.ts is
 * a thin Firestore shell around these functions, and the public form at
 * src/app/grand-prix/register imports the shared constants and types.
 *
 * Enrolment windows (all Asia/Karachi):
 * - Initial window: open until Nov 15 2026, 23:59 PKT.
 * - Closed Nov 16 2026 00:00 PKT until late admission opens.
 * - Late admission window: Nov 21 2026, 09:00 PKT to Nov 28 2026, 23:59 PKT.
 * - Closed after Nov 28 2026, 23:59 PKT.
 * There are no seat caps: one enrolment per email and per student ID.
 */

export const SERIES_NAME = 'International Aerospace Masterclass Series 2026';

export const INITIAL_CLOSE_ISO = '2026-11-15T23:59:00+05:00';
export const INITIAL_CLOSE_MS = Date.parse(INITIAL_CLOSE_ISO);
export const LATE_OPEN_ISO = '2026-11-21T09:00:00+05:00';
export const LATE_OPEN_MS = Date.parse(LATE_OPEN_ISO);
export const LATE_CLOSE_ISO = '2026-11-28T23:59:00+05:00';
export const LATE_CLOSE_MS = Date.parse(LATE_CLOSE_ISO);

export const NATIONS = ['PK', 'LK'] as const;
export type Nation = (typeof NATIONS)[number];

export const NATION_LABELS: Record<Nation, string> = {
  PK: 'Pakistan (Open)',
  LK: 'Sri Lanka (Open)',
};

export const MODULES = [
  { id: 'supersonic-aero', title: 'Supersonic Aerodynamics/CFD' },
  { id: 'rocket-propulsion', title: 'Rocket Propulsion Ballistics' },
  { id: 'flight-avionics', title: 'Flight Avionics/Telemetry' },
  { id: 'rover-digital-twins', title: 'Rover Kinematics Digital Twins' },
  { id: 'smallsat-power-comms', title: 'SmallSat Power/Comms' },
  { id: 'orbital-mechanics', title: 'Orbital Mechanics & Trajectory' },
] as const;

export const PASS_TYPES = ['student', 'industry'] as const;
export type PassType = (typeof PASS_TYPES)[number];

export const PASS_LABELS: Record<PassType, string> = {
  student:
    'Collegiate Student Pass ($7.00 USD; PKR equivalent in Pakistan; Sri Lanka fee set by SEDS Sri Lanka)',
  industry:
    'Industry Professional Observer Pass ($15.00 USD flat; industry professionals only; faculty sit free; evaluators sit free)',
};

export const FEE_CALLOUT =
  'Collegiate Student Masterclass Pass: $7.00 USD (PKR equivalent for Pakistan; Sri Lanka fee set by SEDS Sri Lanka) | Industry Professional Observer Pass: $15.00 USD flat (Faculty & Evaluators Sit Free) | 6 Masterclasses + Verified Co-Signed Credential.';

export interface EnrolleeInput {
  fullName: string;
  studentId: string;
  email: string;
  discipline: string;
  whatsapp: string;
}

export interface EnrolmentInput extends EnrolleeInput {
  nation: string;
  passType: string;
  institutionName: string;
  institutionId: string;
  city: string;
}

export interface NormalizedEnrolment extends EnrolleeInput {
  nation: Nation;
  passType: PassType;
  institutionName: string;
  institutionId: string;
  city: string;
  leadEmail: string;
  studentIdKey: string;
}

/**
 * The enrolment index is a single Firestore document holding the counters
 * and lookup keys the duplicate checks need, so one submission costs one
 * read inside its transaction instead of a scan.
 */
export interface RegistrationIndex {
  total: number;
  emails: string[];
  studentIdKeys: string[];
}

export function emptyIndex(): RegistrationIndex {
  return {
    total: 0,
    emails: [],
    studentIdKeys: [],
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Duplicate identity for an enrollee: institution plus student ID. */
export function studentIdKey(institutionId: string, studentId: string): string {
  return `${institutionId.trim().toLowerCase()}::${studentId.trim().toLowerCase()}`;
}

export type WindowState = 'open' | 'closed' | 'late';

export interface WindowStatus {
  state: WindowState;
  open: boolean;
  /** Next deadline that matters: the close of the current window, or the late opening when between windows. */
  closesAt: string | null;
  /** Set only while closed between the two windows. */
  opensAt: string | null;
}

export function getWindowState(nowMs: number): WindowStatus {
  if (nowMs <= INITIAL_CLOSE_MS) {
    return { state: 'open', open: true, closesAt: INITIAL_CLOSE_ISO, opensAt: null };
  }
  if (nowMs < LATE_OPEN_MS) {
    return { state: 'closed', open: false, closesAt: LATE_CLOSE_ISO, opensAt: LATE_OPEN_ISO };
  }
  if (nowMs <= LATE_CLOSE_MS) {
    return { state: 'late', open: true, closesAt: LATE_CLOSE_ISO, opensAt: null };
  }
  return { state: 'closed', open: false, closesAt: null, opensAt: null };
}

export type ValidationResult =
  | { ok: true; value: NormalizedEnrolment }
  | { ok: false; errors: string[] };

export function validateRegistration(input: unknown): ValidationResult {
  const errors: string[] = [];
  const raw = (input ?? {}) as Partial<EnrolmentInput>;

  const fullName = clean(raw.fullName);
  if (fullName.length < 3) errors.push('Full name is required (at least 3 characters).');

  const studentId = clean(raw.studentId);
  if (studentId.length < 2) errors.push('Student ID is required.');

  const email = clean(raw.email).toLowerCase();
  if (!EMAIL_RE.test(email)) errors.push('A valid email is required.');

  const discipline = clean(raw.discipline);
  if (discipline.length < 2) errors.push('Discipline or field is required.');

  const whatsapp = clean(raw.whatsapp);
  if (whatsapp.replace(/\D/g, '').length < 8) {
    errors.push('A valid WhatsApp number is required.');
  }

  const nationRaw = clean(raw.nation).toUpperCase();
  if (!(NATIONS as readonly string[]).includes(nationRaw)) {
    errors.push('Country must be Pakistan (PK) or Sri Lanka (LK).');
  }

  const passRaw = clean(raw.passType).toLowerCase();
  if (!(PASS_TYPES as readonly string[]).includes(passRaw)) {
    errors.push('Pass type must be Collegiate Student Pass or Industry Professional Observer Pass.');
  }

  const institutionName = clean(raw.institutionName);
  if (institutionName.length < 3) errors.push('Institution name is required.');

  const institutionId = clean(raw.institutionId);
  if (institutionId.length < 2) {
    errors.push('Institution verification ID is required.');
  }

  const city = clean(raw.city);
  if (city.length < 2) errors.push('City is required.');

  if (errors.length > 0) return { ok: false, errors };

  const nation = nationRaw as Nation;
  const passType = passRaw as PassType;
  return {
    ok: true,
    value: {
      fullName,
      studentId,
      email,
      discipline,
      whatsapp,
      nation,
      passType,
      institutionName,
      institutionId,
      city,
      leadEmail: email,
      studentIdKey: studentIdKey(institutionId, studentId),
    },
  };
}

export type WindowCheckResult =
  | { ok: true; nextIndex: RegistrationIndex }
  | { ok: false; error: string; status: 409 | 410 };

/**
 * Checks one normalized enrolment against the window and the index, and
 * returns the index as it should stand after this enrolment is written.
 * The window is checked first: outside both windows nothing is admitted.
 */
export function checkWindowAndDuplicates(
  index: RegistrationIndex,
  reg: NormalizedEnrolment,
  nowMs: number,
): WindowCheckResult {
  const window = getWindowState(nowMs);
  if (!window.open) {
    if (window.opensAt !== null) {
      return {
        ok: false,
        status: 410,
        error:
          'Registration is closed. Late admission opens Nov 21, 2026, 09:00 PKT and closes Nov 28, 2026, 23:59 PKT.',
      };
    }
    return {
      ok: false,
      status: 410,
      error: 'Registration has closed. The late admission window ended Nov 28, 2026, 23:59 PKT.',
    };
  }
  if (index.emails.includes(reg.leadEmail)) {
    return {
      ok: false,
      status: 409,
      error: 'This email has already been used for an enrolment.',
    };
  }
  if (index.studentIdKeys.includes(reg.studentIdKey)) {
    return {
      ok: false,
      status: 409,
      error: 'This student ID is already enrolled with another enrolment.',
    };
  }

  const nextIndex: RegistrationIndex = {
    total: index.total + 1,
    emails: [...index.emails, reg.leadEmail],
    studentIdKeys: [...index.studentIdKeys, reg.studentIdKey],
  };
  return { ok: true, nextIndex };
}

/** Public registration status for the form header: window state and dates only, never identities. */
export function publicRegistrationStatus(index: RegistrationIndex, nowMs: number) {
  const window = getWindowState(nowMs);
  return {
    ...window,
    totalRegistered: index.total,
  };
}
