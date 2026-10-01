import type { Timestamp } from 'firebase/firestore';

export interface Certificate {
  id?: string;
  userId: string;
  userName: string;
  eventName?: string;
  achievement?: string;
  // v2 fields
  title?: string; // primary display title
  description?: string; // optional citation/details
  certificateType?:
    | 'Award of Achievement'
    | 'Certificate of Participation'
    | 'Role Designation'
    | 'Certificate of Appreciation'
    | 'Letter of Invitation';
  templateId?: string; // chosen visual template identifier
  templateUrl?: string; // optional external image URL for visual preview
  issuingAuthority?: string; // e.g., Executive Board
  issuerId?: string;
  issuerName?: string;
  issueDate: Timestamp;
  code: string; // unique verification code
  status?: 'issued' | 'revoked';
  expiresAt?: Timestamp;
}
