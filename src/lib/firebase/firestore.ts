import type { Firestore } from 'firebase/firestore';
import { collection, getDocs, orderBy, query, doc, getDoc, where, limit } from 'firebase/firestore';
;
import type { TimelineEvent, Project } from '@/types';
import type { Chapter } from '@/types/chapter';
import { addDoc, updateDoc, deleteDoc, setDoc } from '@/lib/client/firestore-wrapper';

const COLLECTION_NAME = 'timeline';
const PROJECTS_COLLECTION = 'projects';
const CHAPTERS_COLLECTION = 'chapters';

export async function getTimelineEvents(
  firestore: Firestore
): Promise<TimelineEvent[]> {
  const ref = collection(firestore, COLLECTION_NAME);
  const q = query(ref, orderBy('date', 'asc'));
  const snapshot = await getDocs(q);

  return snapshot.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<TimelineEvent, 'id'>),
  }));
}

export async function addTimelineEvent(
  firestore: Firestore,
  event: Omit<TimelineEvent, 'id'>
): Promise<string> {
  const ref = collection(firestore, COLLECTION_NAME);
  const docRef = await addDoc(ref, event);
  return docRef.id;
}

export async function updateTimelineEvent(
  firestore: Firestore,
  id: string,
  partial: Partial<Omit<TimelineEvent, 'id'>>
): Promise<void> {
  const ref = doc(firestore, COLLECTION_NAME, id);
  await updateDoc(ref, partial);
}

export async function deleteTimelineEvent(
  firestore: Firestore,
  id: string
): Promise<void> {
  const ref = doc(firestore, COLLECTION_NAME, id);
  await deleteDoc(ref);
}

// Projects CRUD
export async function getProjects(
  firestore: Firestore
): Promise<Project[]> {
  const ref = collection(firestore, PROJECTS_COLLECTION);
  const q = query(ref, orderBy('createdAt', 'desc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Project, 'id'>) }));
}

export async function addProject(
  firestore: Firestore,
  project: Omit<Project, 'id'>
): Promise<string> {
  const ref = collection(firestore, PROJECTS_COLLECTION);
  const docRef = await addDoc(ref, project);
  return docRef.id;
}

export async function updateProject(
  firestore: Firestore,
  id: string,
  partial: Partial<Omit<Project, 'id'>>
): Promise<void> {
  const ref = doc(firestore, PROJECTS_COLLECTION, id);
  await updateDoc(ref, partial);
}

export async function deleteProject(
  firestore: Firestore,
  id: string
): Promise<void> {
  const ref = doc(firestore, PROJECTS_COLLECTION, id);
  await deleteDoc(ref);
}

/**
 * Fetch a single project by its slug or document ID.
 * - First attempts direct document lookup using the provided value as ID.
 * - If not found, queries by `slug` field with a limit of 1.
 */
export async function getProjectBySlugOrId(
  firestore: Firestore,
  slugOrId: string
): Promise<Project | null> {
  if (!slugOrId) return null;

  // Try direct doc lookup (treat input as ID)
  try {
    const directRef = doc(firestore, PROJECTS_COLLECTION, slugOrId);
    const directSnap = await getDoc(directRef);
    if (directSnap.exists()) {
      const data = directSnap.data() as Omit<Project, 'id'>;
      return { id: directSnap.id, ...data } as Project;
    }
  } catch (_) {
    // ignore and fallback to slug query
  }

  // Fallback: query by slug
  const ref = collection(firestore, PROJECTS_COLLECTION);
  const q = query(ref, where('slug', '==', slugOrId), limit(1));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  const d = snapshot.docs[0];
  return { id: d.id, ...(d.data() as Omit<Project, 'id'>) } as Project;
}

// Chapters CRUD
export async function getChapters(
  firestore: Firestore
): Promise<Chapter[]> {
  const ref = collection(firestore, CHAPTERS_COLLECTION);
  const q = query(ref, orderBy('name', 'asc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Chapter, 'id'>) }));
}

export async function addChapter(
  firestore: Firestore,
  chapter: Omit<Chapter, 'id'>
): Promise<string> {
  const id = String(chapter.slug || '').trim().toLowerCase();
  const ref = doc(firestore, CHAPTERS_COLLECTION, id);
  await setDoc(ref, chapter as any);
  return id;
}

export async function updateChapter(
  firestore: Firestore,
  id: string,
  partial: Partial<Omit<Chapter, 'id'>>
): Promise<void> {
  const ref = doc(firestore, CHAPTERS_COLLECTION, id);
  await updateDoc(ref, partial as any);
}

export async function deleteChapter(
  firestore: Firestore,
  id: string
): Promise<void> {
  const ref = doc(firestore, CHAPTERS_COLLECTION, id);
  await deleteDoc(ref);
}

export async function getChapterBySlugOrId(
  firestore: Firestore,
  slugOrId: string
): Promise<Chapter | null> {
  if (!slugOrId) return null;

  try {
    const directRef = doc(firestore, CHAPTERS_COLLECTION, slugOrId);
    const directSnap = await getDoc(directRef);
    if (directSnap.exists()) {
      const data = directSnap.data() as Omit<Chapter, 'id'>;
      return { id: directSnap.id, ...data } as Chapter;
    }
  } catch (_) {
    // ignore and fallback
  }

  const ref = collection(firestore, CHAPTERS_COLLECTION);
  const q = query(ref, where('slug', '==', slugOrId), limit(1));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  const d = snapshot.docs[0];
  return { id: d.id, ...(d.data() as Omit<Chapter, 'id'>) } as Chapter;
}
