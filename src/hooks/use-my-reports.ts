"use client";

import { useState, useEffect, useCallback } from 'react';
import { useUser } from '@/firebase/auth/use-user';

interface TeamMember {
    id: string;
    displayName: string;
    email: string | null;
    role: string;
}

/**
 * Hook to fetch current user's direct + indirect reports.
 * Used for filtering assignee dropdowns to only show people the user can delegate to.
 */
export function useMyReports() {
    const { user } = useUser();
    const [reports, setReports] = useState<TeamMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchReports = useCallback(async () => {
        if (!user) {
            setReports([]);
            setLoading(false);
            return;
        }

        setLoading(true);
        try {
            const token = await user.getIdToken();
            const res = await fetch('/api/profile/my-team', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!res.ok) throw new Error('Failed to fetch reports');

            const data = await res.json();
            setReports(data.reports || []);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
            setReports([]);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        fetchReports();
    }, [fetchReports]);

    // Check if a given userId is in the user's subtree
    const canDelegateTo = useCallback((userId: string) => {
        return reports.some(r => r.id === userId);
    }, [reports]);

    return {
        reports,
        loading,
        error,
        canDelegateTo,
        refetch: fetchReports
    };
}
