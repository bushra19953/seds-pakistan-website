/**
 * Enhanced RBAC data structures for SEDS Pakistan website with new organizational hierarchy
 */

export type EnhancedUserRole = 
  'president_national' | 
  'president_chapter' | 
  'vice_president' | 
  'general_secretary' | 
  'projects_director' | 
  'marketing_head' | 
  'hr_director' | 
  'treasurer' | 
  'advisor' | 
  'chair_projects' | 
  'chair_marketing' | 
  'chair_outreach' | 
  'chair_design' | 
  'chair_alumni' | 
  'chair_events' | 
  'chair_recruitment' | 
  'chair_ethics' | 
  'chair_sponsorship' | 
  'rocketry_team' | 
  'cubesat_team' | 
  'rover_team' | 
  'member' | 
  'guest';

export interface EnhancedRoleAssignment {
  uid: string;
  role: EnhancedUserRole;
  grantedBy: string;
  grantedAt: Date;
}

export interface Invite {
  id: string;
  email?: string;
  role: EnhancedUserRole;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  usedBy?: string;
  usedAt?: Date;
}

export interface AuditLog {
  id: string;
  action: string;
  actorUid: string;
  targetUidOrResource: string;
  payload: any;
  timestamp: Date;
  meta?: {
    clientIp?: string;
    userAgent?: string;
  };
}

export interface RoleRequest {
  id: string;
  requesterUid: string;
  requestedRole: EnhancedUserRole;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
  handledBy?: string;
  handledAt?: Date;
  notes?: string;
}

export interface Project {
  id: string;
  title: string;
  body: string;
  ownerUid: string;
  status: 'draft' | 'review' | 'published' | 'archived';
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
  editors: string[];
}

export interface BlogPost {
  id: string;
  title: string;
  body: string;
  ownerUid: string;
  status: 'draft' | 'review' | 'published' | 'archived';
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
  editors: string[];
}

export interface Event {
  id: string;
  title: string;
  body: string;
  ownerUid: string;
  status: 'draft' | 'review' | 'published' | 'archived';
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
  editors: string[];
  date: Date;
  location: string;
}
