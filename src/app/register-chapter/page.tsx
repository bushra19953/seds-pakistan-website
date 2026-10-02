'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useSiteSettings } from '@/hooks/use-site-settings';
import { useFirestore, useUser } from '@/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { useDoc } from '@/firebase';
import createDOMPurify from 'dompurify';
import { Button } from '@/components/ui/button';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import Link from 'next/link';
import { GraduationCap, ShieldCheck, Info, ArrowRight, LogIn } from 'lucide-react';
import { ChapterApplicationForm } from '@/components/chapters/chapter-application-form';
import { createChapterApplication } from '@/app/actions/chapter-applications';
import type { CreateChapterApplicationInput } from '@/types/chapter-application';

interface PageContent {
    title: string;
    content: string;
    meta_description: string;
}

const RegisterChapterPage = () => {
    const router = useRouter();
    const { user, isLoading: userLoading } = useUser();
    const { showErrorToast, showSuccessToast } = useEnhancedToast();

    const [pageContent, setPageContent] = useState<PageContent>({
        title: 'Register a Chapter',
        content: '',
        meta_description: 'Start a SEDS chapter at your university or school.',
    });
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string>('');
    const [showForm, setShowForm] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [userPhone, setUserPhone] = useState('');
    const { settings, loading: settingsLoading } = useSiteSettings();
    const firestore = useFirestore();

    // Fetch global enforcement config
    const configRef = useMemo(() => doc(firestore, 'warningConfig', 'global'), [firestore]);
    const { data: config, loading: configLoading } = useDoc(configRef);

    // Memoize the doc ref so useDoc doesn't re-subscribe on every render
    const chapterProductRef = useMemo(() => doc(firestore, 'products', 'chapter-fee'), [firestore]);
    const { data: chapterProduct, loading: productLoading } = useDoc(chapterProductRef);

    const displayPrice = chapterProduct
        ? `${chapterProduct.currency} ${chapterProduct.price.toLocaleString()}`
        : 'PKR 5,000';

    // 🛑 ENFORCEMENT CHECK: Block if user is blacklisted
    // NOTE: `user` is the Firebase Auth user; the blacklist flag lives on the
    // Firestore user profile (UserProfile.isBlacklisted). The cast keeps this
    // compiling; server-side actions enforce the blacklist authoritatively.
    const enforcementEnabled = config?.enforcementEnabled ?? true;
    const isBlacklisted = (user as any)?.isBlacklisted === true && enforcementEnabled;

    const defaultContent: PageContent = {
        title: 'Register a Chapter',
        content: `
      <div class="max-w-3xl mx-auto text-lg space-y-6">
        <p>
           Leading a SEDS chapter is a prestigious opportunity to bring space education to your campus.
           We are looking for motivated student leaders and faculty advisors.
        </p>
        <div class="bg-slate-900/50 p-8 rounded-2xl border border-white/10 mt-8">
           <h3 class="text-2xl font-bold mb-4 text-primary flex items-center gap-2">
             Requirements
           </h3>
           <ul class="list-disc pl-6 space-y-2 text-slate-300">
             <li>Minimum 5 interested members</li>
             <li>One Faculty Advisor (Professor/Lecturer)</li>
             <li>Approval from University Administration</li>
           </ul>
        </div>
      </div>
    `,
        meta_description: 'Start a SEDS chapter at your university or school.',
    };

    // Fetch CMS page content
    useEffect(() => {
        const fetchPageContent = async () => {
            try {
                const docRef = doc(firestore, 'pages', 'register-chapter');
                const docSnap = await getDoc(docRef);
                if (docSnap.exists()) {
                    const data = docSnap.data() as PageContent;
                    setPageContent(data.content ? data : defaultContent);
                } else {
                    setPageContent(defaultContent);
                }
            } catch {
                setError('Failed to load content.');
            } finally {
                setIsLoading(false);
            }
        };
        fetchPageContent();
    }, []);

    // Fetch user phone for auto-fill
    useEffect(() => {
        if (!user?.uid || !firestore) return;
        getDoc(doc(firestore, 'users', user.uid)).then(snap => {
            if (!snap.exists()) return;
            const d = snap.data();
            setUserPhone(d.whatsappNumber || d.phone || d.phoneNumber || d.contactNumber || '');
        }).catch(() => {});
    }, [user?.uid, firestore]);

    const handleApplicationSubmit = async (data: CreateChapterApplicationInput) => {
        setIsSubmitting(true);
        try {
            const result = await createChapterApplication(data);
            if (!result.success) {
                showErrorToast(result.error || 'Failed to submit application');
                return;
            }
            showSuccessToast('Application submitted! Redirecting to payment...');
            // Redirect to checkout with application ID so the order gets linked
            router.push(`/checkout?productId=${chapterProduct?.id || 'chapter-fee'}&chapterApplicationId=${result.id}`);
        } catch (err: any) {
            showErrorToast(err.message || 'Something went wrong');
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isLoading || settingsLoading || productLoading) {
        return (
            <div className="container mx-auto py-20 flex justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
        );
    }

    if (!settings?.enableChapterRegistration) {
        return (
            <div className="container mx-auto py-20 text-center space-y-6">
                <h1 className="text-4xl font-bold">Registration Closed</h1>
                <p className="text-xl text-muted-foreground">
                    Chapter registration is currently closed. Please check back later or contact us directly.
                </p>
                <div className="pt-8">
                    <Button asChild><Link href="/">Return Home</Link></Button>
                </div>
            </div>
        );
    }

    if (error) return <div className="container mx-auto py-20 text-red-500">{error}</div>;

    return (
        <div className="container mx-auto py-12 px-4 min-h-screen">
            <h1 className="text-4xl md:text-6xl font-extrabold mb-12 text-center bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-500">
                {pageContent.title}
            </h1>

            {!showForm ? (
                <>
                    <div
                        dangerouslySetInnerHTML={{
                            __html: (() => {
                                if (typeof window === 'undefined') return '';
                                const purifier = createDOMPurify();
                                return purifier.sanitize(String(pageContent.content || ''));
                            })()
                        }}
                        className="prose prose-lg dark:prose-invert max-w-none mb-12"
                    />

                    <div className="max-w-3xl mx-auto text-center bg-primary/5 p-12 rounded-3xl border border-primary/20 shadow-2xl">
                        <div className="flex justify-center mb-6">
                            <div className="p-4 bg-primary/10 rounded-full">
                                <GraduationCap className="w-12 h-12 text-primary" />
                            </div>
                        </div>
                        <h2 className="text-3xl font-bold mb-4">Launch Your Mission</h2>
                        <p className="text-slate-400 mb-4 text-lg">
                            Ready to bring space exploration to your university? Fill out the application form, then complete the registration payment.
                        </p>
                        <div className="flex items-center justify-center gap-2 text-slate-300 font-medium text-lg mb-8">
                            <ShieldCheck className="w-5 h-5 text-green-500" />
                            Registration Fee: <span className="text-white font-bold">{displayPrice}</span>
                        </div>

                        {!userLoading && !user ? (
                            <Button size="lg" className="h-14 px-10 text-lg font-bold rounded-xl" asChild>
                                <Link href="/auth?redirect=/register-chapter">
                                    <span className="flex items-center">
                                        <LogIn className="w-5 h-5 mr-2" /> Sign In to Apply
                                    </span>
                                </Link>
                            </Button>
                        ) : isBlacklisted ? (
                            <div className="max-w-md mx-auto p-6 bg-destructive/10 border border-destructive/20 rounded-2xl">
                                <p className="text-destructive font-extrabold text-xl mb-2 uppercase">Account Restricted</p>
                                <p className="text-sm text-muted-foreground leading-relaxed">
                                    Your account is currently blacklisted. Starting a new chapter is restricted until your account status is cleared by the national board.
                                </p>
                            </div>
                        ) : (
                            <Button
                                size="lg"
                                className="h-14 px-10 text-lg font-bold rounded-xl shadow-lg hover:scale-105 transition-transform"
                                onClick={() => setShowForm(true)}
                                disabled={userLoading}
                            >
                                Start Application <ArrowRight className="w-5 h-5 ml-2" />
                            </Button>
                        )}
                    </div>
                </>
            ) : user ? (
                <ChapterApplicationForm
                    user={{ uid: user.uid, displayName: user.displayName, email: user.email }}
                    userPhone={userPhone}
                    onSubmit={handleApplicationSubmit}
                    isSubmitting={isSubmitting}
                />
            ) : null}
        </div>
    );
};

export default RegisterChapterPage;
