import type { Firestore, DocumentData } from 'firebase/firestore';
import { collection, doc, serverTimestamp, getDoc, type CollectionReference, type FirestoreDataConverter } from 'firebase/firestore';
import { addDoc, updateDoc, deleteDoc, setDoc } from '@/lib/client/firestore-wrapper';

;

export type OrganizationType = 'National Chapter' | 'Institutional Partner' | 'Sponsor' | 'University';

export type OrganizationRecord = {
  id?: string;
  name: string;
  logoUrl: string;
  websiteUrl: string;
  type: OrganizationType;
  showOnHomepageMarquee: boolean;
  displayOrder: number;
  isActive: boolean;
  isGlobal: boolean; // Distinguishes global sponsors/partners from local SEDS Pakistan supporters
  description?: string;
  contactEmail?: string;
  contactPhone?: string;
  createdAt?: any;
  updatedAt?: any;
};

export const ORGANIZATION_TYPES: OrganizationType[] = [
  'National Chapter',
  'Institutional Partner',
  'Sponsor',
  'University',
];

const converter: FirestoreDataConverter<OrganizationRecord> = {
  toFirestore(record: OrganizationRecord): DocumentData {
    const { id, ...rest } = record;
    return {
      ...rest,
      updatedAt: serverTimestamp(),
      // Only set createdAt once via setDoc on create
    };
  },
  fromFirestore(snapshot): OrganizationRecord {
    const data = snapshot.data() as DocumentData;
    return {
      id: snapshot.id,
      name: data.name,
      logoUrl: data.logoUrl,
      websiteUrl: data.websiteUrl,
      type: data.type,
      showOnHomepageMarquee: data.showOnHomepageMarquee,
      displayOrder: data.displayOrder,
      isActive: data.isActive,
      isGlobal: data.isGlobal !== undefined ? data.isGlobal : true, // Default to true for backward compatibility
      description: data.description,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  },
};

export function organizationsCollection(db: Firestore): CollectionReference<OrganizationRecord> {
  return collection(db, 'organizations').withConverter(converter);
}

export async function createOrganization(db: Firestore, data: OrganizationRecord): Promise<string> {
  const col = organizationsCollection(db);
  const docRef = await addDoc(col, data);
  // Ensure createdAt is set once (Firestore server time)
  await setDoc(doc(db, 'organizations', docRef.id).withConverter(converter), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateOrganization(db: Firestore, id: string, data: Partial<OrganizationRecord>): Promise<void> {
  const docRef = doc(db, 'organizations', id).withConverter(converter);
  await updateDoc(docRef, { ...data, updatedAt: serverTimestamp() } as any);
}

export async function deleteOrganization(db: Firestore, id: string): Promise<void> {
  const docRef = doc(db, 'organizations', id);
  await deleteDoc(docRef);
}

export async function getOrganization(db: Firestore, id: string): Promise<OrganizationRecord | null> {
  const docRef = doc(db, 'organizations', id).withConverter(converter);
  const snapshot = await getDoc(docRef);
  return snapshot.exists() ? snapshot.data() : null;
}