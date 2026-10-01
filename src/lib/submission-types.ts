/**
 * Submission system data types for SEDS Pakistan
 * Allows members to submit competition/opportunity links for admin review
 */

export type SubmissionType = 'competition' | 'opportunity' | 'resource' | 'other';
export type SubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface Submission {
    id: string;

    // Submitter info
    userId: string;
    userDisplayName: string;
    userEmail?: string;

    // Submission details
    type: SubmissionType;
    title: string;
    url: string;
    description?: string;

    // Optional metadata
    deadline?: Date | null;      // Competition deadline if applicable
    organization?: string;       // Organizing body
    tags?: string[];             // Categorization tags

    // Review workflow
    status: SubmissionStatus;
    submittedAt: Date;

    // Review info (set when reviewed)
    reviewedAt?: Date;
    reviewedBy?: string;         // Admin UID
    reviewerDisplayName?: string;
    reviewNotes?: string;        // Reason for approval/rejection

    // Points (set on approval)
    pointsAwarded?: number;

    // If approved, may be linked to competitions collection
    linkedCompetitionId?: string;
}

export interface SubmissionFormData {
    type: SubmissionType;
    title: string;
    url: string;
    description?: string;
    deadline?: string;
    organization?: string;
    tags?: string[];
}

export interface SubmissionReviewData {
    action: 'approve' | 'reject';
    reviewNotes?: string;
    pointsToAward?: number;      // Only for approval
    addToCompetitions?: boolean; // Create a competition entry
}

// Default points for approved submissions
export const DEFAULT_SUBMISSION_POINTS: Record<SubmissionType, number> = {
    competition: 15,
    opportunity: 10,
    resource: 5,
    other: 5
};
