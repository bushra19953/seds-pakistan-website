"use client";

import * as React from "react";
import { motion, HTMLMotionProps } from "framer-motion";
import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import useSound from "use-sound";

const buttonVariants = cva(
    "inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    {
        variants: {
            variant: {
                default: "bg-blue-600 text-white hover:bg-blue-700 shadow-[0_0_15px_rgba(37,99,235,0.3)]",
                destructive: "bg-red-500 text-slate-50 hover:bg-red-500/90",
                outline: "border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200",
                secondary: "bg-slate-800 text-slate-100 hover:bg-slate-800/80",
                ghost: "hover:bg-slate-800 hover:text-slate-100 text-slate-300",
                link: "text-blue-500 underline-offset-4 hover:underline",
                gradient: "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-[0_0_15px_rgba(79,70,229,0.4)] text-white border-0",
            },
            size: {
                default: "h-10 px-4 py-2",
                sm: "h-9 rounded-lg px-3",
                lg: "h-12 rounded-xl px-8 text-base",
                icon: "h-10 w-10",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
);

export interface SensoryButtonProps
    extends Omit<HTMLMotionProps<"button">, "disabled">, // Omit to avoid conflict with standard button
    VariantProps<typeof buttonVariants> {
    asChild?: boolean;
    soundPath?: string; // Optional custom sound on click
    disabled?: boolean;
}

const SensoryButton = React.forwardRef<HTMLButtonElement, SensoryButtonProps>(
    ({ className, variant, size, asChild = false, soundPath = "/sounds/tap.mp3", onClick, disabled, ...props }, ref) => {

        // Initialize sound. Fails silently if the path is invalid or blocked by browser initially.
        const [playTap] = useSound(soundPath, { volume: 0.3, interrupt: true });

        const handleClick = (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
            if (!disabled) {
                playTap();
                if (onClick) onClick(e);
            }
        };

        return (
            <motion.button
                ref={ref}
                className={cn(buttonVariants({ variant, size, className }))}
                whileHover={!disabled ? { scale: 1.02, y: -1 } : {}}
                whileTap={!disabled ? { scale: 0.95 } : {}}
                onClick={handleClick}
                disabled={disabled}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 400, damping: 17 }}
                {...props}
            />
        );
    }
);
SensoryButton.displayName = "SensoryButton";

export { SensoryButton, buttonVariants };
