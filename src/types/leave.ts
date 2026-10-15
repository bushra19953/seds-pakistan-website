import type { Timestamp } from 'firebase/firestore';

// Leave request types for the leave MVP.
// Stored in Firestore collection: leave_requests.
// startDate and endDate are YYYY-MM-DD strings to match the leave form
// and the exemption helper. createdAt, updatedAt, and reviewedAt use
// Firestore server timestamps.

export type LeaveType = 'annual' | 'sick' | 'emergency' | 'exam' | 'personal';

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'completed';

export interface LeaveRequest {
  id: string;
  userId: string;
  reason: string;
  startDate: string;
  endDate: string;
  leaveType: LeaveType;
  coveringOfficerId?: string;
  coveringOfficerName?: string;
  notes?: string;
  status: LeaveStatus;
  reviewedAt?: Timestamp;
  reviewedBy?: string;
  reviewerDisplayName?: string;
  reviewNotes?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}
