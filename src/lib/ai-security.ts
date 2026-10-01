/**
 * Security middleware for AI endpoints
 * Provides rate limiting, input validation, and abuse protection
 */

import { NextRequest } from 'next/server';
import { aiRateLimiter } from './rate-limiter';
import { errorEmitter } from '@/firebase/error-emitter';

export interface AISecurityContext {
  userId?: string;
  ipAddress: string;
  userAgent: string;
  timestamp: number;
}

export interface AISecurityResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: number;
}

/**
 * Extract security context from request
 */
export function extractSecurityContext(request: NextRequest, userId?: string): AISecurityContext {
  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';

  return {
    userId,
    ipAddress,
    userAgent,
    timestamp: Date.now(),
  };
}

/**
 * Validate AI request input
 */
export function validateAIInput(input: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!input) {
    errors.push('Input is required');
    return { valid: false, errors };
  }

  // Validate query string
  if (typeof input.query === 'string') {
    if (input.query.length < 3) {
      errors.push('Query must be at least 3 characters long');
    }
    if (input.query.length > 5000) {
      errors.push('Query must be less than 5000 characters');
    }
  } else {
    errors.push('Query must be a string');
  }

  // Check for potential injection patterns
  const suspiciousPatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /javascript:/gi,
    /vbscript:/gi,
    /onload\s*=/gi,
    /onerror\s*=/gi,
    /eval\s*\(/gi,
    /function\s*\(/gi,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(input.query || '')) {
      errors.push('Query contains potentially malicious content');
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check rate limits for AI requests
 */
export async function checkAIRateLimit(context: AISecurityContext): Promise<AISecurityResult> {
  const identifier = context.userId || context.ipAddress;

  try {
    const rateLimitResult = await aiRateLimiter.check(identifier);

    if (!rateLimitResult.success) {
      // Log rate limit violation
      console.warn('AI rate limit exceeded:', {
        type: 'ai_request',
        identifier,
        context,
        resetTime: rateLimitResult.resetTime,
      });

      return {
        allowed: false,
        reason: 'Rate limit exceeded',
        retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000),
      };
    }

    return {
      allowed: true,
      retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000),
    };
  } catch (error) {
    console.error('Rate limit check failed:', error);

    // Fail open in case of rate limiter issues
    return {
      allowed: true,
    };
  }
}

/**
 * Log AI request for monitoring
 */
export function logAIRequest(
  context: AISecurityContext,
  input: any,
  success: boolean,
  error?: string
): void {
  const logEntry = {
    timestamp: context.timestamp,
    userId: context.userId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    inputLength: JSON.stringify(input).length,
    success,
    error,
  };

  // In production, send to monitoring service
  if (process.env.NODE_ENV === 'production') {
    console.info('AI_REQUEST_LOG:', JSON.stringify(logEntry));
  } else {
    console.debug('AI Request:', logEntry);
  }
}

/**
 * Main security middleware for AI endpoints
 */
export async function validateAIRequest(
  request: NextRequest,
  input: any,
  userId?: string
): Promise<AISecurityResult> {
  const context = extractSecurityContext(request, userId);

  // Validate input
  const inputValidation = validateAIInput(input);
  if (!inputValidation.valid) {
    logAIRequest(context, input, false, `Input validation failed: ${inputValidation.errors.join(', ')}`);
    return {
      allowed: false,
      reason: `Invalid input: ${inputValidation.errors.join(', ')}`,
    };
  }

  // Check rate limits
  const rateLimitResult = await checkAIRateLimit(context);
  if (!rateLimitResult.allowed) {
    logAIRequest(context, input, false, rateLimitResult.reason);
    return rateLimitResult;
  }

  // Log successful validation
  logAIRequest(context, input, true);

  return {
    allowed: true,
  };
}

// Helper function to create NextRequest-like object for server actions
export function createMockRequest(headersList: Headers): NextRequest {
  return {
    headers: headersList,
    nextUrl: new URL('http://localhost'),
    cookies: {
      get: () => undefined,
      getAll: () => [],
      has: () => false,
    },
  } as any;
}