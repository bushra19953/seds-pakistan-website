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

export interface ArchiveDocument {
    id: string;
    title: string;
    url: string;
    type?: 'pdf' | 'doc' | 'link';
}

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
