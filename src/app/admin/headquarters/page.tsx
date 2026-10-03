"use client";

import React, { useState, useMemo, useEffect } from "react";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { useFirestore, useUser } from "@/firebase";
import { PrinciplesRepository, Principle } from "@/lib/principles";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, Edit2, Shield, Brain, Zap, Clipboard, BookOpen, AlertTriangle, CheckCircle2, MessageSquare } from "lucide-react";

export default function HeadquartersPage() {
    const db = useFirestore();
    const { user } = useUser();
    const { toast } = useToast();
    const repo = useMemo(() => new PrinciplesRepository(db), [db]);

    // Data State
    const [principles, setPrinciples] = useState<Principle[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    // Filter State
    const [categoryFilter, setCategoryFilter] = useState("ALL");

    // Load Principles
    useEffect(() => {
        if (!user) return;
        const load = async () => {
            setLoading(true);
            try {
                const data = await repo.getAll(user.uid);
                setPrinciples(data);
                // Auto-seed if empty for new users
                if (data.length === 0) {
                    // Optional: await repo.seedDefaults(user.uid); 
                    // setRefreshTrigger(p => p + 1);
                }
            } catch (e) {
                console.error(e);
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [user, repo, refreshTrigger]);

    // Derived
    const activePrinciples = useMemo(() => principles.filter(p => p.active), [principles]);
    const filteredPrinciples = useMemo(() => {
        if (categoryFilter === "ALL") return principles;
        return principles.filter(p => p.category.toLowerCase() === categoryFilter.toLowerCase());
    }, [principles, categoryFilter]);

    // Advisor State
    const [conversation, setConversation] = useState("");
    const [context, setContext] = useState("");
    const [analyzing, setAnalyzing] = useState(false);
    const [advisorResult, setAdvisorResult] = useState<any>(null);

    // Actions
    const handleToggleActive = async (id: string, current: boolean) => {
        if (!user) return;
        setPrinciples(prev => prev.map(p => p.id === id ? { ...p, active: !current } : p)); // Optimistic UI
        await repo.update(user.uid, id, { active: !current });
    };

    const handleDelete = async (id: string) => {
        if (!user) return;
        if (!confirm("Delete this principle permanently?")) return;
        await repo.delete(user.uid, id);
        setRefreshTrigger(p => p + 1);
        toast({ title: "Deleted", description: "Principle removed from vault." });
    };

    const handleSeed = async () => {
        if (!user) return;
        setLoading(true);
        await repo.seedDefaults(user.uid);
        setRefreshTrigger(p => p + 1);
        toast({ title: "Seeded", description: "Default principles loaded." });
    };

    const handleAnalyze = async () => {
        if (!conversation.trim()) {
            toast({ title: "Empty Input", description: "Paste a conversation or situation first.", variant: "destructive" });
            return;
        }

        setAnalyzing(true);
        setAdvisorResult(null);

        try {
            const res = await fetch('/api/ai/headquarters-advisor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conversationText: conversation,
                    situationContext: context,
                    principles: activePrinciples,
                    apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY // Optional if using server env
                })
            });

            if (!res.ok) throw new Error("Analysis failed");
            const data = await res.json();
            setAdvisorResult(data);

        } catch (e) {
            console.error(e);
            toast({ title: "Error", description: "The Advisor is offline.", variant: "destructive" });
        } finally {
            setAnalyzing(false);
        }
    };

    return (
        <AuthorizationGate permission="canManageSponsorsPartners">
            <div className="h-[calc(100vh-4rem)] flex flex-col md:flex-row overflow-hidden bg-zinc-950 text-zinc-100">

                {/* LEFT PANEL: PRINCIPLES VAULT */}
                <div className="w-full md:w-1/3 min-w-[350px] border-r border-border flex flex-col bg-background/80 backdrop-blur-sm">
                    <div className="p-4 border-b border-border flex justify-between items-center bg-zinc-900/50">
                        <div>
                            <h2 className="text-lg font-bold flex items-center gap-2 text-amber-500">
                                <Shield className="h-5 w-5" /> PRINCIPLES VAULT
                            </h2>
                            <p className="text-xs text-muted-foreground">{activePrinciples.length} Active Laws</p>
                        </div>
                        <AddPrincipleDialog userId={user?.uid} onAdded={() => setRefreshTrigger(p => p + 1)} />
                    </div>

                    <div className="p-2 border-b border-white/5">
                        <div className="flex gap-2">
                            <Button
                                variant={categoryFilter === 'ALL' ? 'secondary' : 'ghost'}
                                size="sm" onClick={() => setCategoryFilter('ALL')}
                                className="text-xs h-7"
                            >All</Button>
                            <Button
                                variant={categoryFilter === 'Power' ? 'secondary' : 'ghost'}
                                size="sm" onClick={() => setCategoryFilter('Power')}
                                className="text-xs h-7"
                            >Power</Button>
                            <Button
                                variant={categoryFilter === 'Psychology' ? 'secondary' : 'ghost'}
                                size="sm" onClick={() => setCategoryFilter('Psychology')}
                                className="text-xs h-7"
                            >Psych</Button>
                        </div>
                    </div>

                    <ScrollArea className="flex-1 p-4 space-y-4">
                        {loading && <div className="text-center py-10"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></div>}

                        {!loading && principles.length === 0 && (
                            <div className="text-center py-10 space-y-4">
                                <p className="text-sm text-muted-foreground">The Vault is empty.</p>
                                <Button onClick={handleSeed} variant="outline" className="border-amber-500/20 text-amber-500">
                                    Import Default Laws
                                </Button>
                            </div>
                        )}

                        {filteredPrinciples.map(p => (
                            <Card key={p.id} className={`border-white/5 bg-zinc-900/40 relative group transition-all ${p.active ? 'border-l-2 border-l-amber-500' : 'opacity-60'}`}>
                                <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 hover:bg-muted hover:text-red-400" onClick={() => handleDelete(p.id!)}>
                                        <Trash2 className="h-3 w-3" />
                                    </Button>
                                </div>
                                <CardHeader className="p-3 pb-2">
                                    <div className="flex justify-between items-start pr-6">
                                        <CardTitle className="text-sm font-bold text-zinc-100 leading-tight">{p.title}</CardTitle>
                                        <Switch
                                            checked={p.active}
                                            onCheckedChange={(checked) => handleToggleActive(p.id!, checked)}
                                            className="scale-75"
                                        />
                                    </div>
                                    <CardDescription className="text-[10px] text-amber-500/80 font-mono uppercase tracking-wider">
                                        {p.category} • {p.source}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="p-3 pt-0">
                                    <p className="text-xs text-zinc-400 line-clamp-3 leading-relaxed">
                                        {p.content}
                                    </p>
                                </CardContent>
                            </Card>
                        ))}
                    </ScrollArea>
                </div>

                {/* RIGHT PANEL: ADVISOR */}
                <div className="flex-1 flex flex-col bg-zinc-950 relative">
                    {/* Background Ambient Effect */}
                    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-900/20 via-transparent to-transparent pointer-events-none" />

                    <div className="p-6 border-b border-border bg-zinc-900/30 flex justify-between items-center backdrop-blur-md z-10">
                        <div>
                            <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 flex items-center gap-2">
                                <Brain className="h-6 w-6 text-indigo-400" />
                                HEADQUARTERS ADVISOR
                            </h1>
                            <p className="text-sm text-muted-foreground">Strategic Analysis Engine powered by your Principles.</p>
                        </div>
                        {analyzing && <Badge variant="secondary" className="animate-pulse bg-indigo-500/20 text-indigo-300">ANALYZING...</Badge>}
                    </div>

                    <div className="flex-1 flex flex-col md:flex-row overflow-hidden z-10">

                        {/* INPUT AREA */}
                        <div className="w-full md:w-1/2 p-6 flex flex-col gap-4 border-r border-white/5 overflow-y-auto">
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Context / Situation</label>
                                <Textarea
                                    className="bg-black/30 border-border min-h-[100px] text-sm focus:border-indigo-500/50"
                                    placeholder="Who is this with? What is the history? (Optional)"
                                    value={context}
                                    onChange={e => setContext(e.target.value)}
                                />
                            </div>

                            <div className="space-y-2 flex-1 flex flex-col">
                                <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Conversation / Email</label>
                                <Textarea
                                    className="flex-1 bg-black/30 border-border text-sm font-mono leading-relaxed focus:border-indigo-500/50 resize-none p-4"
                                    placeholder="Paste the email, message, or transcript here..."
                                    value={conversation}
                                    onChange={e => setConversation(e.target.value)}
                                />
                            </div>

                            <Button onClick={handleAnalyze} disabled={analyzing} className="w-full bg-indigo-600 hover:bg-indigo-500 text-foreground shadow-lg shadow-indigo-900/20 h-12 text-base font-bold tracking-wide">
                                {analyzing ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Zap className="mr-2 h-5 w-5 fill-yellow-400 text-yellow-100" />}
                                GENERATE STRATEGY
                            </Button>
                        </div>

                        {/* OUTPUT AREA */}
                        <ScrollArea className="w-full md:w-1/2 bg-indigo-950/10">
                            {advisorResult ? (
                                <div className="p-6 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">

                                    {/* ANALYSIS */}
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-bold text-indigo-300 flex items-center gap-2">
                                            <BookOpen className="h-4 w-4" /> ANALYSIS & DYNAMICS
                                        </h3>
                                        <div className="p-4 rounded-xl bg-background/80 border border-indigo-500/20 text-sm leading-relaxed text-zinc-300 shadow-inner">
                                            {advisorResult.analysis}
                                        </div>
                                    </div>

                                    {/* DRAFT REPLY */}
                                    <div className="space-y-3">
                                        <div className="flex justify-between items-center">
                                            <h3 className="text-sm font-bold text-indigo-300 flex items-center gap-2">
                                                <MessageSquare className="h-4 w-4" /> SUGGESTED REPLY
                                            </h3>
                                            <Button size="sm" variant="outline" className="h-6 text-xs border-border hover:bg-muted" onClick={() => navigator.clipboard.writeText(advisorResult.suggested_reply)}>
                                                <Clipboard className="mr-1 h-3 w-3" /> Copy
                                            </Button>
                                        </div>
                                        <div className="p-5 rounded-xl bg-gradient-to-br from-zinc-900 to-black border border-border text-sm font-mono text-zinc-300 whitespace-pre-wrap relative group">
                                            {advisorResult.suggested_reply}
                                            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                {/* Actions like Edit could go here */}
                                            </div>
                                        </div>
                                        <p className="text-xs text-zinc-500 italic pl-2 border-l-2 border-zinc-700">
                                            Rationale: {advisorResult.reply_rationale}
                                        </p>
                                    </div>

                                    {/* NEXT ACTIONS */}
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-bold text-indigo-300 flex items-center gap-2">
                                            <CheckCircle2 className="h-4 w-4" /> EXECUTION PLAN
                                        </h3>
                                        <div className="space-y-2">
                                            {advisorResult.next_actions?.map((action: any, i: number) => (
                                                <div key={i} className="flex gap-3 p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/10 items-start">
                                                    <div className="h-5 w-5 rounded-full bg-indigo-500/20 flex items-center justify-center text-xs font-bold text-indigo-400 mt-0.5">
                                                        {i + 1}
                                                    </div>
                                                    <div>
                                                        <div className="text-sm font-medium text-zinc-200">{action.text}</div>
                                                        <div className="text-xs text-indigo-300/60 mt-1">{action.rationale}</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* RISKS */}
                                    {advisorResult.risk_assessment && (
                                        <div className="p-4 rounded-lg bg-red-900/10 border border-red-500/20 flex gap-3 text-red-200/80 text-xs">
                                            <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
                                            <div>
                                                <strong className="text-red-400 block mb-1">Risk Assessment</strong>
                                                {advisorResult.risk_assessment}
                                            </div>
                                        </div>
                                    )}

                                </div>
                            ) : (
                                <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-10 opacity-50">
                                    <Brain className="h-16 w-16 mb-4 stroke-1" />
                                    <p className="text-sm text-center max-w-[250px]">
                                        Paste a conversation on the left to activate the Strategic Engine.
                                    </p>
                                </div>
                            )}
                        </ScrollArea>
                    </div>
                </div>
            </div>
        </AuthorizationGate>
    );
}

function AddPrincipleDialog({ userId, onAdded }: { userId?: string, onAdded: () => void }) {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState<Partial<Principle>>({
        title: '',
        source: '',
        category: 'Power',
        content: '',
        active: true
    });
    const db = useFirestore();
    const repo = useMemo(() => new PrinciplesRepository(db), [db]);

    const handleSubmit = async () => {
        if (!userId || !form.title || !form.content) return;
        await repo.create(userId, form as Principle);
        setOpen(false);
        setForm({ title: '', source: '', category: 'Power', content: '', active: true });
        onAdded();
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button size="sm" className="h-7 w-7 rounded-full p-0 bg-amber-600 hover:bg-amber-500"><Plus className="h-4 w-4" /></Button>
            </DialogTrigger>
            <DialogContent className="bg-zinc-950 border-border text-foreground">
                <DialogHeader>
                    <DialogTitle>Add New Law</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                    <div>
                        <Input
                            placeholder="Title (e.g. Law 15)"
                            className="bg-background/80 border-border"
                            value={form.title}
                            onChange={e => setForm({ ...form, title: e.target.value })}
                        />
                    </div>
                    <div className="flex gap-2">
                        <Input
                            placeholder="Source (e.g. 48 Laws)"
                            className="bg-background/80 border-border"
                            value={form.source}
                            onChange={e => setForm({ ...form, source: e.target.value })}
                        />
                        <Select
                            value={form.category}
                            onValueChange={(v: any) => setForm({ ...form, category: v })}
                        >
                            <SelectTrigger className="w-[140px] bg-background/80 border-border">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="Power">Power</SelectItem>
                                <SelectItem value="Psychology">Psychology</SelectItem>
                                <SelectItem value="Business">Business</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div>
                        <Textarea
                            placeholder="The content of the law..."
                            className="bg-background/80 border-border min-h-[150px]"
                            value={form.content}
                            onChange={e => setForm({ ...form, content: e.target.value })}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button onClick={handleSubmit} className="bg-amber-600 hover:bg-amber-500">Add to Vault</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
