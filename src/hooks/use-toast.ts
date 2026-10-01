"use client"

// Fix invalid hook call by delegating to the original non-hook toast implementation.
// Direct usage of `toast` must not call React hooks.

export { useToast, toast } from './use-toast-original';
export { useEnhancedToast } from './use-enhanced-toast';
