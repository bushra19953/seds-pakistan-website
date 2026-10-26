"use client";

import { useEffect, useState } from 'react';
import { firestore } from '@/firebase';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { serverWrite } from '@/lib/client/server-write';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

export default function SeedPage() {
    const [status, setStatus] = useState('Initializing...');

    useEffect(() => {
        const seed = async () => {
            try {
                const productRef = doc(firestore, 'products', 'chapter-fee');
                const docSnap = await getDoc(productRef);

                if (!docSnap.exists()) {
                    setStatus('Creating chapter-fee product...');
                    // WS10: the create runs server-side via
                    // POST /api/admin/seed/chapter-fee, which
                    // re-checks existence and writes the exact
                    // seed payload.
                    const res = await serverWrite('/api/admin/seed/chapter-fee', 'POST');
                    setStatus(res.body?.created ? 'Success: Product created!' : 'Skipped: Product already exists.');
                } else {
                    setStatus('Skipped: Product already exists.');
                }
            } catch (err: any) {
                setStatus('Error: ' + err.message);
            }
        };

        seed();
    }, []);

    return (
        <AuthorizationGate permission="canManageStore">
            <div>{status}</div>
        </AuthorizationGate>
    );
}
