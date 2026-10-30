/**
 * South Asia Cloud Aerospace Grand Prix 2026: squad registration logic.
 *
 * Pure, dependency free validation and bracket cap logic for the common
 * dual nation registration intake (task SEDS-TASK-BILAT-PORTAL-6.10).
 * The API route at src/app/api/grand-prix/registrations/route.ts is a thin
 * Firestore shell around these functions, and the public form at
 * src/app/grand-prix/register imports the shared constants and types.
 *
 * Bracket rules (bilateral deployment package, 2026-10-28):
 * - 30 squads total, strictly 15 from Pakistan and 15 from Sri Lanka.
 * - 10 squads per track across both nations (Rocketry, Robotics, FlatSats).
 * - Every squad has exactly 5 seats.
 * - The portal locks when the bracket fills or at the deadline,
 *   Nov 15 2026, 23:59 Asia/Karachi, whichever comes first.
 */

export const GRAND_PRIX_NAME = 'South Asia Cloud Aerospace Grand Prix 2026';

export const REGISTRATION_CLOSE_ISO = '2026-11-15T23:59:00+05:00';
export const REGISTRATION_CLOSE_MS = Date.parse(REGISTRATION_CLOSE_ISO);

export const SQUAD_SIZE = 5;
export const MAX_SQUADS_TOTAL = 30;
export const MAX_SQUADS_PER_NATION = 15;
export const MAX_SQUADS_PER_TRACK = 10;

export const NATIONS = ['PK', 'LK'] as const;
export type Nation = (typeof NATIONS)[number];

export const NATION_LABELS: Record<Nation, string> = {
  PK: 'Pakistan',
  LK: 'Sri Lanka',
};

export const TRACKS = ['rocketry', 'robotics', 'flatsat'] as const;
export type Track = (typeof TRACKS)[number];

export const TRACK_LABELS: Record<Track, string> = {
  rocketry: 'Sounding Rocketry',
  robotics: 'Planetary Robotics',
  flatsat: 'SmallSat / FlatSat',
};

export interface SquadMemberInput {
  fullName: string;
  studentId: string;
  email: string;
  discipline: string;
  whatsapp?: string;
}

export interface RegistrationInput {
  squadName: string;
  nation: string;
  track: string;
  institutionName: string;
  institutionId: string;
  city: string;
  members: SquadMemberInput[];
}

export interface NormalizedMember {
  fullName: string;
  studentId: string;
  email: string;
  discipline: string;
  whatsapp: string | null;
  isLead: boolean;
}

export interface NormalizedRegistration {
  squadName: string;
  nation: Nation;
  track: Track;
  institutionName: string;
  institutionId: string;
  city: string;
  members: NormalizedMember[];
  leadEmail: string;
  studentIdKeys: string[];
}

/**
 * The registration index is a single Firestore document holding every
 * counter and lookup key the caps and duplicate checks need, so one
 * submission costs one read inside its transaction instead of a scan.
 */
export interface RegistrationIndex {
  total: number;
  byNation: Record<Nation, number>;
  byTrack: Record<Track, number>;
  leadEmails: string[];
  squadNameKeys: string[];
  studentIdKeys: string[];
}

export function emptyIndex(): RegistrationIndex {
  return {
    total: 0,
    byNation: { PK: 0, LK: 0 },
    byTrack: { rocketry: 0, robotics: 0, flatsat: 0 },
    leadEmails: [],
    squadNameKeys: [],
    studentIdKeys: [],
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function squadNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Duplicate identity for a student seat: institution plus student ID. */
export function studentIdKey(institutionId: string, studentId: string): string {
  return `${institutionId.trim().toLowerCase()}::${studentId.trim().toLowerCase()}`;
}

export type ValidationResult =
  | { ok: true; value: NormalizedRegistration }
  | { ok: false; errors: string[] };

export function validateRegistration(input: unknown): ValidationResult {
  const errors: string[] = [];
  const raw = (input ?? {}) as Partial<RegistrationInput>;

  const squadName = clean(raw.squadName);
  if (squadName.length < 3) errors.push('Squad name is required (at least 3 characters).');
  if (squadName.length > 80) errors.push('Squad name must be 80 characters or fewer.');

  const nationRaw = clean(raw.nation).toUpperCase();
  if (!(NATIONS as readonly string[]).includes(nationRaw)) {
    errors.push('Nation must be Pakistan (PK) or Sri Lanka (LK).');
  }

  const trackRaw = clean(raw.track).toLowerCase();
  if (!(TRACKS as readonly string[]).includes(trackRaw)) {
    errors.push('Track must be one of: Sounding Rocketry, Planetary Robotics, SmallSat / FlatSat.');
  }

  const institutionName = clean(raw.institutionName);
  if (institutionName.length < 3) errors.push('Institution name is required.');

  const institutionId = clean(raw.institutionId);
  if (institutionId.length < 2) {
    errors.push('Institution verification ID is required.');
  }

  const city = clean(raw.city);
  if (city.length < 2) errors.push('City is required.');

  const rawMembers = Array.isArray(raw.members) ? raw.members : [];
  if (rawMembers.length !== SQUAD_SIZE) {
    errors.push(`A squad must have exactly ${SQUAD_SIZE} members.`);
  }

  const members: NormalizedMember[] = [];
  const seenEmails = new Set<string>();
  const seenStudentKeys = new Set<string>();

  rawMembers.slice(0, SQUAD_SIZE).forEach((memberRaw, i) => {
    const seat = i + 1;
    const m = (memberRaw ?? {}) as Partial<SquadMemberInput>;
    const fullName = clean(m.fullName);
    const studentId = clean(m.studentId);
    const email = clean(m.email).toLowerCase();
    const discipline = clean(m.discipline);
    const whatsapp = clean(m.whatsapp);

    if (fullName.length < 3) errors.push(`Seat ${seat}: full name is required.`);
    if (studentId.length < 2) errors.push(`Seat ${seat}: student ID is required.`);
    if (!EMAIL_RE.test(email)) errors.push(`Seat ${seat}: a valid email is required.`);
    if (discipline.length < 2) errors.push(`Seat ${seat}: discipline or role is required.`);
    if (i === 0 && whatsapp.replace(/\D/g, '').length < 8) {
      errors.push('Seat 1 (squad lead): a valid WhatsApp number is required.');
    }

    if (email && seenEmails.has(email)) {
      errors.push(`Seat ${seat}: this email is already used by another seat in the squad.`);
    }
    if (email) seenEmails.add(email);

    const key = studentIdKey(institutionId, studentId);
    if (studentId && seenStudentKeys.has(key)) {
      errors.push(`Seat ${seat}: this student ID is already used by another seat in the squad.`);
    }
    if (studentId) seenStudentKeys.add(key);

    members.push({
      fullName,
      studentId,
      email,
      discipline,
      whatsapp: i === 0 ? whatsapp : null,
      isLead: i === 0,
    });
  });

  if (errors.length > 0) return { ok: false, errors };

  const nation = nationRaw as Nation;
  const track = trackRaw as Track;
  return {
    ok: true,
    value: {
      squadName,
      nation,
      track,
      institutionName,
      institutionId,
      city,
      members,
      leadEmail: members[0].email,
      studentIdKeys: members.map((m) => studentIdKey(institutionId, m.studentId)),
    },
  };
}

export type CapCheckResult =
  | { ok: true; nextIndex: RegistrationIndex }
  | { ok: false; error: string; status: 409 | 410 };

/**
 * Checks one normalized registration against the bracket index and returns
 * the index as it should stand after this squad is written. A full nation
 * or track closes only that slice; a full bracket closes everything.
 */
export function checkCapsAndDuplicates(
  index: RegistrationIndex,
  reg: NormalizedRegistration,
  nowMs: number,
): CapCheckResult {
  if (nowMs > REGISTRATION_CLOSE_MS) {
    return {
      ok: false,
      status: 410,
      error: 'Registration has closed. The deadline was Nov 15, 2026, 23:59 PKT.',
    };
  }
  if (index.total >= MAX_SQUADS_TOTAL) {
    return { ok: false, status: 410, error: 'The 30 squad bracket is full. Registration is closed.' };
  }
  if (index.byNation[reg.nation] >= MAX_SQUADS_PER_NATION) {
    return {
      ok: false,
      status: 409,
      error: `The ${NATION_LABELS[reg.nation]} bracket is full (15 squads).`,
    };
  }
  if (index.byTrack[reg.track] >= MAX_SQUADS_PER_TRACK) {
    return {
      ok: false,
      status: 409,
      error: `The ${TRACK_LABELS[reg.track]} track is full (10 squads).`,
    };
  }
  if (index.leadEmails.includes(reg.leadEmail)) {
    return {
      ok: false,
      status: 409,
      error: 'This squad lead email has already registered a squad.',
    };
  }
  if (index.squadNameKeys.includes(squadNameKey(reg.squadName))) {
    return { ok: false, status: 409, error: 'This squad name is already registered.' };
  }
  const clash = reg.studentIdKeys.find((k) => index.studentIdKeys.includes(k));
  if (clash) {
    return {
      ok: false,
      status: 409,
      error: 'One of the student IDs in this squad is already registered with another squad.',
    };
  }

  const nextIndex: RegistrationIndex = {
    total: index.total + 1,
    byNation: { ...index.byNation, [reg.nation]: index.byNation[reg.nation] + 1 },
    byTrack: { ...index.byTrack, [reg.track]: index.byTrack[reg.track] + 1 },
    leadEmails: [...index.leadEmails, reg.leadEmail],
    squadNameKeys: [...index.squadNameKeys, squadNameKey(reg.squadName)],
    studentIdKeys: [...index.studentIdKeys, ...reg.studentIdKeys],
  };
  return { ok: true, nextIndex };
}

/** Public bracket status for the form header: counts only, never identities. */
export function publicBracketStatus(index: RegistrationIndex, nowMs: number) {
  const closedByDeadline = nowMs > REGISTRATION_CLOSE_MS;
  const closedByBracket = index.total >= MAX_SQUADS_TOTAL;
  return {
    open: !closedByDeadline && !closedByBracket,
    closesAt: REGISTRATION_CLOSE_ISO,
    totalRegistered: index.total,
    seatsTotal: MAX_SQUADS_TOTAL,
    byNation: {
      PK: { registered: index.byNation.PK, cap: MAX_SQUADS_PER_NATION },
      LK: { registered: index.byNation.LK, cap: MAX_SQUADS_PER_NATION },
    },
    byTrack: {
      rocketry: { registered: index.byTrack.rocketry, cap: MAX_SQUADS_PER_TRACK },
      robotics: { registered: index.byTrack.robotics, cap: MAX_SQUADS_PER_TRACK },
      flatsat: { registered: index.byTrack.flatsat, cap: MAX_SQUADS_PER_TRACK },
    },
  };
}
