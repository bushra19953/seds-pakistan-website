import { useState, useEffect } from 'react';
import { getFirestore, doc, getDoc, arrayUnion } from 'firebase/firestore';
;
import { getFirebaseApp } from '@/firebase/provider';
import { updateDoc, setDoc } from '@/lib/client/firestore-wrapper';


const METADATA_DOC = 'settings/induction_metadata';

export function useUniversities() {
    const [universities, setUniversities] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchUniversities = async () => {
            try {
                const db = getFirestore(getFirebaseApp());
                const docSnap = await getDoc(doc(db, METADATA_DOC));
                if (docSnap.exists() && docSnap.data().universities) {
                    setUniversities(docSnap.data().universities.sort());
                } else {
                    // Default list if none exists
                    const defaults = ["NUST", "FAST-NUCES", "LUMS", "UET Lahore", "GIKI"];
                    setUniversities(defaults.sort());
                    if (!docSnap.exists()) {
                        await setDoc(doc(db, METADATA_DOC), { universities: defaults });
                    }
                }
            } catch (error) {
                console.error("Error fetching universities:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchUniversities();
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

    return { universities, loading, addUniversity };
}
