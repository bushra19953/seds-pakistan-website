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