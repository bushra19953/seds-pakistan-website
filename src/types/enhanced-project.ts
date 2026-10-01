/**
 * Enhanced Project interface with new fields for detailed project pages
 * This extends the existing project structure with additional metadata for enhanced display
 */

export interface ProjectMember {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar?: string;
}

export interface Sponsor {
  id: string;
  name: string;
  logo_url?: string;
  website_url?: string;
}

export interface MediaItem {
  id: string;
  type: 'image' | 'video';
  url: string;
  title?: string;
  description?: string;
  thumbnail_url?: string;
  uploaded_at: Date;
}

export interface Download {
  id: string;
  title: string;
  description?: string;
  file_url: string;
  file_type: 'pdf' | 'doc' | 'zip' | 'other';
  uploaded_at: Date;
}

export type ProjectStatus = 'In Progress' | 'Completed' | 'Archived';

export interface EnhancedProject {
  // Basic fields (existing)
  id: string;
  title: string;
  slug: string;
  summary: string;
  description?: string;
  published: boolean;
  status?: ProjectStatus;
  created_at: string;
  updated_at?: string;
  author_uid: string;
  image_url?: string;
  github_url?: string;
  live_url?: string;
  
  // Enhanced fields for detailed project pages
  project_status?: ProjectStatus;
  team_members?: ProjectMember[];
  tech_stack?: string[];
  sponsors?: Sponsor[];
  media_gallery?: MediaItem[];
  downloads?: Download[];
  
  // SEO and additional metadata
  category?: string;
  tags?: string[];
  featured_on_recruitment_page?: boolean;
  featured_on_sponsorship_page?: boolean;
  
  // Analytics and engagement
  view_count?: number;
  featured_image_url?: string;
  
  // Timestamps
  started_at?: Date;
  completed_at?: Date;
}