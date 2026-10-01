'use client';

import { useMemo } from 'react';
import { useFirestore, useCollection } from '@/firebase';
import { query, where, orderBy } from 'firebase/firestore';
import { organizationsCollection, type OrganizationRecord, type OrganizationType } from '@/lib/organizations';

interface UseOrganizationsOptions {
    /** Filter by organization type */
    type?: OrganizationType | 'partner' | 'sponsor' | 'all';
    /** Only active organizations (default: true) */
    activeOnly?: boolean;
    /** Only organizations marked for homepage marquee */
    marqueeOnly?: boolean;
}

interface UseOrganizationsReturn {
    data: OrganizationRecord[];
    loading: boolean;
    error: Error | null;
}

/**
 * Hook to fetch organizations from Firestore
 * 
 * @example
 * // Fetch all partner organizations
 * const { data, loading, error } = useOrganizations({ type: 'partner' });
 * 
 * // Fetch sponsors for marquee
 * const { data } = useOrganizations({ type: 'sponsor', marqueeOnly: true });
 */
export function useOrganizations(options: UseOrganizationsOptions = {}): UseOrganizationsReturn {
    const { type = 'all', activeOnly = true, marqueeOnly = false } = options;
    const db = useFirestore();

    const organizationsQuery = useMemo(() => {
        if (!db) return null;

        try {
            const col = organizationsCollection(db);

            // Build query based on options
            // Note: Firestore requires indexes for compound queries
            // When marqueeOnly, we filter by showOnHomepageMarquee
            if (marqueeOnly) {
                return query(
                    col,
                    where('showOnHomepageMarquee', '==', true),
                    where('isActive', '==', true),
                    orderBy('displayOrder', 'asc')
                );
            }

            // For type filtering, we need to map 'partner' and 'sponsor' to actual types
            if (type === 'partner') {
                return query(
                    col,
                    where('type', '==', 'Institutional Partner'),
                    orderBy('displayOrder', 'asc')
                );
            }

            if (type === 'sponsor') {
                return query(
                    col,
                    where('type', '==', 'Sponsor'),
                    orderBy('displayOrder', 'asc')
                );
            }

            if (type !== 'all') {
                return query(
                    col,
                    where('type', '==', type),
                    orderBy('displayOrder', 'asc')
                );
            }

            // Default: all organizations ordered by displayOrder
            return query(col, orderBy('displayOrder', 'asc'));
        } catch (err) {
            console.error('Failed to build organizations query:', err);
            return null;
        }
    }, [db, type, marqueeOnly]);

    const { data: rawData, loading, error } = useCollection<OrganizationRecord>(
        organizationsQuery as any,
        { listen: false }
    );

    // Apply client-side filtering for activeOnly if not already filtered by query
    const data = useMemo(() => {
        const orgs = rawData || [];
        if (activeOnly && !marqueeOnly) {
            return orgs.filter(org => org.isActive !== false);
        }
        return orgs;
    }, [rawData, activeOnly, marqueeOnly]);

    return {
        data,
        loading,
        error: error || null,
    };
}

export default useOrganizations;
