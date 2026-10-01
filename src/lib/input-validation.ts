/**
 * Input validation and sanitization utilities
 * Provides comprehensive validation for all user inputs
 */

import { z } from 'zod';

// Note: DOMPurify is client-side only, so we'll implement basic sanitization for server-side
// In a production app, you'd use a server-safe HTML sanitizer like 'sanitize-html'

// Basic sanitization schemas
export const sanitizationSchemas = {
  // Text inputs
  text: z.string()
    .transform(val => val.trim())
    .refine(val => val.length > 0, 'Text cannot be empty')
    .refine(val => val.length <= 1000, 'Text must be less than 1000 characters'),

  // Long text (descriptions, content)
  longText: z.string()
    .transform(val => val.trim())
    .refine(val => val.length > 0, 'Text cannot be empty')
    .refine(val => val.length <= 10000, 'Text must be less than 10000 characters'),

  // Email validation
  email: z.string()
    .email('Invalid email format')
    .transform(val => val.toLowerCase().trim()),

  // URL validation
  url: z.string()
    .url('Invalid URL format')
    .refine(val => {
      try {
        const url = new URL(val);
        return ['http:', 'https:'].includes(url.protocol);
      } catch {
        return false;
      }
    }, 'URL must use HTTP or HTTPS protocol'),

  // Safe HTML (for rich text content) - server-side basic sanitization
  safeHtml: z.string()
    .transform(val => {
      // Basic HTML sanitization - remove script tags and dangerous attributes
      return val
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .replace(/style\s*=\s*[^>]*>/gi, '>');
    })
    .refine(val => val.length <= 50000, 'HTML content must be less than 50000 characters'),

  // Tags/keywords
  tags: z.string()
    .transform(val => val.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0))
    .refine(val => val.length > 0, 'At least one tag is required')
    .refine(val => val.length <= 10, 'Maximum 10 tags allowed')
    .refine(val => val.every(tag => tag.length <= 50), 'Each tag must be less than 50 characters'),

  // Project title
  projectTitle: z.string()
    .min(3, 'Title must be at least 3 characters')
    .max(100, 'Title must be less than 100 characters')
    .regex(/^[a-zA-Z0-9\s\-_.,!?()]+$/, 'Title contains invalid characters'),

  // Numeric inputs
  positiveInteger: z.number()
    .int('Must be a whole number')
    .positive('Must be greater than 0'),

  // File size validation (in bytes)
  fileSize: z.number()
    .max(10 * 1024 * 1024, 'File size must be less than 10MB'),

  // Phone number (optional)
  phone: z.string()
    .optional()
    .refine(val => {
      if (!val) return true;
      return /^[\+]?[1-9][\d]{0,15}$/.test(val.replace(/[\s\-\(\)]/g, ''));
    }, 'Invalid phone number format'),
};

/**
 * Sanitize string input
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }

  return input
    .trim()
    .replace(/[<>\"'&]/g, (char) => {
      const entityMap: { [key: string]: string } = {
        '<': '<',
        '>': '>',
        '"': '"',
        "'": '&#x27;',
        '&': '&',
      };
      return entityMap[char] || char;
    });
}

/**
 * Validate and sanitize project data
 */
export function validateProjectInput(data: {
  title: string;
  description: string;
  imageUrl?: string;
  tags: string;
}): { success: boolean; data?: any; errors?: string[] } {
  try {
    const sanitizedData = {
      title: sanitizationSchemas.projectTitle.parse(data.title),
      description: sanitizationSchemas.longText.parse(data.description),
      imageUrl: data.imageUrl ? sanitizationSchemas.url.parse(data.imageUrl) : undefined,
      tags: sanitizationSchemas.tags.parse(data.tags),
    };

    return {
      success: true,
      data: sanitizedData,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.errors.map(err => err.message),
      };
    }

    return {
      success: false,
      errors: ['Validation failed'],
    };
  }
}

/**
 * Validate and sanitize user profile data
 */
export function validateProfileInput(data: {
  name: string;
  email: string;
  university?: string;
  fieldOfStudy?: string;
  bio?: string;
}): { success: boolean; data?: any; errors?: string[] } {
  try {
    const sanitizedData = {
      name: sanitizationSchemas.text.parse(data.name),
      email: sanitizationSchemas.email.parse(data.email),
      university: data.university ? sanitizationSchemas.text.parse(data.university) : undefined,
      fieldOfStudy: data.fieldOfStudy ? sanitizationSchemas.text.parse(data.fieldOfStudy) : undefined,
      bio: data.bio ? sanitizationSchemas.longText.parse(data.bio) : undefined,
    };

    return {
      success: true,
      data: sanitizedData,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.errors.map(err => err.message),
      };
    }

    return {
      success: false,
      errors: ['Validation failed'],
    };
  }
}

/**
 * Validate file upload
 */
export function validateFileUpload(file: File): { success: boolean; errors?: string[] } {
  const errors: string[] = [];

  // Check file size (10MB limit)
  if (file.size > 10 * 1024 * 1024) {
    errors.push('File size must be less than 10MB');
  }

  // Check file type
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
  ];

  if (!allowedTypes.includes(file.type)) {
    errors.push('File type not allowed');
  }

  // Check file name
  if (file.name.length > 255) {
    errors.push('File name must be less than 255 characters');
  }

  return {
    success: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Comprehensive input sanitization for AI queries
 */
export function sanitizeAIQuery(query: string): { sanitized: string; warnings: string[] } {
  const warnings: string[] = [];

  // Basic sanitization
  let sanitized = sanitizeString(query);

  // Check for potentially problematic content
  if (sanitized.length > 5000) {
    warnings.push('Query is very long and may take longer to process');
  }

  if (sanitized.includes('password') || sanitized.includes('token') || sanitized.includes('key')) {
    warnings.push('Query contains sensitive keywords');
  }

  // Remove excessive whitespace
  sanitized = sanitized.replace(/\s+/g, ' ');

  return { sanitized, warnings };
}

/**
 * Rate limiting validation for forms
 */
export function validateFormSubmission(
  formData: FormData,
  maxFields: number = 50,
  maxFieldSize: number = 10000
): { success: boolean; errors?: string[] } {
  const errors: string[] = [];

  // Check number of fields
  const entries = Array.from(formData.entries());
  if (entries.length > maxFields) {
    errors.push(`Too many form fields (maximum ${maxFields})`);
  }

  // Check field sizes
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string' && value.length > maxFieldSize) {
      errors.push(`Field '${key}' is too large (maximum ${maxFieldSize} characters)`);
    }
  }

  return {
    success: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}