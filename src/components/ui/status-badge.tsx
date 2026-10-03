'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import {
    Clock,
    CheckCircle2,
    AlertCircle,
    Circle,
    XCircle,
    Send,
    FileCheck,
    Archive,
    Star,
    Calendar,
    Users,
    AlertTriangle,
    Loader2,
    type LucideIcon,
} from 'lucide-react';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';

// =============================================================================
// STATUS TYPE DEFINITIONS
// =============================================================================

/**
 * Comprehensive status type covering all current and foreseeable statuses.
 * Organized by domain for clarity.
 */
export type StatusType =
    // Task Statuses
    | 'pending'
    | 'in-progress'
    | 'submitted-for-review'
    | 'completed'
    | 'overdue'
    // Application Statuses
    | 'under_review'
    | 'shortlisted'
    | 'interview'
    | 'rejected'
    | 'accepted'
    | 'on_hold'
    // Content Statuses
    | 'draft'
    | 'published'
    | 'archived'
    // General Statuses
    | 'active'
    | 'inactive'
    | 'urgent'
    | 'critical';

// =============================================================================
// STATUS CONFIGURATION
// =============================================================================

interface StatusConfig {
    /** Display label for the status */
    label: string;
    /** Background color class (with dark mode variants) */
    bg: string;
    /** Text color class */
    text: string;
    /** Border color class for outline variant */
    border: string;
    /** Optional Lucide icon component */
    icon?: LucideIcon;
    /** Tooltip description explaining the status */
    description: string;
    /** Whether to apply a pulse animation (for urgent states) */
    pulse?: boolean;
}

/**
 * Centralized status configuration - the SINGLE SOURCE OF TRUTH for all status styling.
 * 
 * Design principles:
 * - WCAG AA compliant contrast ratios
 * - Dark mode variants for all colors
 * - Consistent semantic meaning across domains
 * - Optional icons that reinforce meaning
 */
export const STATUS_CONFIG: Record<StatusType, StatusConfig> = {
    // =========================================================================
    // TASK STATUSES
    // =========================================================================
    pending: {
        label: 'Pending',
        bg: 'bg-orange-500/15 dark:bg-orange-500/20',
        text: 'text-orange-600 dark:text-orange-400',
        border: 'border-orange-500/30 dark:border-orange-500/40',
        icon: Circle,
        description: 'Task is waiting to be started',
    },
    'in-progress': {
        label: 'In Progress',
        bg: 'bg-blue-500/15 dark:bg-blue-500/20',
        text: 'text-blue-600 dark:text-blue-400',
        border: 'border-blue-500/30 dark:border-blue-500/40',
        icon: Loader2,
        description: 'Task is currently being worked on',
    },
    'submitted-for-review': {
        label: 'Under Review',
        bg: 'bg-amber-500/15 dark:bg-amber-500/20',
        text: 'text-amber-600 dark:text-amber-400',
        border: 'border-amber-500/30 dark:border-amber-500/40',
        icon: Send,
        description: 'Submitted and awaiting admin review',
        pulse: true,
    },
    completed: {
        label: 'Completed',
        bg: 'bg-green-500/15 dark:bg-green-500/20',
        text: 'text-green-600 dark:text-green-400',
        border: 'border-green-500/30 dark:border-green-500/40',
        icon: CheckCircle2,
        description: 'Task has been completed and approved',
    },
    overdue: {
        label: 'Overdue',
        bg: 'bg-red-500/15 dark:bg-red-500/20',
        text: 'text-red-600 dark:text-red-400',
        border: 'border-red-500/30 dark:border-red-500/40',
        icon: AlertTriangle,
        description: 'Task has passed its deadline',
        pulse: true,
    },

    // =========================================================================
    // APPLICATION STATUSES
    // =========================================================================
    under_review: {
        label: 'Under Review',
        bg: 'bg-purple-500/15 dark:bg-purple-500/20',
        text: 'text-purple-600 dark:text-purple-400',
        border: 'border-purple-500/30 dark:border-purple-500/40',
        icon: FileCheck,
        description: 'Application is being reviewed by the team',
    },
    shortlisted: {
        label: 'Shortlisted',
        bg: 'bg-cyan-500/15 dark:bg-cyan-500/20',
        text: 'text-cyan-600 dark:text-cyan-400',
        border: 'border-cyan-500/30 dark:border-cyan-500/40',
        icon: Star,
        description: 'Applicant has been shortlisted for further consideration',
    },
    interview: {
        label: 'Interview',
        bg: 'bg-indigo-500/15 dark:bg-indigo-500/20',
        text: 'text-indigo-600 dark:text-indigo-400',
        border: 'border-indigo-500/30 dark:border-indigo-500/40',
        icon: Users,
        description: 'Applicant is scheduled for an interview',
    },
    rejected: {
        label: 'Rejected',
        bg: 'bg-red-500/15 dark:bg-red-500/20',
        text: 'text-red-600 dark:text-red-400',
        border: 'border-red-500/30 dark:border-red-500/40',
        icon: XCircle,
        description: 'Application has been declined',
    },
    accepted: {
        label: 'Accepted',
        bg: 'bg-green-500/15 dark:bg-green-500/20',
        text: 'text-green-600 dark:text-green-400',
        border: 'border-green-500/30 dark:border-green-500/40',
        icon: CheckCircle2,
        description: 'Application has been approved',
    },
    on_hold: {
        label: 'On Hold',
        bg: 'bg-slate-500/15 dark:bg-slate-500/20',
        text: 'text-slate-600 dark:text-muted-foreground',
        border: 'border-slate-500/30 dark:border-slate-500/40',
        icon: Clock,
        description: 'Application is temporarily paused',
    },

    // =========================================================================
    // CONTENT STATUSES
    // =========================================================================
    draft: {
        label: 'Draft',
        bg: 'bg-slate-500/15 dark:bg-slate-500/20',
        text: 'text-slate-600 dark:text-muted-foreground',
        border: 'border-slate-500/30 dark:border-slate-500/40',
        icon: Circle,
        description: 'Content is in draft mode and not published',
    },
    published: {
        label: 'Published',
        bg: 'bg-green-500/15 dark:bg-green-500/20',
        text: 'text-green-600 dark:text-green-400',
        border: 'border-green-500/30 dark:border-green-500/40',
        icon: CheckCircle2,
        description: 'Content is live and publicly visible',
    },
    archived: {
        label: 'Archived',
        bg: 'bg-gray-500/15 dark:bg-gray-500/20',
        text: 'text-gray-600 dark:text-gray-400',
        border: 'border-gray-500/30 dark:border-gray-500/40',
        icon: Archive,
        description: 'Content has been archived',
    },

    // =========================================================================
    // GENERAL STATUSES
    // =========================================================================
    active: {
        label: 'Active',
        bg: 'bg-green-500/15 dark:bg-green-500/20',
        text: 'text-green-600 dark:text-green-400',
        border: 'border-green-500/30 dark:border-green-500/40',
        icon: CheckCircle2,
        description: 'Currently active',
    },
    inactive: {
        label: 'Inactive',
        bg: 'bg-slate-500/15 dark:bg-slate-500/20',
        text: 'text-slate-600 dark:text-muted-foreground',
        border: 'border-slate-500/30 dark:border-slate-500/40',
        icon: Circle,
        description: 'Currently inactive',
    },
    urgent: {
        label: 'Urgent',
        bg: 'bg-orange-500/15 dark:bg-orange-500/20',
        text: 'text-orange-600 dark:text-orange-400',
        border: 'border-orange-500/30 dark:border-orange-500/40',
        icon: AlertCircle,
        description: 'Requires immediate attention',
        pulse: true,
    },
    critical: {
        label: 'Critical',
        bg: 'bg-red-500/15 dark:bg-red-500/20',
        text: 'text-red-600 dark:text-red-400',
        border: 'border-red-500/30 dark:border-red-500/40',
        icon: AlertTriangle,
        description: 'Critical priority - immediate action required',
        pulse: true,
    },
};

// =============================================================================
// COMPONENT VARIANTS
// =============================================================================

const statusBadgeVariants = cva(
    'inline-flex items-center gap-1.5 font-semibold transition-all duration-200 rounded-full',
    {
        variants: {
            size: {
                xs: 'px-1.5 py-0.5 text-[10px]',
                sm: 'px-2 py-0.5 text-xs',
                default: 'px-2.5 py-1 text-xs',
                lg: 'px-3 py-1.5 text-sm',
            },
            variant: {
                solid: '', // bg filled, specific styling via inline
                outline: 'bg-transparent border', // border styling, transparent bg
                subtle: 'border-transparent', // subtle bg, no border
            },
        },
        defaultVariants: {
            size: 'default',
            variant: 'subtle',
        },
    }
);

// =============================================================================
// COMPONENT PROPS
// =============================================================================

export interface StatusBadgeProps
    extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>,
    VariantProps<typeof statusBadgeVariants> {
    /** The status to display */
    status: StatusType | string;
    /** Whether to show the icon (default: true) */
    showIcon?: boolean;
    /** Whether to show the label (default: true) */
    showLabel?: boolean;
    /** Custom label override */
    customLabel?: string;
    /** Whether to show tooltip with description (default: true) */
    showTooltip?: boolean;
    /** Additional class names */
    className?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * StatusBadge - The canonical status display component.
 * 
 * This is the SINGLE SOURCE OF TRUTH for all status-related styling in the application.
 * All status displays should use this component instead of inline Badge + color logic.
 * 
 * @example
 * // Basic usage
 * <StatusBadge status="completed" />
 * 
 * // With size and variant
 * <StatusBadge status="in-progress" size="lg" variant="outline" />
 * 
 * // Icon only (for tight spaces)
 * <StatusBadge status="pending" showLabel={false} />
 * 
 * // Custom label override
 * <StatusBadge status="pending" customLabel="To Do" />
 */
export function StatusBadge({
    status,
    size,
    variant = 'subtle',
    showIcon = true,
    showLabel = true,
    customLabel,
    showTooltip = true,
    className,
    ...props
}: StatusBadgeProps) {
    // Normalize status string (handle legacy values like 'To Do' → 'pending')
    const normalizedStatus = normalizeStatus(status);

    // Get config, with fallback for unknown statuses
    const config = STATUS_CONFIG[normalizedStatus] || getUnknownConfig(status);

    const Icon = config.icon;
    const label = customLabel || config.label;

    // Determine icon size based on badge size
    const iconSize = {
        xs: 'h-2.5 w-2.5',
        sm: 'h-3 w-3',
        default: 'h-3.5 w-3.5',
        lg: 'h-4 w-4',
    }[size || 'default'];

    // Build the badge content
    const badgeContent = (
        <div
            className={cn(
                statusBadgeVariants({ size, variant }),
                // Apply status-specific colors
                variant === 'solid' && `${config.bg} ${config.text}`,
                variant === 'outline' && `${config.border} ${config.text}`,
                variant === 'subtle' && `${config.bg} ${config.text}`,
                // Pulse animation for urgent states
                config.pulse && 'animate-pulse',
                className
            )}
            {...props}
        >
            {showIcon && Icon && (
                <Icon
                    className={cn(
                        iconSize,
                        normalizedStatus === 'in-progress' && 'animate-spin'
                    )}
                />
            )}
            {showLabel && <span className="truncate">{label}</span>}
        </div>
    );

    // Wrap in tooltip if enabled
    if (showTooltip && config.description) {
        return (
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>{badgeContent}</TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                        <p className="text-xs">{config.description}</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        );
    }

    return badgeContent;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Normalize various status string formats to our canonical StatusType.
 * Handles legacy values, case differences, and common variations.
 */
function normalizeStatus(status: string): StatusType {
    const normalized = String(status).toLowerCase().trim();

    // Direct matches
    if (normalized in STATUS_CONFIG) {
        return normalized as StatusType;
    }

    // Common mappings for legacy/variant values
    const mappings: Record<string, StatusType> = {
        'to-do': 'pending',
        'todo': 'pending',
        'to do': 'pending',
        'not started': 'pending',
        'waiting': 'pending',
        'inprogress': 'in-progress',
        'in progress': 'in-progress',
        'wip': 'in-progress',
        'working': 'in-progress',
        'review': 'submitted-for-review',
        'for review': 'submitted-for-review',
        'needs review': 'submitted-for-review',
        'awaiting review': 'submitted-for-review',
        'done': 'completed',
        'finished': 'completed',
        'closed': 'completed',
        'late': 'overdue',
        'past due': 'overdue',
        'expired': 'overdue',
        'live': 'published',
        'public': 'published',
        'hidden': 'draft',
        'unpublished': 'draft',
    };

    return mappings[normalized] || 'pending'; // Default to pending for unknown
}

/**
 * Generate a fallback config for unknown status values.
 * Ensures the component still renders gracefully.
 */
function getUnknownConfig(status: string): StatusConfig {
    return {
        label: String(status).charAt(0).toUpperCase() + String(status).slice(1),
        bg: 'bg-slate-500/15 dark:bg-slate-500/20',
        text: 'text-slate-600 dark:text-muted-foreground',
        border: 'border-slate-500/30 dark:border-slate-500/40',
        icon: Circle,
        description: `Status: ${status}`,
    };
}

// =============================================================================
// UTILITY EXPORTS (for consumers who need raw config)
// =============================================================================

/**
 * Get the configuration for a specific status.
 * Useful for components that need to access colors without rendering the badge.
 */
export function getStatusConfig(status: StatusType | string): StatusConfig {
    const normalized = normalizeStatus(status as string);
    return STATUS_CONFIG[normalized] || getUnknownConfig(status as string);
}

/**
 * Get all available status types.
 * Useful for dropdowns, filters, etc.
 */
export function getAllStatusTypes(): StatusType[] {
    return Object.keys(STATUS_CONFIG) as StatusType[];
}

/**
 * Check if a string is a valid StatusType.
 */
export function isValidStatus(status: string): status is StatusType {
    return normalizeStatus(status) in STATUS_CONFIG;
}

export default StatusBadge;
