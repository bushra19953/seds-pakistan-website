import { FirestoreErrorContext } from './errors';

export interface ErrorLogEntry {
  id: string;
  timestamp: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  errorName: string;
  errorStack?: string;
  context: FirestoreErrorContext;
  userAgent: string;
  url: string;
  userId?: string;
  sessionId?: string;
  additionalData?: any;
}

class ErrorLoggingService {
  private static instance: ErrorLoggingService;
  private errorQueue: ErrorLogEntry[] = [];
  private isProcessing = false;
  private readonly BATCH_SIZE = 10;
  private readonly PROCESS_INTERVAL = 5000; // 5 seconds

  private constructor() {
    this.startPeriodicProcessing();
  }

  static getInstance(): ErrorLoggingService {
    if (!ErrorLoggingService.instance) {
      ErrorLoggingService.instance = new ErrorLoggingService();
    }
    return ErrorLoggingService.instance;
  }

  logError(
    error: Error,
    context: FirestoreErrorContext,
    level: ErrorLogEntry['level'] = 'error',
    additionalData?: any
  ): void {
    const errorEntry: ErrorLogEntry = {
      id: this.generateErrorId(),
      timestamp: new Date().toISOString(),
      level,
      message: error.message,
      errorName: error.name,
      errorStack: error.stack,
      context,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      url: typeof window !== 'undefined' ? window.location.href : 'unknown',
      userId: context.userId,
      sessionId: this.getSessionId(),
      additionalData
    };

    this.errorQueue.push(errorEntry);

    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.error('Error Logged:', errorEntry);
    }

    // Process immediately if queue is getting large
    if (this.errorQueue.length >= this.BATCH_SIZE) {
      this.processErrorQueue();
    }
  }

  logWarning(
    message: string,
    context: FirestoreErrorContext,
    additionalData?: any
  ): void {
    const warningError = new Error(message);
    warningError.name = 'Warning';
    this.logError(warningError, context, 'warning', additionalData);
  }

  logInfo(
    message: string,
    context: FirestoreErrorContext,
    additionalData?: any
  ): void {
    const infoError = new Error(message);
    infoError.name = 'Info';
    this.logError(infoError, context, 'info', additionalData);
  }

  private async processErrorQueue(): Promise<void> {
    if (this.isProcessing || this.errorQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const errorsToProcess = this.errorQueue.splice(0, this.BATCH_SIZE);

    try {
      // In a real implementation, you would send these to your logging service
      // For now, we'll just log them to console in development
      if (process.env.NODE_ENV === 'development') {
        // Error batch processing logs removed for production
      }

      // Simulate API call delay
      await new Promise(resolve => setTimeout(resolve, 100));

      // Here you would typically send to a logging service like:
      // await sendErrorsToLoggingService(errorsToProcess);
      
    } catch (processingError) {
      console.error('Error processing error queue:', processingError);
      // Put errors back in queue if processing fails
      this.errorQueue.unshift(...errorsToProcess);
    } finally {
      this.isProcessing = false;
    }
  }

  private startPeriodicProcessing(): void {
    setInterval(() => {
      if (this.errorQueue.length > 0) {
        this.processErrorQueue();
      }
    }, this.PROCESS_INTERVAL);
  }

  private generateErrorId(): string {
    return `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private getSessionId(): string {
    if (typeof sessionStorage === 'undefined') {
      return 'unknown';
    }

    let sessionId = sessionStorage.getItem('error_session_id');
    if (!sessionId) {
      sessionId = this.generateErrorId();
      sessionStorage.setItem('error_session_id', sessionId);
    }
    return sessionId;
  }

  // Utility method to get error statistics
  getErrorStats(): { total: number; byLevel: Record<string, number> } {
    const stats = {
      total: this.errorQueue.length,
      byLevel: {
        error: this.errorQueue.filter(e => e.level === 'error').length,
        warning: this.errorQueue.filter(e => e.level === 'warning').length,
        info: this.errorQueue.filter(e => e.level === 'info').length
      }
    };
    return stats;
  }

  // Clear error queue (useful for testing)
  clearQueue(): void {
    this.errorQueue = [];
  }
}

// Export singleton instance
export const errorLoggingService = ErrorLoggingService.getInstance();

// Export convenience functions
export const logError = (error: Error, context: FirestoreErrorContext, additionalData?: any) => {
  errorLoggingService.logError(error, context, 'error', additionalData);
};

export const logWarning = (message: string, context: FirestoreErrorContext, additionalData?: any) => {
  errorLoggingService.logWarning(message, context, additionalData);
};

export const logInfo = (message: string, context: FirestoreErrorContext, additionalData?: any) => {
  errorLoggingService.logInfo(message, context, additionalData);
};