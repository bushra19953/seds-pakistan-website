import { FirebaseError } from 'firebase/app';
import {
  FirestorePermissionError,
  FirestoreNetworkError,
  FirestoreValidationError,
  FirestoreNotFoundError,
  FirestoreTimeoutError,
  FirestoreQuotaExceededError,
  FirestoreUnknownError,
  FirestoreErrorContext as FirestoreErrorContextType,
  SecurityRuleContext
} from './errors';

export type { FirestoreErrorContext } from './errors';

export type FirestoreErrorHandlerOptions = {
  context: FirestoreErrorContextType;
  onError?: (error: Error) => void;
  showUserFriendlyMessages?: boolean;
};

export function handleFirestoreError(
  error: unknown,
  options: FirestoreErrorHandlerOptions
): Error {
  const { context, onError, showUserFriendlyMessages = true } = options;
  
  let handledError: Error;

  // Handle Firebase-specific errors
  if (error instanceof FirebaseError) {
    handledError = handleFirebaseError(error, context);
  }
  // Handle network errors
  else if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
    handledError = new FirestoreNetworkError(context);
  }
  // Handle timeout errors
  else if (error instanceof Error && error.name === 'TimeoutError') {
    handledError = new FirestoreTimeoutError(context);
  }
  // Handle other errors
  else if (error instanceof Error) {
    handledError = new FirestoreUnknownError(context, error);
  }
  // Handle unknown error types
  else {
    const unknownError = new Error('An unknown error occurred');
    handledError = new FirestoreUnknownError(context, unknownError);
  }

  // Log error for debugging
  console.error('Firestore Error:', {
    error: handledError,
    context,
    originalError: error,
    timestamp: new Date().toISOString()
  });

  // Call custom error handler if provided
  if (onError) {
    onError(handledError);
  }

  return handledError;
}

function handleFirebaseError(firebaseError: FirebaseError, context: FirestoreErrorContextType): Error {
  const errorCode = firebaseError.code;
  
  // Permission denied errors
  if (errorCode === 'permission-denied' || errorCode === 'unauthenticated') {
    const securityContext: SecurityRuleContext = {
      path: context.collection ? `${context.collection}/${context.documentId || ''}` : 'unknown',
      operation: context.operation as any,
      requestResourceData: context.additionalContext
    };
    return new FirestorePermissionError(securityContext);
  }
  
  // Network errors
  if (errorCode === 'unavailable' || errorCode === 'deadline-exceeded') {
    return new FirestoreNetworkError(context);
  }
  
  // Not found errors
  if (errorCode === 'not-found') {
    return new FirestoreNotFoundError(context);
  }
  
  // Timeout errors
  if (errorCode === 'deadline-exceeded') {
    return new FirestoreTimeoutError(context);
  }
  
  // Quota exceeded errors
  if (errorCode === 'resource-exhausted' || errorCode === 'quota-exceeded') {
    return new FirestoreQuotaExceededError(context);
  }
  
  // Validation errors
  if (errorCode === 'invalid-argument' || errorCode === 'failed-precondition') {
    const msg = firebaseError.message || '';
    let finalMsg = msg;
    const match = msg.match(/https:\/\/console\.firebase\.google\.com[^\s\)]+/i);
    if (match) {
      const link = match[0];
      finalMsg = `${msg}\nCreate the required index: ${link}`;
      try { console.info('Firestore: index creation link:', link); } catch {}
    }
    return new FirestoreValidationError(context, finalMsg);
  }
  
  // Default to unknown error
  return new FirestoreUnknownError(context, firebaseError);
}

export function getUserFriendlyErrorMessage(error: Error): string {
  const errorName = error.name;
  
  switch (errorName) {
    case 'FirestorePermissionError':
      return 'You don\'t have permission to perform this action. Please contact support if you believe this is an error.';
    
    case 'FirestoreNetworkError':
      return 'Network connection error. Please check your internet connection and try again.';
    
    case 'FirestoreNotFoundError':
      return 'The requested item was not found. It may have been deleted or moved.';
    
    case 'FirestoreTimeoutError':
      return 'The request timed out. Please try again later.';
    
    case 'FirestoreQuotaExceededError':
      return 'Service is temporarily unavailable due to high demand. Please try again later.';
    
    case 'FirestoreValidationError':
      return 'Invalid data provided. Please check your input and try again.';
    
    default:
      return 'An unexpected error occurred. Please try again later or contact support if the problem persists.';
  }
}

export function logFirestoreError(error: Error, context: FirestoreErrorContextType): void {
  const errorInfo = {
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack
    },
    context,
    timestamp: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    url: typeof window !== 'undefined' ? window.location.href : 'unknown'
  };

  // Log to console in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Firestore Error Details:', errorInfo);
  }

  // In production, you might want to send this to a logging service
  // Example: sendToLoggingService(errorInfo);
}