/**
 * Error Toast Hook - Consolidated Implementation
 * 
 * This hook now uses the enhanced toast system internally while maintaining
 * the same interface for backward compatibility.
 */

import { getUserFriendlyErrorMessage } from '@/firebase/error-handler';
import { useCallback } from 'react';
import { useEnhancedToast } from './use-enhanced-toast';

export interface ErrorToastOptions {
  title?: string;
  description?: string;
  duration?: number;
}

export function useErrorToast() {
  const { showErrorToast: showEnhancedErrorToast, showSuccessToast: showEnhancedSuccessToast, showInfoToast: showEnhancedInfoToast, showWarningToast: showEnhancedWarningToast } = useEnhancedToast();

  const showErrorToast = useCallback((error: Error | string, options: ErrorToastOptions = {}) => {
    const {
      title = 'Error',
      description,
      duration = 5000
    } = options;

    const userFriendlyMessage = description || (typeof error === 'string' ? error : getUserFriendlyErrorMessage(error));

    showEnhancedErrorToast(userFriendlyMessage, { title, duration });
  }, [showEnhancedErrorToast]);

  const showSuccessToast = useCallback((message: string, title: string = 'Success') => {
    showEnhancedSuccessToast(message, title);
  }, [showEnhancedSuccessToast]);

  const showInfoToast = useCallback((message: string, title: string = 'Info') => {
    showEnhancedInfoToast(message, title);
  }, [showEnhancedInfoToast]);

  const showWarningToast = useCallback((message: string, title: string = 'Warning') => {
    showEnhancedWarningToast(message, title);
  }, [showEnhancedWarningToast]);

  return {
    showErrorToast,
    showSuccessToast,
    showInfoToast,
    showWarningToast,
  };
}