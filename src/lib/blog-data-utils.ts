/**
 * Bulletproof utility for parsing rich JSON data payloads fetched from the CMS.
 * Prevents UI crashes when stringified JSON is malformed.
 */

// --- Type Definitions for the Rich Payload ---

export interface LaunchMetric {
    id: string;
    name: string;
    isReady: boolean;
    notes?: string;
    progressPercentage?: number;
}

export interface LaunchReadinessPayload {
    verificationMetrics: LaunchMetric[];
}

export interface TechSpec {
    id: string;
    label: string;
    value: string;
}

export interface DataShowcasePayload {
    technicalSpecs: TechSpec[];
    engineeringSeal?: string;
}

import type { ArchiveDocument } from './blog-types';
export type { ArchiveDocument };

export interface AnalogArchivePayload {
    documents: ArchiveDocument[];
    allowDownloads: boolean;
}

export interface HorizonEvent {
    id: string;
    year: number | string;
    title: string;
    description: string;
}

export interface FutureHorizonsPayload {
    horizons: HorizonEvent[];
}

import { doc, type DocumentData, type DocumentReference, type Firestore } from 'firebase/firestore';

/**
 * Serialize any blog date shape to an ISO string (or null).
 *
 * Timestamp hotspot for the Supabase swap: Firestore docs carry Timestamp
 * objects (toDate()/seconds), while fs_blogs rows carry ISO strings (the
 * migration kit + adapter normalize on write) or, for legacy dumps, plain
 * {_seconds,_nanoseconds} objects / adapter SupaTimestamps. Every shape
 * the old inline serializers accepted is accepted here, plus those.
 */
export function serializeBlogDate(v: any): string | null {
    if (!v) return null;
    if (typeof v.toDate === 'function') {
        try { return v.toDate().toISOString(); } catch { return null; }
    }
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    if (typeof v === 'string') return v;
    if (typeof v === 'number') {
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    const seconds = v._seconds ?? v.seconds;
    if (typeof seconds === 'number') {
        const nanos = v._nanoseconds ?? v.nanoseconds ?? 0;
        return new Date(seconds * 1000 + nanos / 1_000_000).toISOString();
    }
    return null;
}

/**
 * The blogDocRef seam (admin blog edit page): the single place a blogs
 * DocumentReference is constructed for the edit form, so the reference
 * shape has one owner. Returns null when id or firestore is missing,
 * matching the edit page's previous inline useMemo behavior.
 */
export function createBlogDocRef(
    firestore: Firestore | null | undefined,
    blogId: string | null | undefined,
): DocumentReference<DocumentData> | null {
    if (!blogId || !firestore) return null;
    return doc(firestore, 'blogs', blogId);
}

// --- The Safe Parser ---

/**
 * Safely parses a JSON string or returns the typed fallback object.
 *
 * @param dataString The raw JSON string from the database (or undefined).
 * @param fallback The default value to return if parsing fails or data is missing.
 * @returns The parsed object of type T or the fallback.
 */
export function safeParseRichData<T>(dataString: string | any | undefined, fallback: T): T {
    if (!dataString) return fallback;

    // If it's already an object (e.g., returned as an object from the API), just return it
    if (typeof dataString === 'object') {
        return dataString as T;
    }

    try {
        return JSON.parse(dataString) as T;
    } catch (error) {
        console.error('[Blog Data Parser] Failed to parse rich JSON payload:', error);
        // Return the safe fallback to prevent the UI from crashing
        return fallback;
    }
}
