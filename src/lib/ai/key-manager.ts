import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * GEMINI API KEY ROTATION SYSTEM
 * 
 * Prevents 429 thottling by pooling multiple keys and cycling them.
 * Mark keys as exhausted on 429 and retry with next available key.
 */

interface ManagedKey {
    key: string;
    isExhausted: boolean;
    exhaustedUntil: number;
}

// Global in-memory pool (persists across requests in the same edge/server instance)
const keyPool: ManagedKey[] = [];
let currentPoolIndex = 0;

/**
 * Initialize pool from environment variables
 */
function initializePool() {
    if (keyPool.length > 0) return;

    // Support GEMINI_API_KEY, GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.
    const keysFound = new Set<string>();

    if (process.env.GEMINI_API_KEY) keysFound.add(process.env.GEMINI_API_KEY.trim());

    // Look for GEMINI_API_KEY_1 to GEMINI_API_KEY_10
    for (let i = 1; i <= 10; i++) {
        const envKey = `GEMINI_API_KEY_${i}`;
        const val = process.env[envKey];
        if (val) keysFound.add(val.trim());
    }

    // Convert to managed objects
    keysFound.forEach(k => {
        if (k && k !== 'dummy' && k !== 'TEST_KEY_IF_NEEDED') {
            keyPool.push({
                key: k,
                isExhausted: false,
                exhaustedUntil: 0
            });
        }
    });

    console.log(`[AI Key Manager] Initialized with ${keyPool.length} keys.`);
}

/**
 * Get the next healthy key from the pool
 */
function getNextAvailableKey(): ManagedKey | null {
    initializePool();
    if (keyPool.length === 0) return null;

    const now = Date.now();
    
    // Check all keys once
    for (let i = 0; i < keyPool.length; i++) {
        const idx = (currentPoolIndex + i) % keyPool.length;
        const entry = keyPool[idx];

        if (entry.isExhausted && entry.exhaustedUntil < now) {
            entry.isExhausted = false;
        }

        if (!entry.isExhausted) {
            currentPoolIndex = (idx + 1) % keyPool.length;
            return entry;
        }
    }

    return null;
}

/**
 * Execute a Gemini operation with automatic failover and key rotation
 */
export async function executeWithFailover<T>(
    operation: (genAI: GoogleGenerativeAI) => Promise<T>,
    userProvidedKey?: string
): Promise<T> {
    // 1. If user provided a specific key (from settings), use it exclusively
    if (userProvidedKey && userProvidedKey.length > 10) {
        const genAI = new GoogleGenerativeAI(userProvidedKey);
        return await operation(genAI);
    }

    // 2. Otherwise use the pool
    let attempts = 0;
    const maxAttempts = Math.max(3, keyPool.length);

    while (attempts < maxAttempts) {
        const entry = getNextAvailableKey();
        if (!entry) {
            throw new Error("All Gemini API keys are currently throttled (429). Please wait a few minutes.");
        }

        try {
            const genAI = new GoogleGenerativeAI(entry.key);
            return await operation(genAI);
        } catch (error: any) {
            const errorText = error?.message || "";
            const is429 = errorText.includes("429") || errorText.toLowerCase().includes("quota");

            if (is429) {
                console.warn(`[AI Key Manager] Key exhausted (429). Cooling down for 60s.`);
                entry.isExhausted = true;
                entry.exhaustedUntil = Date.now() + 60000; // 1 minute cooldown
                attempts++;
                continue;
            }

            // If it's not a 429, rethrow immediately
            throw error;
        }
    }

    throw new Error("Failed to execute AI operation after multiple key rotation attempts.");
}
