/**
 * Enhanced Toast Notification System with Contextual User Feedback
 * Provides comprehensive feedback for user actions, system events, and authentication flows
 */

import { useToast } from '@/hooks/use-toast-original';
import { ToastActionElement } from '@/components/ui/toast';
import { ToastAction } from '@/components/ui/toast';
import { useCallback } from 'react';

export interface ToastOptions {
  title?: string;
  description?: string | React.ReactNode;
  action?: ToastActionElement;
  duration?: number;
  variant?: 'default' | 'destructive';
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center';
  icon?: React.ReactNode;
  closable?: boolean;
  onClose?: () => void;
  onActionClick?: () => void;
}

export interface ActionToastOptions extends Omit<ToastOptions, 'action'> {
  actionLabel: string;
  actionCallback: () => void;
  cancelLabel?: string;
  cancelCallback?: () => void;
}

export function useEnhancedToast() {
  const { toast } = useToast();

  // Generic toast function with all options
  const showToast = useCallback((options: ToastOptions) => {
    toast({
      title: options.title,
      description: options.description,
      action: options.action,
      duration: options.duration || 5000,
      variant: options.variant || 'default',
    });
  }, [toast]);

  // Success toast with consistent styling
  const showSuccessToast = (title: string, description?: string) => {
    return showToast({
      title,
      description,
      variant: 'default',
      icon: '✅',
      duration: 5000,
    });
  };

  // Error toast with consistent styling
  const showErrorToast = useCallback((
    error: Error | string,
    options?: Partial<ToastOptions>
  ) => {
    const description = typeof error === 'string' ? error : error.message;
    const title = options?.title || 'Error';
    
    showToast({
      title,
      description,
      variant: 'destructive',
      icon: '❌',
      duration: 6000,
      ...options,
    });
  }, [showToast]);

  // Warning toast with consistent styling
  const showWarningToast = (title: string, description?: string) => {
    return showToast({
      title,
      description,
      variant: 'default',
      icon: '⚠️',
      duration: 5000,
    });
  };

  // Info toast with consistent styling
  const showInfoToast = (title: string, description?: string) => {
    return showToast({
      title,
      description,
      variant: 'default',
      icon: 'ℹ️',
      duration: 4000,
    });
  };

  // Loading toast that can be dismissed programmatically
  const showLoadingToast = useCallback((
    description: string,
    title: string = 'Processing',
    options?: Partial<ToastOptions>
  ) => {
    const toastId = Math.random().toString(36).substr(2, 9);
    
    showToast({
      title,
      description,
      variant: 'default',
      icon: '⏳',
      duration: 0, // Don't auto-dismiss
      closable: false,
      ...options,
    });

    return toastId; // Return ID for later dismissal
  }, [showToast]);

  // Action toast with confirmation buttons
  const showActionToast = useCallback((
    description: string,
    options: ActionToastOptions
  ) => {
    const actionElement = (
      <div className="flex gap-2 mt-2">
        <ToastAction
          altText={options.actionLabel}
          onClick={options.actionCallback}
        >
          {options.actionLabel}
        </ToastAction>
        {options.cancelLabel && options.cancelCallback && (
          <ToastAction
            altText={options.cancelLabel}
            onClick={options.cancelCallback}
          >
            {options.cancelLabel}
          </ToastAction>
        )}
      </div>
    );

    showToast({
      title: options.title,
      description,
      action: actionElement,
      variant: options.variant || 'default',
      duration: options.duration || 10000,
      ...options,
    });
  }, [showToast]);

  // Progress toast for long-running operations
  const showProgressToast = useCallback((
    description: string,
    progress: number,
    title: string = 'Progress',
    options?: Partial<ToastOptions>
  ) => {
    const progressBar = (
      <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
        <div 
          className="bg-blue-600 h-2 rounded-full transition-all duration-300"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    );

    showToast({
      title,
      description: (
        <div>
          <p className="mb-2">{description}</p>
          {progressBar}
          <p className="text-xs text-gray-500 mt-1">{progress}% complete</p>
        </div>
      ),
      variant: 'default',
      icon: '⏳',
      duration: 0, // Don't auto-dismiss
      closable: false,
      ...options,
    });
  }, [showToast]);

  // Batch operation toast for multiple items
  const showBatchToast = useCallback((
    items: Array<{ id: string; name: string; status: 'pending' | 'processing' | 'completed' | 'failed' }>,
    title: string = 'Batch Operation',
    options?: Partial<ToastOptions>
  ) => {
    const completed = items.filter(item => item.status === 'completed').length;
    const failed = items.filter(item => item.status === 'failed').length;
    const total = items.length;

    const statusList = (
      <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
        {items.slice(0, 5).map(item => (
          <div key={item.id} className="flex items-center text-xs">
            <span className="mr-2">
              {item.status === 'completed' ? '✅' : 
               item.status === 'failed' ? '❌' : 
               item.status === 'processing' ? '⏳' : '⏸️'}
            </span>
            <span className="truncate">{item.name}</span>
          </div>
        ))}
        {items.length > 5 && (
          <div className="text-xs text-gray-500">...and {items.length - 5} more</div>
        )}
      </div>
    );

    showToast({
      title,
      description: (
        <div>
          <p>Progress: {completed} completed, {failed} failed out of {total}</p>
          {statusList}
        </div>
      ),
      variant: failed > 0 ? 'destructive' : 'default',
      icon: failed > 0 ? '⚠️' : '✅',
      duration: 5000,
      ...options,
    });
  }, [showToast]);

  // Network status toast for connectivity issues
  const showNetworkToast = useCallback((
    isOnline: boolean,
    options?: Partial<ToastOptions>
  ) => {
    if (isOnline) {
      showToast({
        title: 'Connection Restored',
        description: 'You are back online',
        variant: 'default',
        icon: '✅',
        duration: 3000,
        ...options,
      });
    } else {
      showToast({
        title: 'No Internet Connection',
        description: 'You are offline. Some features may be limited.',
        variant: 'default',
        icon: '⚠️',
        duration: 0,
        closable: false,
        ...options,
      });
    }
  }, [showToast]);

  // Authentication-specific toasts
  const showAuthToast = useCallback((
    type: 'login-success' | 'login-failed' | 'logout-success' | 'logout-failed' | 'session-expired' | 'permission-denied',
    options?: Partial<ToastOptions>
  ) => {
    const messages = {
      'login-success': { title: 'Welcome Back!', description: 'Successfully signed in', variant: 'default' as const },
      'login-failed': { title: 'Login Failed', description: 'Unable to sign in. Please try again.', variant: 'destructive' as const },
      'logout-success': { title: 'Signed Out', description: 'Successfully signed out', variant: 'default' as const },
      'logout-failed': { title: 'Logout Error', description: 'Unable to sign out. Please try again.', variant: 'destructive' as const },
      'session-expired': { title: 'Session Expired', description: 'Please sign in again to continue.', variant: 'default' as const },
      'permission-denied': { title: 'Access Denied', description: 'You don\'t have permission to access this resource.', variant: 'destructive' as const },
    };

    const message = messages[type];
    showToast({
      ...message,
      ...options,
      icon: type.includes('success') ? '✅' : type.includes('failed') ? '❌' : '⚠️',
    });
  }, [showToast]);

  // System status toasts
  const showSystemToast = useCallback((
    type: 'maintenance' | 'update-available' | 'performance-warning' | 'storage-full',
    options?: Partial<ToastOptions>
  ) => {
    const messages = {
      'maintenance': { 
        title: 'System Maintenance', 
        description: 'System will be under maintenance shortly. Save your work.',
        variant: 'default' as const
      },
      'update-available': { 
        title: 'Update Available', 
        description: 'A new version is available. Refresh to update.',
        variant: 'default' as const
      },
      'performance-warning': { 
        title: 'Performance Warning', 
        description: 'System is running slowly. Some features may be delayed.',
        variant: 'default' as const
      },
      'storage-full': { 
        title: 'Storage Full', 
        description: 'Storage is almost full. Please free up some space.',
        variant: 'destructive' as const
      },
    };

    const message = messages[type];
    showToast({
      ...message,
      ...options,
      icon: type === 'maintenance' ? '🔧' : 
            type === 'update-available' ? '📦' :
            type === 'performance-warning' ? '⚡' : '💾',
    });
  }, [showToast]);

  return {
    showToast,
    showSuccessToast,
    showErrorToast,
    showWarningToast,
    showInfoToast,
    showLoadingToast,
    showActionToast,
    showProgressToast,
    showBatchToast,
    showNetworkToast,
    showAuthToast,
    showSystemToast,
  };
}

export default useEnhancedToast;