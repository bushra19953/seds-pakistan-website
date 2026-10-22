'use client';

/**
 * DisciplineSettingsPanel - the single "Discipline Settings" screen,
 * formerly /admin/warning-settings (which now redirects here). It is
 * the "Settings" tab of the /admin/discipline hub and edits BOTH
 * policy docs side by side, labelled by the system each belongs to:
 *
 *  1. settings/discipline - the NEW discipline system (spec E.6.3,
 *     E.9): shadowMode, cronReferralLive, the referral rule, and the
 *     warning registry variant that gates the Records tab. This doc
 *     previously had NO admin UI at all; it is read and written
 *     through /api/admin/discipline-settings.
 *  2. warningConfig/global - the LEGACY warning policy, still read by
 *     the enforcement paths (event registration, store, invoices,
 *     chapter applications, clear-probation). Only its live fields
 *     keep controls: blacklistThreshold, expirationDays,
 *     enforcementEnabled.
 *
 * Removed, not moved (nav audit slice 08): the autoIssueOnDeadlineMiss
 * and penaltyPoints controls. No server code reads either field since
 * the check-deadlines cron was converted to the discipline referral
 * flow. Their stored values are still round-tripped on save so the
 * doc is never silently rewritten; they simply have no controls.
 */
import { useState, useEffect } from 'react';
import { useFirestore } from '@/firebase';
import { doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Save, RotateCcw, ShieldAlert, Info } from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { useAuthorization } from '@/hooks/use-authorization';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { WarningSettings, DEFAULT_WARNING_SETTINGS } from '@/types/user';
import type { DisciplineSettings } from '@/lib/server/discipline/settings';
import Link from 'next/link';
import { setDoc } from '@/lib/client/firestore-wrapper';

// The legacy form is exactly the shared WarningSettings type, as it
// was on the standalone page. (A page-local permanentBlacklist flag
// used to live here; no server code ever read it, so the control was
// removed rather than wired. The stored field, if present in
// warningConfig/global, is left in place, unread.)
type WarningSettingsForm = WarningSettings;

const DEFAULT_FORM: WarningSettingsForm = {
    ...DEFAULT_WARNING_SETTINGS,
};

const DEFAULT_DISCIPLINE_FORM: DisciplineSettings = {
    shadowMode: true,
    cronReferralLive: false,
    referralWindowDays: 28,
    referralMissThreshold: 3,
    warningRegistryVariant: 'retired',
};

export default function DisciplineSettingsPanel() {
    const firestore = useFirestore();
    const { showToast: toast } = useEnhancedToast();
    const { isAuthorized: canManageUsers } = useAuthorization('canManageUsers');

    // ── Legacy warning configuration (warningConfig/global) ──
    const [form, setForm] = useState<WarningSettingsForm>(DEFAULT_FORM);
    const [original, setOriginal] = useState<WarningSettingsForm>(DEFAULT_FORM);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const dirty = JSON.stringify(form) !== JSON.stringify(original);

    // ── Discipline system settings (settings/discipline) ──
    const [disciplineForm, setDisciplineForm] = useState<DisciplineSettings>(DEFAULT_DISCIPLINE_FORM);
    const [disciplineOriginal, setDisciplineOriginal] = useState<DisciplineSettings>(DEFAULT_DISCIPLINE_FORM);
    const [disciplineLoading, setDisciplineLoading] = useState(true);
    const [disciplineSaving, setDisciplineSaving] = useState(false);
    const disciplineDirty = JSON.stringify(disciplineForm) !== JSON.stringify(disciplineOriginal);

    useEffect(() => {
        const load = async () => {
            try {
                const snap = await getDoc(doc(firestore, 'warningConfig', 'global'));
                if (snap.exists()) {
                    const rawData = snap.data() as Record<string, unknown>;
                    // Drop the orphaned permanentBlacklist field so a save
                    // never writes it back; it is not part of the form.
                    const { permanentBlacklist: _orphaned, ...rest } = rawData;
                    const data = rest as Partial<WarningSettingsForm>;
                    const loaded: WarningSettingsForm = {
                        ...DEFAULT_FORM,
                        ...data,
                    };
                    setForm(loaded);
                    setOriginal(loaded);
                }
            } catch (e) {
                console.error('[DisciplineSettings] warningConfig load error', e);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [firestore]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/admin/discipline-settings', { credentials: 'include' });
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const data = await res.json();
                if (data.settings) {
                    setDisciplineForm(data.settings);
                    setDisciplineOriginal(data.settings);
                }
            } catch (e) {
                console.error('[DisciplineSettings] discipline settings load error', e);
                toast({ variant: 'destructive', title: 'Error', description: 'Failed to load discipline system settings.' });
            } finally {
                setDisciplineLoading(false);
            }
        })();
    }, []);

    const update = (key: keyof WarningSettingsForm, value: unknown) => {
        setForm((f) => ({ ...f, [key]: value }));
    };

    const updateDiscipline = (key: keyof DisciplineSettings, value: unknown) => {
        setDisciplineForm((f) => ({ ...f, [key]: value }));
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
            toast({ title: 'Warning Settings Saved', description: 'Legacy warning configuration updated.' });
            setOriginal(form);
        } catch (e: any) {
            toast({ variant: 'destructive', title: 'Error', description: e.message });
        } finally {
            setSaving(false);
        }
    };

    const handleDisciplineSave = async () => {
        if (!canManageUsers) return;
        setDisciplineSaving(true);
        try {
            const res = await fetch('/api/admin/discipline-settings', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(disciplineForm),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
            toast({ title: 'Discipline Settings Saved', description: 'Discipline system settings updated.' });
            setDisciplineOriginal(disciplineForm);
        } catch (e: any) {
            toast({ variant: 'destructive', title: 'Error', description: e.message });
        } finally {
            setDisciplineSaving(false);
        }
    };

    const handleReset = () => {
        setForm(DEFAULT_FORM);
    };

    if (loading || disciplineLoading) {
        return (
            <div className="p-8 flex justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
        );
    }

    return (
        <AuthorizationGate permission="canManageUsers">
            <div className="max-w-3xl space-y-6">
                {/* Header */}
                <div className="flex items-start justify-between">
                    <div>
                        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                            <ShieldAlert className="h-7 w-7 text-amber-500" />
                            Discipline Settings
                        </h2>
                        <p className="text-muted-foreground mt-1">
                            One screen for both policy documents. Each section names the system it controls.
                        </p>
                    </div>
                    <Button variant="outline" asChild>
                        <Link href="/admin/discipline?tab=register">← Warnings Register</Link>
                    </Button>
                </div>

                {/* ── Section 1: the discipline system (settings/discipline) ── */}
                <div className="space-y-4">
                    <div>
                        <h3 className="text-lg font-semibold">Discipline system</h3>
                        <p className="text-sm text-muted-foreground">
                            Stored in settings/discipline. These switches control the case system in the
                            Cases tab: whether decided sanctions actually apply, whether the deadline cron
                            drafts referral cases, and which registry variant the Records tab serves.
                        </p>
                    </div>

                    {disciplineDirty && (
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                            <Info className="h-4 w-4 text-amber-500 flex-shrink-0" />
                            <p className="text-sm text-amber-600 dark:text-amber-400">You have unsaved discipline system changes.</p>
                        </div>
                    )}

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Cutover switches</CardTitle>
                            <CardDescription>Both default to the safe position. Turning them on is the bylaws cutover.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between rounded-lg border border-border/50 p-4">
                                <div className="space-y-0.5">
                                    <Label className="text-sm font-medium">Shadow Mode</Label>
                                    <p className="text-xs text-muted-foreground">
                                        When <strong>ON</strong>, case decisions are recorded (with what they would
                                        have applied) but member records are never touched. Turn OFF to make
                                        sanctions apply for real.
                                    </p>
                                </div>
                                <Switch
                                    checked={disciplineForm.shadowMode}
                                    onCheckedChange={(v) => updateDiscipline('shadowMode', v)}
                                    disabled={!canManageUsers}
                                />
                            </div>
                            <div className="flex items-center justify-between rounded-lg border border-border/50 p-4">
                                <div className="space-y-0.5">
                                    <Label className="text-sm font-medium">Deadline-Miss Referrals Live</Label>
                                    <p className="text-xs text-muted-foreground">
                                        When <strong>ON</strong>, the deadline cron records deadline misses and
                                        drafts referral cases for a human to decide. When OFF it detects and
                                        notifies only.
                                    </p>
                                </div>
                                <Switch
                                    checked={disciplineForm.cronReferralLive}
                                    onCheckedChange={(v) => updateDiscipline('cronReferralLive', v)}
                                    disabled={!canManageUsers}
                                />
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Referral rule</CardTitle>
                            <CardDescription>When the cron drafts a referral case for a member.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-5">
                            <div className="grid grid-cols-2 gap-5">
                                <div className="space-y-2">
                                    <Label htmlFor="referralWindowDays">
                                        Referral Window (days){' '}
                                        <Badge variant="secondary" className="ml-1 text-[10px]">
                                            Currently: {disciplineForm.referralWindowDays}d
                                        </Badge>
                                    </Label>
                                    <Input
                                        id="referralWindowDays"
                                        type="number"
                                        min={1}
                                        max={365}
                                        value={String(disciplineForm.referralWindowDays)}
                                        onChange={(e) => updateDiscipline('referralWindowDays', Math.max(1, Number(e.target.value)))}
                                        disabled={!canManageUsers}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Misses are counted inside this rolling window.
                                    </p>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="referralMissThreshold">
                                        Miss Threshold{' '}
                                        <Badge variant="secondary" className="ml-1 text-[10px]">
                                            Currently: {disciplineForm.referralMissThreshold}
                                        </Badge>
                                    </Label>
                                    <Input
                                        id="referralMissThreshold"
                                        type="number"
                                        min={1}
                                        max={20}
                                        value={String(disciplineForm.referralMissThreshold)}
                                        onChange={(e) => updateDiscipline('referralMissThreshold', Math.max(1, Number(e.target.value)))}
                                        disabled={!canManageUsers}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        A referral draft is created at this many misses inside the window.
                                    </p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Warning registry variant</CardTitle>
                            <CardDescription>Which registry surface serves decided-case records (spec E.7).</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2 max-w-md">
                                <Label htmlFor="warningRegistryVariant">Registry Variant</Label>
                                <Select
                                    value={disciplineForm.warningRegistryVariant}
                                    onValueChange={(v) => updateDiscipline('warningRegistryVariant', v)}
                                    disabled={!canManageUsers}
                                >
                                    <SelectTrigger id="warningRegistryVariant">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="retired">Retired (Variant R) - records live in the case queue only</SelectItem>
                                        <SelectItem value="internal">Internal (Variant I) - Records tab serves entitled offices</SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    Under Variant R the Records tab shows its not-enabled notice. Under Variant I it
                                    lists decided cases (case number, tier, date, miss counts) to entitled offices.
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    <div className="flex items-center gap-3">
                        <Button
                            onClick={handleDisciplineSave}
                            disabled={disciplineSaving || !canManageUsers || !disciplineDirty}
                            className="gap-2"
                        >
                            <Save className="h-4 w-4" />
                            {disciplineSaving ? 'Saving…' : 'Save Discipline Settings'}
                        </Button>
                    </div>
                </div>

                <Separator />

                {/* ── Section 2: legacy warning configuration (warningConfig/global) ── */}
                <div className="space-y-4">
                    <div>
                        <h3 className="text-lg font-semibold">Legacy warning configuration</h3>
                        <p className="text-sm text-muted-foreground">
                            Stored in warningConfig/global. The discipline system above replaced direct
                            warning issuance; these fields remain because enforcement paths still read them.
                            Changes apply immediately.
                        </p>
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
                            <CardDescription>Read by the probation and telemetry paths.</CardDescription>
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
                                        Shown as the warnings denominator in the Register. No code blacklists
                                        automatically at this count any more; blacklist and ban are outcomes
                                        of decided disciplinary cases only.
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
                                        Read by the probation-clearing cron for legacy warning records.
                                    </p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Enforcement */}
                    <Card className="border-red-500/20 bg-red-500/5">
                        <CardHeader>
                            <CardTitle className="text-base text-red-500">Global Enforcement</CardTitle>
                            <CardDescription>Master switch for blacklist blocks in the legacy enforcement paths.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center justify-between rounded-lg border border-red-500/20 p-4">
                                <div className="space-y-0.5">
                                    <Label className="text-sm font-medium text-red-400">Enforce Blacklist Blocks</Label>
                                    <p className="text-xs text-muted-foreground">
                                        When <strong>OFF</strong>, blacklisted users can still register for events and perform restricted actions. Use this for &quot;amnesty&quot; periods.
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

                    {/* Effective Policy */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Effective Policy</CardTitle>
                            <CardDescription>
                                Plain-language summary of what the settings above do right now. This updates as you change values.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <ol className="space-y-2 text-sm list-decimal list-inside">
                                <li>
                                    A member&apos;s warning count is <strong>derived from decided disciplinary cases</strong>.
                                    It is not incremented by hand, and reaching{' '}
                                    <strong>{form.blacklistThreshold}</strong> warnings does not blacklist anyone
                                    automatically.
                                </li>
                                <li>
                                    Blacklist and ban exist only as sanctions applied by a decided case
                                    {disciplineForm.shadowMode ? (
                                        <>, and while shadow mode is ON (above) even those are only recorded, not applied</>
                                    ) : (
                                        <> (shadow mode is OFF above, so decided sanctions apply)</>
                                    )}.
                                </li>
                                <li>
                                    Legacy warnings expire after <strong>{form.expirationDays} days</strong> for
                                    probation purposes. Expired warnings stay in history but no longer count as active.
                                </li>
                                <li>
                                    Enforcement of blacklist blocks is{' '}
                                    <strong>{form.enforcementEnabled ? 'ON' : 'OFF'}</strong>
                                    {form.enforcementEnabled ? (
                                        <>. Blacklisted users are blocked from event registration, chapter registration, store, and invoices.</>
                                    ) : (
                                        <>. Blacklisted users are NOT blocked from anything (amnesty mode).</>
                                    )}
                                </li>
                            </ol>
                        </CardContent>
                    </Card>

                    {/* Actions */}
                    <div className="flex items-center gap-3">
                        <Button
                            onClick={handleSave}
                            disabled={saving || !canManageUsers || !dirty}
                            className="gap-2"
                        >
                            <Save className="h-4 w-4" />
                            {saving ? 'Saving…' : 'Save Warning Settings'}
                        </Button>
                        <Button variant="outline" onClick={handleReset} disabled={saving} className="gap-2">
                            <RotateCcw className="h-4 w-4" />
                            Reset to Defaults
                        </Button>
                    </div>

                    <p className="text-xs text-muted-foreground">
                        Changes to expiration and threshold only affect <strong>new</strong> records. Existing
                        warning documents retain their original values.
                    </p>
                </div>
            </div>
        </AuthorizationGate>
    );
}
