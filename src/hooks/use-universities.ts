import { useState, useEffect } from 'react';
import { getFirestore, doc, getDoc, arrayUnion } from 'firebase/firestore';
;
import { getFirebaseApp } from '@/firebase/provider';
import { updateDoc, setDoc } from '@/lib/client/firestore-wrapper';


const METADATA_DOC = 'settings/induction_metadata';

// Module-level promise cache. Every instance of this hook shares one
// in-flight or completed read of the metadata doc, so mounting the hook twice
// (e.g. UniversityAutocomplete plus the induction page) issues a single
// Firestore read instead of one per instance.
let metadataPromise: Promise<string[]> | null = null;

function loadUniversities(): Promise<string[]> {
    if (metadataPromise) return metadataPromise;
    metadataPromise = (async () => {
        const db = getFirestore(getFirebaseApp());
        const docSnap = await getDoc(doc(db, METADATA_DOC));
        if (docSnap.exists() && docSnap.data().universities) {
            return (docSnap.data().universities as string[]).sort();
        }
        // Default list if none exists
        const defaults = ["NUST", "FAST-NUCES", "LUMS", "UET Lahore", "GIKI"];
        if (!docSnap.exists()) {
            await setDoc(doc(db, METADATA_DOC), { universities: defaults });
        }
        return defaults.sort();
    })().catch((error) => {
        // Clear the cache on failure so a later mount can retry the read.
        metadataPromise = null;
        throw error;
    });
    return metadataPromise;
}

export function useUniversities() {
    const [universities, setUniversities] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadUniversities()
            .then((list) => {
                if (cancelled) return;
                setUniversities(list);
                setError(null);
                setLoading(false);
            })
            .catch((err) => {
                if (cancelled) return;
                console.error("Error fetching universities:", err);
                setError(err instanceof Error ? err : new Error(String(err)));
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const addUniversity = async (name: string) => {
        if (!name || universities.includes(name)) return;
        try {
            const db = getFirestore(getFirebaseApp());
            await updateDoc(doc(db, METADATA_DOC), {
                universities: arrayUnion(name)
            });
            setUniversities(prev => [...prev, name].sort());
        } catch (error) {
            console.error("Error adding university:", error);
        }
    };

    return { universities, loading, error, addUniversity };
}
