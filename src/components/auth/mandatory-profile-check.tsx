'use client';

import { useUser } from '@/firebase';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Phone, AlertTriangle, Save, Loader2 } from 'lucide-react';
import { useFirestore } from '@/firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { setDoc } from '@/lib/client/firestore-wrapper';


export default function MandatoryProfileCheck() {
    const { user } = useUser();
    const pathname = usePathname();
    const router = useRouter();
    const firestore = useFirestore();
    const [whatsapp, setWhatsapp] = useState('');
    const [profile, setProfile] = useState<any>(null);
    const [loadingProfile, setLoadingProfile] = useState(true);
    const { showToast } = useEnhancedToast();
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!user) {
            setLoadingProfile(false);
            return;
        }

        setLoadingProfile(true);

        const unsubscribe = onSnapshot(doc(firestore, 'users', user.uid), (doc) => {
            if (doc.exists()) {
                setProfile(doc.data());
            }
            setLoadingProfile(false);
        }, (err) => {
            console.error('Failed to subscribe to profile:', err);
            setLoadingProfile(false);
        });

        return () => unsubscribe();
    }, [user, firestore]);

    // Exempt routes
    const isExempt =
        pathname?.startsWith('/auth') ||
        pathname === '/profile' ||
        pathname?.startsWith('/profile/settings');

    const hasWhatsapp = Boolean(profile?.whatsapp || profile?.whatsappNumber);

    const handleSave = async () => {
        if (!user || !whatsapp.trim()) return;
        if (whatsapp.length < 10) {
            showToast({
                title: "Invalid Number",
                description: "Please enter a valid phone number (e.g., +92...)",
                variant: "destructive",
            });
            return;
        }

        setSaving(true);
        try {
            await setDoc(doc(firestore, 'users', user.uid), {
                whatsapp: whatsapp.trim(),
                whatsappNumber: whatsapp.trim()
            }, { merge: true });
            
            showToast({
                title: "Contact Info Saved",
                description: "Access granted. Welcome to the mission!",
            });
        } catch (e) {
            console.error(e);
            showToast({
                title: "Save Failed",
                description: "Failed to save contact info. Please try again.",
                variant: "destructive",
            });
        } finally {
            setSaving(false);
        }
    };

    if (loadingProfile || !user || hasWhatsapp || isExempt) return null;

    return (
        <div className="fixed inset-0 z-[9999] bg-slate-950/95 backdrop-blur-sm flex items-center justify-center p-4">
            <Card className="w-full max-w-md border-red-500/30 bg-slate-900 shadow-2xl">
                <CardHeader className="text-center pb-2">
                    <div className="mx-auto w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mb-4">
                        <AlertTriangle className="h-6 w-6 text-red-500" />
                    </div>
                    <CardTitle className="text-xl font-bold text-white">Action Required</CardTitle>
                    <CardDescription className="text-muted-foreground">
                        To ensure effective communication for mission-critical tasks, you must provide a WhatsApp number.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="bg-slate-800/50 p-4 rounded-lg text-xs text-muted-foreground leading-relaxed border border-slate-700/50">
                        <p className="flex items-center gap-2 mb-2 font-semibold text-slate-300">
                            <Phone className="h-3 w-3" />
                            Privacy Notice
                        </p>
                        This number is <strong>hidden by default</strong>. It will only be visible to:
                        <ul className="list-disc pl-4 mt-1 space-y-1">
                            <li>Admins</li>
                            <li>Team members assigned to the same active mission as you</li>
                        </ul>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium text-slate-200">WhatsApp Number</label>
                        <Input
                            placeholder="+92 300 1234567"
                            value={whatsapp}
                            onChange={(e) => setWhatsapp(e.target.value)}
                            className="bg-slate-950 border-slate-700 font-mono"
                        />
                    </div>

                    <Button
                        className="w-full font-bold bg-primary text-black hover:bg-primary/90"
                        onClick={handleSave}
                        disabled={saving || !whatsapp.trim()}
                    >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                        Save & Continue
                    </Button>

                    <div className="text-center">
                        <Button variant="link" className="text-xs text-muted-foreground" onClick={() => router.push('/auth/logout')}>
                            Logout
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
