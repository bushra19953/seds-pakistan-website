/**
 * Blog post data structure
 */

// Legacy BlogPost interface for backward compatibility
export interface BlogPost {
  id: string;
  title: string;
  body: string;
  authorUid: string;
  authorName?: string;
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
  tags?: string[];
}

// Extended interfaces for Emorational components
export interface VerificationMetric {
  label: string;
  value: string;
  verified: boolean;
}

export interface TechnicalSpec {
  label: string;
  value: string;
  status: 'verified' | 'optimal' | 'excellent' | 'nominal' | 'perfect' | 'complete';
  unit: string;
}

export interface EngineeringSeal {
  certifiedBy: string;
  certificationLevel: string;
  validatedDate: string;
}

export interface AuthorProfile {
  name: string;
  title: string;
  avatar?: string;
  location: string;
  achievements: string[];
  credentials: string[];
}

export interface ArchiveDocument {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  date: string;
  author: string;
  tags: string[];
  category: 'design' | 'test' | 'technical' | 'historical';
}

export interface FutureHorizon {
  id: string;
  title: string;
  description: string;
  timeline: string;
  impact: 'revolutionary' | 'transformative' | 'groundbreaking';
  category: 'exploration' | 'technology' | 'research' | 'mission';
  progress: number;
}

// Extended blog post interface with Emorational data
export interface EmorationalBlogPost extends BlogPost {
  // Basic fields (inherited from BlogPost)
   
  // Enhanced metadata
  thumbnailUrl?: string;
  summary?: string;
  slug?: string;
  metaTitle?: string;
  metaDescription?: string;
  keywords?: string;
  newsArticleUrl?: string;
  status: 'draft' | 'pending_review' | 'published';
  categoryId?: string;
  
  // Emorational component data
  launchReadiness?: {
    verificationMetrics: VerificationMetric[];
  };
  
  dataShowcase?: {
    technicalSpecs: TechnicalSpec[];
    engineeringSeal: EngineeringSeal;
  };
  
  authorProfile?: AuthorProfile;
  
  analogArchive?: {
    documents: ArchiveDocument[];
  };
  
  futureHorizons?: {
    horizons: FutureHorizon[];
    primaryAction?: {
      text: string;
      url: string;
    };
    secondaryAction?: {
      text: string;
      url: string;
    };
  };
}