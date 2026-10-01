export type Capability = {
  id: string;
  name: string;
  slug: string;
  category?: string;
  status: 'active' | 'archived';
  isFeatured?: boolean;
  iconKey?: string;
  image_url?: string;
  displayOrder?: number;
  assignedUserCount?: number;
  linkedEventCount?: number;
};
