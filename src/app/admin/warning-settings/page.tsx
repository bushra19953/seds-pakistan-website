'use client';

import { useState, useEffect } from 'react';
import { useFirestore } from '@/firebase';
import { doc, getDoc, serverTimestamp } from 'firebase/firestore';
;
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Save, RotateCcw, ShieldAlert, Info } from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { useAuthorization } from '@/hooks/use-authorization';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { WarningSettings, DEFAULT_WARNING_SETTINGS } from '@/types/user';
import Link from 'next/link';
import { setDoc } from '@/lib/client/firestore-wrapper';


export default function WarningSettingsPage() {
    const firestore = useFirestore();
    const { showToast: toast } = useEnhancedToast();
    const { isAuthorized: canManageUsers } = useAuthorization('canManageUsers');

    const [form, setForm] = useState<WarningSettings>(DEFAULT_WARNING_SETTINGS);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        const load = async () => {
            try {
                const snap = await getDoc(doc(firestore, 'warningConfig', 'global'));
                if (snap.exists()) {
                    setForm({ ...DEFAULT_WARNING_SETTINGS, ...(snap.data() as WarningSettings) });
                }
            } catch (e) {
                console.error('[WarningSettings] load error', e);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [firestore]);

    const update = (key: keyof WarningSettings, value: unknown) => {
        setForm((f) => ({ ...f, [key]: value }));
        setDirty(true);
    };

    const handleSave = async () => {
        if (!canManageUsers) return;
        setSaving(true);
        try {
            await setDoc(
                doc(firestore, 'warningConfig', 'global'),
                {
                    ...form,
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );
            toast({ title: '✅ Warning Settings Saved', description: 'Global warning configuration updated.' });
            setDirty(false);
        } catch (e: any) {
            toast({ variant: 'destructive', title: 'Error', description: e.message });
        } finally {
            setSaving(false);
        }
    };

    const handleReset = () => {
        setForm(DEFAULT_WARNING_SETTINGS);
        setDirty(true);
    };

    if (loading) {
        return (
            <div className="p-8 flex justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
        );
    }

    return (
        <AuthorizationGate permission="canManageUsers">
            <div className="container mx-auto py-8 max-w-3xl space-y-6">
                {/* Header */}
                <div className="flex items-start justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                            <ShieldAlert className="h-8 w-8 text-amber-500" />
                            Warning Settings
                        </h1>
                        <p className="text-muted-foreground mt-1">
                            Configure global warning system variables. Changes apply immediately to all new warnings.
                        </p>
                    </div>
                    <Button variant="outline" asChild>
                        <Link href="/admin/defaulters">← Defaulters</Link>
                    </Button>
                </div>

                {dirty && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                        <Info className="h-4 w-4 text-amber-500 flex-shrink-0" />
                        <p className="text-sm text-amber-600 dark:text-amber-400">You have unsaved changes.</p>
                    </div>
                )}

                {/* Blacklisting & Thresholds */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Blacklisting & Thresholds</CardTitle>
                        <CardDescription>Control when users are automatically flagged.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                        <div className="grid grid-cols-2 gap-5">
                            <div className="space-y-2">
                                <Label htmlFor="blacklistThreshold">
                                    Blacklist Threshold{' '}
                                    <Badge variant="secondary" className="ml-1 text-[10px]">
                                        Currently: {form.blacklistThreshold}
                                    </Badge>
                                </Label>
                                <Input
                                    id="blacklistThreshold"
                                    type="number"
                                    min={1}
                                    max={20}
                                    value={String(form.blacklistThreshold)}
                                    onChange={(e) => update('blacklistThreshold', Math.max(1, Number(e.target.value)))}
                                    disabled={!canManageUsers}
                                />
                                <p className="text-xs text-muted-foreground">
                                    Users are blacklisted after reaching this many active warnings.
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="expirationDays">
                                    Default Expiration (days){' '}
                                    <Badge variant="secondary" className="ml-1 text-[10px]">
                                        Currently: {form.expirationDays}d
                                    </Badge>
                                </Label>
                                <Input
                                    id="expirationDays"
                                    type="number"
                                    min={1}
                                    max={3650}
                                    value={String(form.expirationDays)}
                                    onChange={(e) => update('expirationDays', Math.max(1, Number(e.target.value)))}
                                    disabled={!canManageUsers}
                                />
                                <p className="text-xs text-muted-foreground">
                                    New warnings will expire after this many days unless overridden manually.
                                </p>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Penalty Points */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Penalty Points</CardTitle>
                        <CardDescription>Points deducted per automatically issued warning.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2 max-w-xs">
                            <Label htmlFor="penaltyPoints">
                                Default Penalty Points per Warning{' '}
                                <Badge variant="secondary" className="ml-1 text-[10px]">
                                    Currently: {form.penaltyPoints}
                                </Badge>
                            </Label>
                            <Input
                                id="penaltyPoints"
                                type="number"
                                min={0}
                                max={100}
                                value={String(form.penaltyPoints)}
                                onChange={(e) => update('penaltyPoints', Math.max(0, Number(e.target.value)))}
                                disabled={!canManageUsers}
                            />
                            <p className="text-xs text-muted-foreground">
                                Applied when auto-warning is issued for a missed deadline. 0 = no penalty.
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* Automation */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Automation Rules</CardTitle>
                        <CardDescription>Control which events trigger automatic warnings.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-center justify-between rounded-lg border border-border/50 p-4">
                            <div className="space-y-0.5">
                                <Label className="text-sm font-medium">Auto-Issue on Deadline Miss</Label>
                                <p className="text-xs text-muted-foreground">
                                    Automatically issue warnings when tasks pass their deadline without submission.
                                </p>
                            </div>
                            <Switch
                                checked={form.autoIssueOnDeadlineMiss}
                                onCheckedChange={(v) => update('autoIssueOnDeadlineMiss', v)}
                                disabled={!canManageUsers}
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Visibility */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Public Visibility</CardTitle>
                        <CardDescription>Control what the public can see.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-center justify-between rounded-lg border border-border/50 p-4">
                            <div className="space-y-0.5">
                                <Label className="text-sm font-medium">Enable Public Warning Registry</Label>
                                <p className="text-xs text-muted-foreground">
                                    When enabled, the <code className="text-primary">/warning-registry</code> page is
                                    visible to the public (no email or phone shown).
                                </p>
                            </div>
                            <Switch
                                checked={form.publicVisibility}
                                onCheckedChange={(v) => update('publicVisibility', v)}
                                disabled={!canManageUsers}
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Enforcement */}
                <Card className="border-red-500/20 bg-red-500/5">
                    <CardHeader>
                        <CardTitle className="text-base text-red-500">Global Enforcement</CardTitle>
                        <CardDescription>Master switch for the entire accountability system.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-center justify-between rounded-lg border border-red-500/20 p-4">
                            <div className="space-y-0.5">
                                <Label className="text-sm font-medium text-red-400">Enforce Blacklist Blocks</Label>
                                <p className="text-xs text-muted-foreground">
                                    When <strong>OFF</strong>, blacklisted users can still register for events and perform restricted actions. Use this for "amnesty" periods.
                                </p>
                            </div>
                            <Switch
                                checked={form.enforcementEnabled}
                                onCheckedChange={(v) => update('enforcementEnabled', v)}
                                disabled={!canManageUsers}
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Actions */}
                <Separator />
                <div className="flex items-center gap-3">
                    <Button
                        onClick={handleSave}
                        disabled={saving || !canManageUsers || !dirty}
                        className="gap-2"
                    >
                        <Save className="h-4 w-4" />
                        {saving ? 'Saving…' : 'Save Settings'}
                    </Button>
                    <Button variant="outline" onClick={handleReset} disabled={saving} className="gap-2">
                        <RotateCcw className="h-4 w-4" />
                        Reset to Defaults
                    </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                    Changes to expiration and threshold only affect <strong>new</strong> warnings. Existing
                    warning documents retain their original values. Use the Defaulters page to edit individual
                    warnings.
                </p>
            </div>
        </AuthorizationGate>
    );
}
