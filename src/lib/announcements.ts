import type { Firestore, DocumentData, CollectionReference, FirestoreDataConverter } from 'firebase/firestore';
import { collection } from 'firebase/firestore';

export interface AnnouncementDoc {
  id: string;
  title?: string;
  content?: string;
  audience?: string;
  status?: string;
  isFeatured?: boolean;
  ctaText?: string;
  ctaLink?: string;
  ctaExpiredText?: string;
  expiresAt?: any; // Firestore Timestamp or ISO string
  updated_at?: any; // Firestore Timestamp or ISO string
}

const announcementConverter: FirestoreDataConverter<AnnouncementDoc> = {
  toFirestore(data: AnnouncementDoc): DocumentData {
    return {
      title: data.title,
      content: data.content,
      audience: data.audience,
      status: data.status,
      isFeatured: data.isFeatured ?? false,
      ctaText: data.ctaText,
      ctaLink: data.ctaLink,
      ctaExpiredText: data.ctaExpiredText,
      expiresAt: data.expiresAt ?? null,
      updated_at: data.updated_at ?? null,
    };
  },
  fromFirestore(snapshot): AnnouncementDoc {
    const d = snapshot.data();
    return {
      id: snapshot.id,
      title: d.title,
      content: d.content,
      audience: d.audience,
      status: d.status,
      isFeatured: d.isFeatured,
      ctaText: d.ctaText,
      ctaLink: d.ctaLink,
      ctaExpiredText: d.ctaExpiredText,
      expiresAt: d.expiresAt,
      updated_at: d.updated_at,
    };
  },
};

export function announcementsCollection(db: Firestore): CollectionReference<AnnouncementDoc> {
  return collection(db, 'announcements').withConverter(announcementConverter);
}

