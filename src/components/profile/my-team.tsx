"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
    Users, UserPlus, ChevronRight, Briefcase, RefreshCw, LayoutGrid, 
    ClipboardList, AlertCircle, Settings2, Sparkles, Eye, EyeOff 
} from 'lucide-react';
import { useUser } from '@/firebase/auth/use-user';
import { USER_ROLES, getRoleDisplayName } from '@/lib/roles';
import Link from 'next/link';
import { TeamTasks } from './team-tasks';
import { Input } from '@/components/ui/input';

interface TeamMember {
    id: string;
    displayName: string;
    email: string | null;
    photoURL: string | null;
    role: string;
    depth: number;
    isDirectReport: boolean;
    relationType?: 'direct' | 'dotted';
    taskCount?: number;
    overdueCount?: number;
}

interface MyTeamProps {
    initialData?: TeamMember[];
}

export function MyTeam({ initialData }: MyTeamProps) {
    const { user } = useUser();
    const [reports, setReports] = useState<TeamMember[]>(initialData || []);
    const [loading, setLoading] = useState(!initialData);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState('team');

    // AI Config State
    const [showAiConfig, setShowAiConfig] = useState(false);
    const [apiKey, setApiKey] = useState('');
    const [showKey, setShowKey] = useState(false);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            setApiKey(localStorage.getItem('gemini.apiKey') || '');
        }
    }, []);

    const saveKey = (val: string) => {
        setApiKey(val);
        localStorage.setItem('gemini.apiKey', val);
    };

    const fetchTeam = useCallback(async () => {
        if (!user?.uid) return;

        setLoading(true);
        setError(null);

        try {
            const token = await user.getIdToken();
            const res = await fetch('/api/profile/my-team', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!res.ok) throw new Error('Failed to load team');

            const data = await res.json();
            setReports(data.reports || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, [user?.uid]);

    // Only fetch if initialData was NOT provided
    const hasFetched = useRef(false);

    useEffect(() => {
        // Skip fetch if we have initial data
        if (initialData && initialData.length > 0) {
            hasFetched.current = true;
            return;
        }

        if (user?.uid && !hasFetched.current) {
            fetchTeam();
            hasFetched.current = true;
        }
    }, [user?.uid, fetchTeam, initialData]);

    const getRoleLabel = (role: string) => {
        return getRoleDisplayName(role);
    };

    if (loading) {
        return (
            <Card className="border-border bg-background/80">
                <CardHeader>
                    <Skeleton className="h-6 w-32" />
                </CardHeader>
                <CardContent className="space-y-3">
                    {[1, 2, 3].map(i => (
                        <Skeleton key={i} className="h-16 w-full" />
                    ))}
                </CardContent>
            </Card>
        );
    }

    if (error) {
        return (
            <Card className="border-red-500/30 bg-red-950/20">
                <CardContent className="py-8 text-center">
                    <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-3" />
                    <p className="text-red-400 mb-4">{error}</p>
                    <Button variant="outline" onClick={fetchTeam}>
                        <RefreshCw className="h-4 w-4 mr-2" /> Retry
                    </Button>
                </CardContent>
            </Card>
        );
    }

    if (reports.length === 0) {
        return (
            <Card className="border-border bg-background/80">
                <CardContent className="py-12 text-center">
                    <Users className="h-10 w-10 text-slate-600 mx-auto mb-3" />
                    <p className="text-muted-foreground mb-2">No direct reports assigned</p>
                    <p className="text-xs text-muted-foreground">When team members are assigned to you, they&apos;ll appear here.</p>
                </CardContent>
            </Card>
        );
    }

    const directCount = reports.filter(r => r.isDirectReport).length;
    const indirectCount = reports.filter(r => !r.isDirectReport).length;

    return (
        <div className="space-y-6">
            {/* AI Setup Guide */}
            <Card className={`border-primary/20 bg-card/50 transition-all ${!apiKey ? 'border-amber-500/50 bg-amber-500/5' : ''}`}>
                <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${!apiKey ? 'bg-amber-500/20 text-amber-500 animate-pulse' : 'bg-primary/20 text-primary'}`}>
                                <Sparkles className="h-5 w-5" />
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-foreground uppercase tracking-tight">
                                    {apiKey ? 'Mission Intelligence Active' : 'Mission Intelligence Offline'}
                                </h4>
                                <p className="text-[10px] text-muted-foreground uppercase font-mono">
                                    {apiKey ? 'AI Orchestration Ready' : 'API Key Required for AI Delegation'}
                                </p>
                            </div>
                        </div>
                        <Button 
                            variant="outline" 
                            size="sm" 
                            onClick={() => setShowAiConfig(!showAiConfig)}
                            className={`h-8 text-[10px] font-black uppercase ${!apiKey ? 'border-amber-500 text-amber-500 hover:bg-amber-500/10' : 'border-slate-800'}`}
                        >
                            <Settings2 className="h-3 w-3 mr-2" />
                            {showAiConfig ? 'Hide Config' : 'Configure AI'}
                        </Button>
                    </div>

                    {showAiConfig && (
                        <div className="mt-4 pt-4 border-t border-white/5 space-y-4 animate-in slide-in-from-top-2">
                            <div className="space-y-2">
                                <label className="text-[9px] font-black text-muted-foreground uppercase tracking-widest">Google Gemini API Key</label>
                                <div className="relative">
                                    <Input 
                                        type={showKey ? "text" : "password"}
                                        value={apiKey}
                                        onChange={(e) => saveKey(e.target.value)}
                                        placeholder="Paste your key here..."
                                        className="bg-background/80 border-slate-800 font-mono text-xs pr-10 h-10"
                                    />
                                    <button 
                                        onClick={() => setShowKey(!showKey)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                    >
                                        {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                </div>
                                <p className="text-[9px] text-slate-600 italic">
                                    Saved locally in your browser. Get a free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" className="text-primary hover:underline">Google AI Studio</a>.
                                </p>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Header with Stats */}
            <Card className="border-primary/30 bg-gradient-to-r from-primary/10 to-transparent">
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-primary text-xl font-black uppercase tracking-tighter">
                        <Users className="h-6 w-6" />
                        Personnel Dashboard
                    </CardTitle>
                    <CardDescription className="text-[10px] uppercase font-mono">Real-time organizational telemetry and reporting lines</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex gap-8">
                        <div className="text-center">
                            <p className="text-4xl font-black text-foreground tabular-nums">{directCount}</p>
                            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Direct</p>
                        </div>
                        <div className="text-center">
                            <p className="text-4xl font-black text-foreground tabular-nums">{indirectCount}</p>
                            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Extended</p>
                        </div>
                        <div className="text-center border-l border-border pl-8">
                            <p className="text-4xl font-black text-primary tabular-nums">{reports.length}</p>
                            <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Total Force</p>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Tabs: Team Members | Tasks */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
                <TabsList className="bg-card border border-border p-1 h-auto">
                    <TabsTrigger value="team" className="data-[state=active]:bg-primary data-[state=active]:text-black text-[10px] font-black uppercase tracking-widest py-2 px-4">
                        <Users className="h-3 w-3 mr-2" /> Hierarchy
                    </TabsTrigger>
                    <TabsTrigger value="tasks" className="data-[state=active]:bg-primary data-[state=active]:text-black text-[10px] font-black uppercase tracking-widest py-2 px-4">
                        <ClipboardList className="h-3 w-3 mr-2" /> Team Operations
                    </TabsTrigger>
                </TabsList>

                {/* Team Members Tab */}
                <TabsContent value="team" className="space-y-6">
                    <Card className="border-border bg-background/80 backdrop-blur-xl">
                        <CardHeader className="border-b border-white/5">
                            <CardTitle className="text-sm font-black uppercase tracking-[0.2em] flex items-center gap-2">
                                <LayoutGrid className="h-4 w-4 text-primary" />
                                Chain of Command
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 pt-6">
                            {reports.map((member, index) => (
                                <div
                                    key={member.id}
                                    className={`flex items-center gap-4 p-4 rounded-xl border transition-all relative group ${member.isDirectReport
                                        ? 'border-primary/20 bg-primary/5 hover:bg-primary/10'
                                        : 'border-white/5 bg-white/[0.02] hover:bg-muted'
                                        }`}
                                    style={{
                                        marginLeft: `${member.depth * 24}px`,
                                        width: `calc(100% - ${member.depth * 24}px)`
                                    }}
                                >
                                    {member.depth > 0 && (
                                        <div className="absolute -left-[12px] top-1/2 w-[12px] h-0 border-t border-border" />
                                    )}
                                    {member.depth > 0 && (
                                        <div className="absolute -left-[12px] -top-[30px] w-[1px] h-[calc(100%+30px)] bg-muted" />
                                    )}

                                    <Avatar className={`border-2 ${member.isDirectReport ? 'h-12 w-12 border-primary/20' : 'h-10 w-10 border-border shadow-lg'}`}>
                                        <AvatarImage src={member.photoURL || undefined} className="object-cover" />
                                        <AvatarFallback className={`${member.isDirectReport ? 'bg-primary text-black' : 'bg-muted text-muted-foreground'} font-black`}>
                                            {member.displayName?.charAt(0)?.toUpperCase() || '?'}
                                        </AvatarFallback>
                                    </Avatar>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-0.5">
                                            <h4 className={`font-bold truncate text-sm ${member.isDirectReport ? 'text-foreground' : 'text-foreground'}`}>
                                                {member.displayName}
                                            </h4>
                                            {member.isDirectReport ? (
                                                <Badge className="text-[8px] bg-primary/10 text-primary border-primary/20 h-4 font-black uppercase">Direct</Badge>
                                            ) : (
                                                <Badge variant="outline" className="text-[8px] border-slate-800 text-muted-foreground h-4 uppercase">Sub-Level {member.depth}</Badge>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground uppercase tracking-tighter">
                                            <span className="text-primary/70">{getRoleLabel(member.role)}</span>
                                            {member.email && <span className="text-slate-700 hidden sm:inline">• {member.email}</span>}
                                        </div>
                                    </div>

                                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full"
                                            onClick={() => setActiveTab('tasks')}
                                        >
                                            <Briefcase className="h-4 w-4" />
                                        </Button>
                                        <Link href={`/profile/unified?uid=${member.id}`}>
                                            <Button size="sm" variant="ghost" className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full">
                                                <ChevronRight className="h-4 w-4" />
                                            </Button>
                                        </Link>
                                    </div>
                                </div>
                            ))}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Tasks Tab */}
                <TabsContent value="tasks">
                    <TeamTasks />
                </TabsContent>
            </Tabs>
        </div>
    );
}
