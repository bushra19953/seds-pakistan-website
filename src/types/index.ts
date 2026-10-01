import type { Timestamp } from 'firebase/firestore';

export interface Project {
  id?: string;
  title: string;
  description: string;
  status: string; // e.g., 'draft', 'active', 'archived'
  tags: string[];
  projectUrl?: string;
  imageUrl?: string;
  createdAt: Timestamp;
}

export interface TimelineEvent {
  id?: string;
  year?: string; // derive from date if not provided
  title: string;
  description: string;
  icon: string; // lucide icon key
  date: Timestamp; // stored as Firestore Timestamp
  isPublished?: boolean;
  position?: number;
  link?: string; // optional external reference URL
}

export interface UserActivityEvent {
  id?: string;
  userId: string;
  type: 'task_completed' | 'task_created' | 'project_joined' | 'project_left' | 'badge_awarded';
  timestamp: Timestamp;
  relatedProjectId?: string;
}

export * from './event';
export * from './certificate';
