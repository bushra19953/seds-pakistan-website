export type SecurityRuleContext = {
  path: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  requestResourceData?: any;
};

export type FirestoreErrorContext = {
  operation: string;
  collection?: string;
  documentId?: string;
  userId?: string;
  additionalContext?: any;
};

export class FirestorePermissionError extends Error {
  public context: SecurityRuleContext;
  constructor(context: SecurityRuleContext) {
    const { path, operation } = context;
    const message = `FirestoreError: Missing or insufficient permissions: The following request was denied by Firestore Security Rules:
{
  "operation": "${operation}",
  "path": "${path}"
}`;
    super(message);
    this.name = 'FirestorePermissionError';
    this.context = context;
    // This is to ensure the prototype chain is correct
    Object.setPrototypeOf(this, FirestorePermissionError.prototype);
  }
}

export class FirestoreNetworkError extends Error {
  public context: FirestoreErrorContext;
  constructor(context: FirestoreErrorContext) {
    const { operation, collection, documentId } = context;
    const message = `Firestore Network Error: A network error occurred while performing '${operation}' operation${collection ? ` on collection '${collection}'` : ''}${documentId ? ` with document ID '${documentId}'` : ''}. Please check your internet connection and try again.`;
    super(message);
    this.name = 'FirestoreNetworkError';
    this.context = context;
    Object.setPrototypeOf(this, FirestoreNetworkError.prototype);
  }
}

export class FirestoreValidationError extends Error {
  public context: FirestoreErrorContext;
  constructor(context: FirestoreErrorContext, message: string) {
    super(message);
    this.name = 'FirestoreValidationError';
    this.context = context;
    Object.setPrototypeOf(this, FirestoreValidationError.prototype);
  }
}

export class FirestoreNotFoundError extends Error {
  public context: FirestoreErrorContext;
  constructor(context: FirestoreErrorContext) {
    const { operation, collection, documentId } = context;
    const message = `Firestore Not Found: The requested document${collection ? ` in collection '${collection}'` : ''}${documentId ? ` with ID '${documentId}'` : ''} was not found during '${operation}' operation.`;
    super(message);
    this.name = 'FirestoreNotFoundError';
    this.context = context;
    Object.setPrototypeOf(this, FirestoreNotFoundError.prototype);
  }
}

export class FirestoreTimeoutError extends Error {
  public context: FirestoreErrorContext;
  constructor(context: FirestoreErrorContext) {
    const { operation, collection, documentId } = context;
    const message = `Firestore Timeout: The '${operation}' operation${collection ? ` on collection '${collection}'` : ''}${documentId ? ` with document ID '${documentId}'` : ''} timed out. Please try again later.`;
    super(message);
    this.name = 'FirestoreTimeoutError';
    this.context = context;
    Object.setPrototypeOf(this, FirestoreTimeoutError.prototype);
  }
}

export class FirestoreQuotaExceededError extends Error {
  public context: FirestoreErrorContext;
  constructor(context: FirestoreErrorContext) {
    const { operation, collection, documentId } = context;
    const message = `Firestore Quota Exceeded: The '${operation}' operation${collection ? ` on collection '${collection}'` : ''}${documentId ? ` with document ID '${documentId}'` : ''} exceeded the quota limit. Please try again later or contact support.`;
    super(message);
    this.name = 'FirestoreQuotaExceededError';
    this.context = context;
    Object.setPrototypeOf(this, FirestoreQuotaExceededError.prototype);
  }
}

export class FirestoreUnknownError extends Error {
  public context: FirestoreErrorContext;
  public originalError: Error;
  constructor(context: FirestoreErrorContext, originalError: Error) {
    const { operation, collection, documentId } = context;
    const message = `Firestore Unknown Error: An unexpected error occurred during '${operation}' operation${collection ? ` on collection '${collection}'` : ''}${documentId ? ` with document ID '${documentId}'` : ''}. ${originalError.message}`;
    super(message);
    this.name = 'FirestoreUnknownError';
    this.context = context;
    this.originalError = originalError;
    Object.setPrototypeOf(this, FirestoreUnknownError.prototype);
  }
}
