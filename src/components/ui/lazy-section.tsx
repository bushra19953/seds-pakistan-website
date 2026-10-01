"use client";

import { useState, useEffect, useRef, ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

interface LazySectionProps {
    children: ReactNode;
    fallback?: ReactNode;
    rootMargin?: string;
    minHeight?: string;
}

/**
 * LazySection - Defers mounting of children until the section scrolls into view.
 * Uses Intersection Observer for optimal performance.
 */
export default function LazySection({
    children,
    fallback,
    rootMargin = '200px', // Start loading 200px before visible
    minHeight = '200px'
}: LazySectionProps) {
    const [isVisible, setIsVisible] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setIsVisible(true);
                    observer.disconnect(); // Stop observing once visible
                }
            },
            { rootMargin }
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [rootMargin]);

    if (!isVisible) {
        return (
            <div ref={ref} style={{ minHeight }}>
                {fallback || (
                    <div className="animate-pulse space-y-4 p-8">
                        <Skeleton className="h-8 w-1/3" />
                        <Skeleton className="h-32 w-full" />
                    </div>
                )}
            </div>
        );
    }

    return <>{children}</>;
}
