import type { Firestore, DocumentData } from 'firebase/firestore';
import { collection, doc, serverTimestamp, type CollectionReference, type FirestoreDataConverter } from 'firebase/firestore';
import { addDoc, updateDoc, deleteDoc, setDoc } from '@/lib/client/firestore-wrapper';

;

export type CompetitionRecord = {
  id?: string;
  title: string;
  description: string;
  featuredImage: string; // URL for now; storage integration later
  rulebook?: string; // PDF URL
  startDate: string; // ISO string
  endDate: string; // ISO string
  isPublic?: boolean; // default false
  createdAt?: any;
  updatedAt?: any;
};

const converter: FirestoreDataConverter<CompetitionRecord> = {
  toFirestore(record: CompetitionRecord): DocumentData {
    const { id, ...rest } = record;
    return {
      ...rest,
      updatedAt: serverTimestamp(),
    };
  },
  fromFirestore(snapshot): CompetitionRecord {
    const data = snapshot.data() as DocumentData;
    return {
      id: snapshot.id,
      title: data.title,
      description: data.description,
      featuredImage: data.featuredImage,
      rulebook: data.rulebook,
      startDate: data.startDate,
      endDate: data.endDate,
      isPublic: data.isPublic ?? false,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  },
};

export function competitionsCollection(db: Firestore): CollectionReference<CompetitionRecord> {
  return collection(db, 'competitions').withConverter(converter);
}

export async function createCompetition(db: Firestore, data: CompetitionRecord): Promise<string> {
  const col = competitionsCollection(db);
  const docRef = await addDoc(col, { ...data });
  await setDoc(doc(db, 'competitions', docRef.id).withConverter(converter), {
    ...data,
    isPublic: data.isPublic ?? false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateCompetition(db: Firestore, id: string, data: Partial<CompetitionRecord>): Promise<void> {
  const docRef = doc(db, 'competitions', id).withConverter(converter);
  await updateDoc(docRef, { ...data, updatedAt: serverTimestamp() } as any);
}

export async function deleteCompetition(db: Firestore, id: string): Promise<void> {
  const docRef = doc(db, 'competitions', id);
  await deleteDoc(docRef);
}

