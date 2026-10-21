/**
 * Appointment letter adapter (Workstream G, spec G.5.2), in the
 * src/lib/task-pdf-adapter.ts shape: all snapshot assembly lives here,
 * so the renderer never reads Firestore and the letter of record is
 * reproducible from the frozen snapshot alone.
 *
 * Two directions:
 * - buildLetterSnapshot(...): register record + taxonomy + issue-time
 *   facts -> the LetterSnapshot frozen onto the instrument.
 * - appointmentToLetterData(instrument, verificationUrl): assembled
 *   ENTIRELY from instrument.letter.snapshot. The register is never
 *   re-read to render a letter; if the register later changes, issued
 *   letters do not move.
 */

import type {
  AppointmentInstrument,
  AppointmentLetterData,
  LetterSnapshot,
  RegisterRecord,
  RoleTaxonomyEntry,
} from '@/types/appointment-instrument';

/**
 * Q-G5 default: while registration is still in process, the masthead
 * carries this line. It must never claim registration. When the
 * registration status source of truth flips, the wording changes here
 * and in the taxonomy snapshot of FUTURE letters only.
 */
export const REGISTRATION_STATUS_LINE_IN_PROCESS =
  'SEDS Pakistan is an independent student-led aerospace engineering initiative. ' +
  'Its registration under the Societies Registration Act 1860 (Act XXI of 1860) is currently in process.';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function humanDate(isoValue: string | null): string {
  if (!isoValue) return '';
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

export interface BuildSnapshotInput {
  instrumentId: string;
  verificationCode: string;
  record: RegisterRecord;
  taxonomy: RoleTaxonomyEntry;
  appointeeDisplayName: string;
  issuedAtMs: number;
  statusLine?: string | null;
}

/** Freeze every value the letter prints, from register + taxonomy. */
export function buildLetterSnapshot(input: BuildSnapshotInput): LetterSnapshot {
  const { record, taxonomy } = input;
  return {
    instrumentNumber: `APT-${input.instrumentId}`,
    verificationCode: input.verificationCode,
    appointeeName: input.appointeeDisplayName,
    roleKey: record.roleKey,
    roleDisplayName: taxonomy.displayName,
    chapterId: record.chapterId,
    chapterName: record.chapterName,
    appointedByName: record.appointedByDisplayName ?? '',
    appointedByOffice: record.appointedByOffice ?? taxonomy.appointedByOffice ?? '',
    authorityReference:
      record.authorityReference ?? taxonomy.authorityReference ?? '',
    appointedAtIso: iso(record.appointedAtMs),
    effectiveFromIso: iso(record.effectiveFromMs),
    termEndsAtIso: taxonomy.termEndsAtMs ? iso(taxonomy.termEndsAtMs) : null,
    issuedAtIso: iso(input.issuedAtMs),
    ratificationRequired: taxonomy.ratificationRequired,
    catalogReference: taxonomy.catalogReference,
    registrationStatusLine: REGISTRATION_STATUS_LINE_IN_PROCESS,
    statusLine: input.statusLine ?? null,
  };
}

/** Renderer data from a frozen snapshot (the only render source). */
export function letterDataFromSnapshot(
  snapshot: LetterSnapshot,
  verificationUrl: string,
  contentHash: string,
): AppointmentLetterData {
  return {
    instrumentNumber: snapshot.instrumentNumber,
    verificationCode: snapshot.verificationCode,
    verificationUrl,
    contentHashShort: contentHash ? contentHash.slice(0, 16) : '',
    issuedDateLine: humanDate(snapshot.issuedAtIso),
    appointeeName: snapshot.appointeeName,
    roleDisplayName: snapshot.roleDisplayName,
    chapterName: snapshot.chapterName,
    appointedByName: snapshot.appointedByName,
    appointedByOffice: snapshot.appointedByOffice,
    authorityReference: snapshot.authorityReference,
    effectiveFromLine: humanDate(snapshot.effectiveFromIso),
    termEndsAtLine: snapshot.termEndsAtIso
      ? humanDate(snapshot.termEndsAtIso)
      : null,
    catalogReference: snapshot.catalogReference,
    ratificationRequired: snapshot.ratificationRequired,
    registrationStatusLine: snapshot.registrationStatusLine,
    statusLine: snapshot.statusLine,
  };
}

/**
 * The G.5.2 entry point: instrument (+ its frozen snapshot) -> renderer
 * data. Throws when the instrument has no issued letter, because
 * rendering from anything but the snapshot would break the letter of
 * record.
 */
export function appointmentToLetterData(
  instrument: AppointmentInstrument,
  verificationUrl: string,
): AppointmentLetterData {
  if (!instrument.letter || !instrument.letter.snapshot) {
    throw new Error(
      `Instrument ${instrument.id} has no issued letter snapshot to render from.`,
    );
  }
  return letterDataFromSnapshot(
    instrument.letter.snapshot,
    verificationUrl,
    instrument.letter.contentHash,
  );
}
