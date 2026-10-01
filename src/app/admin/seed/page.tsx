"use client";

import { useEffect, useState } from 'react';
import { firestore } from '@/firebase';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { setDoc } from '@/lib/client/firestore-wrapper';
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
                    await setDoc(productRef, {
                        name: "Chapter Registration Fee",
                        description: "Official One-Time Registration Fee for opening a SEDS Chapter.",
                        price: 5000,
                        currency: "PKR",
                        stock: 999999,
                        category: "other",
                        isActive: true,
                        createdAt: Timestamp.now(),
                        updatedAt: Timestamp.now(),
                        createdBy: "system_seed"
                    });
                    setStatus('Success: Product created!');
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
