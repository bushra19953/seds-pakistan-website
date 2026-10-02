'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Check, ArrowRight, Save } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SubmitButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    children: React.ReactNode;
    isSubmitting?: boolean;
    isSuccess?: boolean;
    successMessage?: string;
    loadingMessage?: string;
    variant?: 'default' | 'outline' | 'ghost' | 'success';
    className?: string;
}

export function SubmitButton({
    children,
    isSubmitting = false,
    isSuccess = false,
    successMessage = 'Success!',
    loadingMessage = 'Processing...',
    variant = 'default',
    className,
    disabled,
    ...props
}: SubmitButtonProps) {
    const [internalState, setInternalState] = useState<'idle' | 'loading' | 'success'>('idle');

    useEffect(() => {
        if (isSuccess) {
            setInternalState('success');
            const timer = setTimeout(() => {
                setInternalState('idle');
            }, 3000); // Reset after 3 seconds by default, parent can override by controlling props
            return () => clearTimeout(timer);
        } else if (isSubmitting) {
            setInternalState('loading');
        } else {
            setInternalState('idle');
        }
    }, [isSubmitting, isSuccess]);

    const variants = {
        idle: {
            width: 'auto',
            backgroundColor: variant === 'default' ? 'hsl(var(--primary))' : variant === 'success' ? 'hsl(var(--green-600) / 1)' : 'transparent',
            color: variant === 'default' ? 'hsl(var(--primary-foreground))' : variant === 'success' ? 'white' : 'hsl(var(--foreground))',
        },
        loading: {
            width: 'auto',
            backgroundColor: 'hsl(var(--muted))',
            color: 'hsl(var(--muted-foreground))',
            transition: { duration: 0.2 }
        },
        success: {
            width: 'auto',
            backgroundColor: 'hsl(var(--green-600) / 1)',
            color: 'white',
            scale: 1.05,
            transition: { type: 'spring', stiffness: 500, damping: 30 }
        }
    };

    const contentVariants = {
        initial: { y: 20, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        exit: { y: -20, opacity: 0 }
    };

    return (
        <motion.button
            className={cn(
                "relative flex items-center justify-center rounded-lg px-6 py-2.5 font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden shadow-sm hover:shadow-md active:scale-95",
                className
            )}
            disabled={isSubmitting || isSuccess || disabled}
            initial="idle"
            animate={internalState}
            variants={variants as any}
            layout
            {...props as any}
        >
            <AnimatePresence mode="wait" initial={false}>
                {internalState === 'loading' && (
                    <motion.div
                        key="loading"
                        variants={contentVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="flex items-center gap-2 whitespace-nowrap"
                    >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{loadingMessage}</span>
                    </motion.div>
                )}

                {internalState === 'success' && (
                    <motion.div
                        key="success"
                        variants={contentVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="flex items-center gap-2 whitespace-nowrap"
                    >
                        <Check className="h-5 w-5 stroke-[3px]" />
                        <span>{successMessage}</span>
                        <div className="absolute inset-0 bg-white/20 animate-pulse" />
                    </motion.div>
                )}

                {internalState === 'idle' && (
                    <motion.div
                        key="idle"
                        variants={contentVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="flex items-center gap-2"
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.button>
    );
}
