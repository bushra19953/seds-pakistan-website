'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Bell, BellOff, Volume2, VolumeX, Smartphone, Mail, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useUser } from '@/firebase';
import { useToast } from '@/hooks/use-toast';
import {
    isPushSupported, getNotificationPermission, requestPushPermission, disablePushNotifications
} from '@/lib/push-notifications';
import { doc, getDoc } from 'firebase/firestore';
;
import { firestore } from '@/firebase';
import { updateDoc } from '@/lib/client/firestore-wrapper';


interface NotificationPrefs {
    enableSound: boolean;
    enableVibration: boolean;
    enablePush: boolean;
    enableEmail: boolean;
}

export function NotificationPreferences() {
    const { user } = useUser();
    const { toast } = useToast();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [pushSupported, setPushSupported] = useState(false);
    const [pushPermission, setPushPermission] = useState<NotificationPermission | 'unsupported'>('default');
    const [prefs, setPrefs] = useState<NotificationPrefs>({
        enableSound: true,
        enableVibration: true,
        enablePush: false,
        enableEmail: true
    });

    // Check push support and load preferences
    useEffect(() => {
        const init = async () => {
            // Check push support
            const supported = await isPushSupported();
            setPushSupported(supported);
            setPushPermission(getNotificationPermission());

            // Load sound preference from localStorage
            try {
                const muted = localStorage.getItem('notification-sound-muted');
                if (muted === 'true') {
                    setPrefs(p => ({ ...p, enableSound: false }));
                }
            } catch { }

            // Load user preferences from Firestore
            if (user && firestore) {
                try {
                    const userDoc = await getDoc(doc(firestore, 'users', user.uid));
                    if (userDoc.exists()) {
                        const data = userDoc.data();
                        setPrefs(p => ({
                            ...p,
                            enablePush: data.pushEnabled ?? false,
                            enableEmail: data.emailNotifications ?? true,
                            enableVibration: data.vibrationEnabled ?? true
                        }));
                    }
                } catch (error) {
                    console.error('Error loading notification prefs:', error);
                }
            }

            setLoading(false);
        };

        init();
    }, [user]);

    const handleSoundToggle = (checked: boolean) => {
        setPrefs(p => ({ ...p, enableSound: checked }));
        try {
            localStorage.setItem('notification-sound-muted', String(!checked));
        } catch { }
        toast({ title: checked ? 'Sound enabled' : 'Sound muted' });
    };

    const handleVibrationToggle = async (checked: boolean) => {
        if (!user || !firestore) return;
        setSaving(true);
        try {
            await updateDoc(doc(firestore, 'users', user.uid), { vibrationEnabled: checked });
            setPrefs(p => ({ ...p, enableVibration: checked }));
            toast({ title: checked ? 'Vibration enabled' : 'Vibration disabled' });
        } catch (error) {
            toast({ variant: 'destructive', title: 'Failed to save preference' });
        } finally {
            setSaving(false);
        }
    };

    const handlePushToggle = async (checked: boolean) => {
        if (!user) return;
        setSaving(true);

        try {
            if (checked) {
                // Request permission and get token
                const token = await requestPushPermission(user.uid);
                if (token) {
                    setPrefs(p => ({ ...p, enablePush: true }));
                    setPushPermission('granted');
                    toast({ title: 'Push notifications enabled!', description: 'You will receive alerts on this device.' });
                } else {
                    toast({ variant: 'destructive', title: 'Permission denied', description: 'Please enable notifications in your browser settings.' });
                }
            } else {
                // Disable push
                await disablePushNotifications(user.uid);
                setPrefs(p => ({ ...p, enablePush: false }));
                toast({ title: 'Push notifications disabled' });
            }
        } catch (error) {
            toast({ variant: 'destructive', title: 'Failed to update push settings' });
        } finally {
            setSaving(false);
        }
    };

    const handleEmailToggle = async (checked: boolean) => {
        if (!user || !firestore) return;
        setSaving(true);
        try {
            await updateDoc(doc(firestore, 'users', user.uid), { emailNotifications: checked });
            setPrefs(p => ({ ...p, enableEmail: checked }));
            toast({ title: checked ? 'Email notifications enabled' : 'Email notifications disabled' });
        } catch (error) {
            toast({ variant: 'destructive', title: 'Failed to save preference' });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <Card>
                <CardContent className="flex justify-center items-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Bell className="h-5 w-5" />
                    Notification Preferences
                </CardTitle>
                <CardDescription>
                    Control how you receive notifications for tasks, announcements, and updates.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                {/* Sound */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        {prefs.enableSound ? <Volume2 className="h-5 w-5 text-primary" /> : <VolumeX className="h-5 w-5 text-muted-foreground" />}
                        <div>
                            <Label htmlFor="sound" className="text-base">Sound</Label>
                            <p className="text-sm text-muted-foreground">Play a sound when new notifications arrive</p>
                        </div>
                    </div>
                    <Switch id="sound" checked={prefs.enableSound} onCheckedChange={handleSoundToggle} disabled={saving} />
                </div>

                {/* Vibration */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Smartphone className={`h-5 w-5 ${prefs.enableVibration ? 'text-primary' : 'text-muted-foreground'}`} />
                        <div>
                            <Label htmlFor="vibration" className="text-base">Vibration</Label>
                            <p className="text-sm text-muted-foreground">Vibrate on mobile devices</p>
                        </div>
                    </div>
                    <Switch id="vibration" checked={prefs.enableVibration} onCheckedChange={handleVibrationToggle} disabled={saving} />
                </div>

                {/* Push Notifications */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        {prefs.enablePush ? <Bell className="h-5 w-5 text-primary" /> : <BellOff className="h-5 w-5 text-muted-foreground" />}
                        <div>
                            <div className="flex items-center gap-2">
                                <Label htmlFor="push" className="text-base">Push Notifications</Label>
                                {pushPermission === 'granted' && <Badge variant="outline" className="text-xs"><CheckCircle2 className="h-3 w-3 mr-1" />Enabled</Badge>}
                                {pushPermission === 'denied' && <Badge variant="destructive" className="text-xs"><AlertCircle className="h-3 w-3 mr-1" />Blocked</Badge>}
                            </div>
                            <p className="text-sm text-muted-foreground">
                                {pushSupported
                                    ? 'Get notified even when you\'re not on the site'
                                    : 'Not supported in this browser'}
                            </p>
                        </div>
                    </div>
                    <Switch
                        id="push"
                        checked={prefs.enablePush}
                        onCheckedChange={handlePushToggle}
                        disabled={saving || !pushSupported || pushPermission === 'denied'}
                    />
                </div>

                {/* Email */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Mail className={`h-5 w-5 ${prefs.enableEmail ? 'text-primary' : 'text-muted-foreground'}`} />
                        <div>
                            <Label htmlFor="email" className="text-base">Email Notifications</Label>
                            <p className="text-sm text-muted-foreground">Receive important updates via email</p>
                        </div>
                    </div>
                    <Switch id="email" checked={prefs.enableEmail} onCheckedChange={handleEmailToggle} disabled={saving} />
                </div>

                {/* Help text */}
                <div className="text-xs text-muted-foreground border-t pt-4 mt-4">
                    You will always receive in-app notifications. These preferences control additional notification channels.
                </div>
            </CardContent>
        </Card>
    );
}

export default NotificationPreferences;
