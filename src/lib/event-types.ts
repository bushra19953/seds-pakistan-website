/**
 * Event data structure
 */

export interface Event {
  id: string;
  title: string;
  description: string;
  date: Date;
  location: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  published: boolean;
  publishedAt?: Date;
  imageUrl?: string;
  tags?: string[];
}