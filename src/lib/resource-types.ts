/**
 * Resource data structure
 */

export type ResourceType = 'software' | 'hardware' | 'collaboration' | 'documentation' | 'tutorial';

export interface Resource {
  id: string;
  title: string;
  description: string;
  type: ResourceType;
  link: string;
  imageUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  curatedBy: string;
  tags?: string[];
}