export interface Chapter {
  id: string;
  name: string;
  slug: string;
  city?: string;
  country?: string;
  isActive?: boolean;
  createdAt?: any; // Firestore Timestamp
  updatedAt?: any; // Firestore Timestamp
}

// ---------------------------------------------------------------------------
// Institutional chapter intake (bank wire / cheque path, decoupled from the
// consumer Stripe checkout). Used by the /register-chapter institutional flow.
// ---------------------------------------------------------------------------

export type ChapterOfficerRole =
  | 'president'
  | 'vice_president'
  | 'secretary'
  | 'treasurer'
  | 'communications';

export const CHAPTER_OFFICER_ROLES: { value: ChapterOfficerRole; label: string }[] = [
  { value: 'president', label: 'President' },
  { value: 'vice_president', label: 'Vice President' },
  { value: 'secretary', label: 'Secretary' },
  { value: 'treasurer', label: 'Treasurer' },
  { value: 'communications', label: 'Communications Officer' },
];

export interface ChapterOfficer {
  role: ChapterOfficerRole;
  name: string;
  email: string;
}

export interface InstitutionalDetails {
  universityName: string;
  campusCity: string;
  deanOrFocalName: string; // Engineering Dean / ORIC Focal Person
  deanOrFocalEmail: string;
  postalAddress: string;
}

export interface LabBeachhead {
  hasExistingSpaceSociety: boolean;
  existingSocietyDetails?: string;
  labFacilities?: string;
  oricEndorsementLetterUrl?: string;
}

export interface InstitutionalChapterIntake {
  applicantId: string;
  applicantName: string;
  applicantEmail: string;
  institutional: InstitutionalDetails;
  officers: ChapterOfficer[]; // exactly 5: president, vice_president, secretary, treasurer, communications
  beachhead: LabBeachhead;
}

export interface ChapterInvoiceLineItem {
  description: string;
  budgetHead: string; // HEC Criterion 6 / OBE budget head
  amount: number;
}

export interface ChapterInvoice {
  invoiceNumber: string;
  applicationId: string;
  issuedAt: string;
  currency: string;
  lineItems: ChapterInvoiceLineItem[];
  total: number;
  payee: string;
  ntn: string;
  bankName: string;
  iban: string;
  invoiceUrl?: string;
}