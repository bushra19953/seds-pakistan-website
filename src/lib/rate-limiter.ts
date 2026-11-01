/**
 * Rate limiting utility for AI endpoints
 * Implements token bucket algorithm with Redis-like in-memory storage
 */

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyPrefix?: string;
}

interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetTime: number;
  totalRequests: number;
}

// In-memory storage for rate limiting (in production, use Redis)
const requestCounts = new Map<string, { count: number; resetTime: number }>();
// Heap guard (fix/heap-root-hunt): this map previously grew without bound
// (expired entries lingered until the same key was checked again). Cap
// entries; on overflow, purge expired entries first, then evict
// oldest-inserted. Entries are tiny, but an unbounded map on a long-lived
// process is still a leak.
const MAX_RATE_LIMIT_ENTRIES = 10000;

export class RateLimiter {
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = {
      keyPrefix: 'rate_limit',
      ...config,
    };
  }

  /**
   * Check if request is within rate limits
   */
  async check(identifier: string): Promise<RateLimitResult> {
    const key = `${this.config.keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowMs = this.config.windowMs;

    // Get or create request count for this identifier
    let record = requestCounts.get(key);

    if (!record || now > record.resetTime) {
      // Create new window
      record = {
        count: 0,
        resetTime: now + windowMs,
      };
      if (!requestCounts.has(key) && requestCounts.size >= MAX_RATE_LIMIT_ENTRIES) {
        // Purge expired entries first; they will never be served again.
        for (const [k, v] of requestCounts.entries()) {
          if (now > v.resetTime) requestCounts.delete(k);
        }
        // Still over budget: evict oldest-inserted entries (Map preserves
        // insertion order). Overwriting an existing key never grows the map,
        // so this path only runs for genuinely new identifiers.
        while (requestCounts.size >= MAX_RATE_LIMIT_ENTRIES) {
          const oldest = requestCounts.keys().next().value;
          if (oldest === undefined) break;
          requestCounts.delete(oldest);
        }
      }
      requestCounts.set(key, record);
    }

    // Check if under limit
    if (record.count >= this.config.maxRequests) {
      return {
        success: false,
        remaining: 0,
        resetTime: record.resetTime,
        totalRequests: record.count,
      };
    }

    // Increment counter
    record.count++;

    return {
      success: true,
      remaining: Math.max(0, this.config.maxRequests - record.count),
      resetTime: record.resetTime,
      totalRequests: record.count,
    };
  }

  /**
   * Reset rate limit for identifier (for testing)
   */
  reset(identifier: string): void {
    const key = `${this.config.keyPrefix}:${identifier}`;
    requestCounts.delete(key);
  }

  /**
   * Get current rate limit status without incrementing
   */
  getStatus(identifier: string): RateLimitResult | null {
    const key = `${this.config.keyPrefix}:${identifier}`;
    const record = requestCounts.get(key);
    const now = Date.now();

    if (!record || now > record.resetTime) {
      return null;
    }

    return {
      success: record.count < this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - record.count),
      resetTime: record.resetTime,
      totalRequests: record.count,
    };
  }
}

// Pre-configured rate limiters for different use cases
export const aiRateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10, // 10 requests per minute per user
});

export const authRateLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5, // 5 auth attempts per 15 minutes
});

export const generalRateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100, // 100 requests per minute
});

// Per-IP limiter for the server-side signup endpoint
// (src/app/api/auth/signup/route.ts, audit item 5): account creation
// used to run as a bare client-side Firebase call with no app-side
// brake at all. 10 creations per 15 minutes per IP is far above any
// single person's legitimate need and far below scripted volume.
// The endpoint ALSO checks authRateLimiter per email address.
// Honest scope note: this storage is per-process memory, so on a
// multi-instance deployment the effective ceiling is per instance;
// it is a real brake on the app's own signup path, not a global
// quota. Direct calls to Firebase Auth bypass it entirely, which is
// why Firebase console-side abuse controls remain an owner action.
export const signupIpRateLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5, // 5 signups per 15 minutes per IP (owner tightened 10 -> 5, 2026-10-28)
  keyPrefix: 'signup_ip',
});