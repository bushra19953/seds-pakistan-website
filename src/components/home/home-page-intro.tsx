"use client";

import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { useFirestore } from '@/firebase/provider';
// dompurify import removed — the sanitize call is not active; import caused ~22KB of dead JS parse cost

export default function HomePageIntro() {
    const db = useFirestore();
    const [title, setTitle] = useState<string>('');
    const [meta, setMeta] = useState<string>('');
    const [html, setHtml] = useState<string>('');

    // Mounted check to prevent hydration mismatch for purify
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const fetchHome = async () => {
            try {
                const ref = doc(db, 'pages', 'home');
                const snap = await getDoc(ref);
                if (snap.exists()) {
                    const data = snap.data() as any;
                    setTitle(data.title || '');
                    setMeta(data.meta_description || '');
                    // Dynamic import keeps DOMPurify out of the critical bundle
                    // but ensures HTML is ALWAYS sanitized before rendering.
                    const { default: createDOMPurify } = await import('dompurify');
                    const purifier = createDOMPurify(window as unknown as any);
                    setHtml(purifier.sanitize(String(data.content || '')));
                }
            } catch (err) {
                // tolerate missing doc silently
            }
        };
        fetchHome();
    }, [db]);

    if (!mounted) return null; // Avoid hydration mismatch
    if (!title && !html) return null;

    return (
        <section className="py-10 md:py-16" aria-labelledby="home-intro-heading">
            {meta && <meta name="description" content={meta} />}
            <div className="container mx-auto px-4 md:px-6">
                {title && (
                    <h1 id="home-intro-heading" className="text-4xl md:text-5xl font-bold mb-4 text-glow">
                        {title}
                    </h1>
                )}
                {html && (
                    <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: html }} />
                )}
            </div>
        </section>
    );
}
