import { Timestamp } from 'firebase/firestore';

export type ChapterApplicationStatus =
  | 'pending_payment'
  | 'pending_review'
  | 'under_review'
  | 'info_requested'
  | 'approved'
  | 'rejected';

export interface TeamMember {
  name: string;
  email: string;
  role: string; // e.g. 'president', 'vice_president', 'secretary', 'member'
  department: string;
}

export interface FacultyAdvisor {
  name: string;
  email: string;
  department: string;
  designation: string; // e.g. 'Professor', 'Associate Professor', 'Lecturer'
}

export interface ChapterApplication {
  id: string;

  // Applicant
  applicantId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;

  // Chapter details
  universityName: string;
  city: string;
  country: string;
  proposedChapterName: string;

  // Team
  teamMembers: TeamMember[];

  // Faculty advisor
  facultyAdvisor: FacultyAdvisor;

  // Additional context
  motivation: string;
  existingClubs: string;
  estimatedMemberCount: number;
  socialMediaLinks?: string;

  // Status
  status: ChapterApplicationStatus;

  // Payment link
  orderId?: string;

  // Admin review
  reviewedBy?: string;
  reviewedAt?: Timestamp | string;
  adminNotes?: string;
  rejectionReason?: string;
  infoRequestMessage?: string;

  // Auto-created chapter
  createdChapterId?: string;

  // Timestamps
  createdAt: Timestamp | string;
  updatedAt: Timestamp | string;
}

/** Minimal input for creating a new application (before payment). */
export interface CreateChapterApplicationInput {
  applicantId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  universityName: string;
  city: string;
  country: string;
  proposedChapterName: string;
  teamMembers: TeamMember[];
  facultyAdvisor: FacultyAdvisor;
  motivation: string;
  existingClubs: string;
  estimatedMemberCount: number;
  socialMediaLinks?: string;
}
