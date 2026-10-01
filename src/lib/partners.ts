import type { Firestore, DocumentData } from 'firebase/firestore';
import { collection, doc, serverTimestamp, getFirestore, type CollectionReference, type FirestoreDataConverter } from 'firebase/firestore';
import { addDoc, updateDoc, deleteDoc, setDoc } from '@/lib/client/firestore-wrapper';

;

export type RelationshipType =
  | 'Sponsor'
  | 'Technical Partner'
  | 'Media Partner'
  | 'In-Kind Donor'
  | 'Academic Collaborator';

export type RelationshipStatus =
  | 'Prospect'
  | 'In Negotiation'
  | 'Active'
  | 'Past'
  | 'On Hold';

export type SponsorshipTier =
  | 'Platinum'
  | 'Gold'
  | 'Silver'
  | 'Bronze'
  | 'Custom';

// New Types for Threaded CRM
export type InteractionType = 'call' | 'email' | 'meeting' | 'whatsapp' | 'note';
export type Direction = 'sent' | 'received';

export interface Interaction {
  id: string; // UUID
  type: InteractionType;
  direction: Direction;
  content: string;
  timestamp: any; // Firestore Timestamp
  author: string;
  attachments?: string[]; // Updated from attachmentUrl
}

export type PartnerRecord = {
  id?: string;
  organizationName: string;
  logoUrl?: string;
  website?: string;
  relationshipType: RelationshipType;
  status: RelationshipStatus;
  sponsorshipTier?: SponsorshipTier;
  primaryContact?: {
    name?: string;
    email?: string;
    phone?: string;
    role?: string;
  };
  financials?: {
    pledgedAmount?: number;
    amountReceived?: number;
    agreementDate?: string;
  };
  agreementContractUrl?: string;
  agreementIntelligence?: {
    key_clauses: string[];
    deliverables_promised: string[];
    support_offered: string[];
    risk_factors: string[];
  };
  // Deprecated: use timeline instead
  interactionHistory?: Array<{ timestamp?: any; note: string; author?: string }>;

  // New Relationship Data
  timeline?: Interaction[];
  relationshipScore?: number; // 1-10
  lastContactAt?: any; // Timestamp (Legacy/Specific to communication)

  // Phase 3: Execution Engine
  lastActivityAt?: string; // ISO String - Single source of truth for sorting
  lastActivityType?: string; // 'Email', 'Call', 'Stage Change', 'Manual'
  nextActions?: Array<{
    id: string;
    text: string;
    dueDate?: string; // ISO
    isCompleted: boolean;
    completedAt?: string; // ISO
  }>;

  nextActionDate?: any; // Timestamp (Legacy/Backwards compat)

  integrationPoints?: string;
  strategicContext?: string;
  associatedEventIds?: string[];
  createdAt?: any;
  updatedAt?: any;
};

export const RELATIONSHIP_TYPES: RelationshipType[] = [
  'Sponsor',
  'Technical Partner',
  'Media Partner',
  'In-Kind Donor',
  'Academic Collaborator',
];

export const STATUS_OPTIONS: RelationshipStatus[] = [
  'Prospect',
  'In Negotiation',
  'Active',
  'Past',
  'On Hold',
];

export const SPONSORSHIP_TIERS: SponsorshipTier[] = [
  'Platinum',
  'Gold',
  'Silver',
  'Bronze',
  'Custom',
];

const converter: FirestoreDataConverter<PartnerRecord> = {
  toFirestore(record: PartnerRecord): DocumentData {
    const { id, ...rest } = record;
    // Filter out undefined values to prevent Firestore errors
    const cleanData = Object.entries(rest).reduce((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {} as DocumentData);

    return {
      ...cleanData,
      updatedAt: serverTimestamp(),
      // Only set createdAt once via setDoc on create
    };
  },
  fromFirestore(snapshot): PartnerRecord {
    const data = snapshot.data() as DocumentData;
    return {
      id: snapshot.id,
      organizationName: data.organizationName,
      logoUrl: data.logoUrl,
      website: data.website,
      relationshipType: data.relationshipType,
      status: data.status,
      sponsorshipTier: data.sponsorshipTier,
      primaryContact: data.primaryContact,
      financials: data.financials,
      agreementContractUrl: data.agreementContractUrl,
      agreementIntelligence: data.agreementIntelligence,
      interactionHistory: Array.isArray(data.interactionHistory)
        ? data.interactionHistory
        : (typeof data.interactionHistory === 'string' && data.interactionHistory.trim() !== ''
          ? [{ note: String(data.interactionHistory), author: 'system', timestamp: serverTimestamp() }]
          : []),
      // Map old history to new timeline IF timeline is missing
      timeline: data.timeline || (Array.isArray(data.interactionHistory)
        ? data.interactionHistory.map((h: any, idx: number) => ({
          id: `legacy-${idx}`,
          type: 'note',
          direction: 'sent', // default assumptions
          content: h.note || '',
          timestamp: h.timestamp || null,
          author: h.author || 'Legacy'
        }))
        : []),
      relationshipScore: data.relationshipScore,
      lastContactAt: data.lastContactAt,
      // Phase 3
      lastActivityAt: data.lastActivityAt || (data.updatedAt?.toDate().toISOString() || new Date().toISOString()),
      lastActivityType: data.lastActivityType || 'System Update',
      nextActions: Array.isArray(data.nextActions) ? data.nextActions : [],

      nextActionDate: data.nextActionDate,
      integrationPoints: data.integrationPoints,
      strategicContext: data.strategicContext,
      associatedEventIds: data.associatedEventIds,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  },
};

export function partnersCollection(db: Firestore): CollectionReference<PartnerRecord> {
  return collection(db, 'sponsors_partners').withConverter(converter);
}

export async function createPartner(db: Firestore, data: PartnerRecord): Promise<string> {
  const col = partnersCollection(db);
  const docRef = await addDoc(col, { ...data });
  // Ensure createdAt is set once (Firestore server time)
  await setDoc(doc(db, 'sponsors_partners', docRef.id).withConverter(converter), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updatePartner(db: Firestore, id: string, data: Partial<PartnerRecord>): Promise<void> {
  const docRef = doc(db, 'sponsors_partners', id).withConverter(converter);

  // Clean data to remove undefined values
  const cleanData = Object.entries(data).reduce((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {} as any);

  await updateDoc(docRef, { ...cleanData, updatedAt: serverTimestamp() });
}

export async function deletePartner(db: Firestore, id: string): Promise<void> {
  const docRef = doc(db, 'sponsors_partners', id);
  await deleteDoc(docRef);
}
