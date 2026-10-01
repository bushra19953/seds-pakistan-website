"use client";

import React, { useState } from "react";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Sparkles, Copy, Check, MessageSquare, BrainCircuit, X, Lightbulb, Save } from "lucide-react";
import { useFirestore } from "@/firebase";
import { partnersCollection, updatePartner, STATUS_OPTIONS } from "@/lib/partners";
import { getDocs, query, where, serverTimestamp } from "firebase/firestore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function SponsorMatchPage() {
    const db = useFirestore();
    const { toast } = useToast();
    const [eventName, setEventName] = useState("");
    const [eventNeeds, setEventNeeds] = useState("");
    const [loading, setLoading] = useState(false);
    const [matches, setMatches] = useState<any[]>([]);
    const [pitchLoading, setPitchLoading] = useState<string | null>(null);
    const [generatedPitches, setGeneratedPitches] = useState<Record<string, any>>({});
    const [negotiationOpen, setNegotiationOpen] = useState(false);
    const [activePartner, setActivePartner] = useState<any>(null);
    const [replyText, setReplyText] = useState("");
    const [negotiationAnalysis, setNegotiationAnalysis] = useState<any>(null);
    const [analyzingReply, setAnalyzingReply] = useState(false);
    const [saving, setSaving] = useState(false);
    const [statusFilter, setStatusFilter] = useState<string>("All");

    const [loadingMessage, setLoadingMessage] = useState("");

    const handleMatch = async () => {
        if (!eventName || !eventNeeds) {
            toast({ title: "Missing fields", description: "Please fill in all fields.", variant: "destructive" });
            return;
        }

        setLoading(true);
        setLoadingMessage("Fetching partners...");
        setMatches([]);
        setGeneratedPitches({});

        try {
            // 1. Fetch partners client-side
            const partnersRef = partnersCollection(db);
            let q = query(partnersRef);

            if (statusFilter !== "All") {
                q = query(partnersRef, where("status", "==", statusFilter));
            }

            const snapshot = await getDocs(q);
            const allPartners = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(p => p.agreementIntelligence || p.strategicContext); // Only send useful partners

            if (allPartners.length === 0) {
                toast({ title: "No Partners", description: "No active partners with intelligence found.", variant: "destructive" });
                setLoading(false);
                return;
            }

            // 2. Batch processing
            const BATCH_SIZE = 5;
            const batches = [];
            for (let i = 0; i < allPartners.length; i += BATCH_SIZE) {
                batches.push(allPartners.slice(i, i + BATCH_SIZE));
            }

            let allMatches: any[] = [];
            const apiKey = localStorage.getItem("gemini.apiKey") || "";
            const model = localStorage.getItem("genai.model") || "gemini-1.5-flash";

            for (let i = 0; i < batches.length; i++) {
                setLoadingMessage(`Analyzing batch ${i + 1} of ${batches.length}...`);

                const batchIds = batches[i].map(p => p.id);

                try {
                    const res = await fetch("/api/ai/match-partners", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            eventName,
                            eventNeeds,
                            apiKey,
                            model,
                            partnerIds: batchIds // Send IDs for this batch
                        }),
                    });

                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || "Matching failed");

                    if (data.matches && Array.isArray(data.matches)) {
                        allMatches = [...allMatches, ...data.matches];
                        // Update UI incrementally
                        setMatches(prev => [...prev, ...data.matches]);
                    }
                } catch (batchError) {
                    console.error(`Batch ${i + 1} failed:`, batchError);
                    // Continue to next batch
                }
            }

            // Sort matches by score descending
            const sortedMatches = allMatches.sort((a, b) => (b.score || 0) - (a.score || 0));
            setMatches(sortedMatches);

            if (sortedMatches.length > 0) {
                toast({ title: "Success", description: `Found ${sortedMatches.length} potential partners!` });
            } else {
                toast({ title: "No Matches", description: "No suitable partners found after analyzing all batches.", variant: "destructive" });
            }

        } catch (e: any) {
            console.error("Global match error:", e);
            toast({ title: "Error", description: e.message, variant: "destructive" });
        } finally {
            setLoading(false);
            setLoadingMessage("");
        }
    };

    const handleGeneratePitch = async (match: any) => {
        setPitchLoading(match.id);
        try {
            const apiKey = localStorage.getItem("gemini.apiKey") || "";
            const model = localStorage.getItem("genai.model") || "gemini-1.5-flash";

            const res = await fetch("/api/ai/generate-pitch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    partner: match.partnerData,
                    eventName,
                    eventNeeds,
                    apiKey,
                    model,
                    tone: "Persuasive & Professional"
                }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Pitch generation failed");

            setGeneratedPitches(prev => ({ ...prev, [match.id]: data }));
            toast({
                title: "Pitch Generated!",
                description: `Draft created for ${match.organizationName}`,
            });
        } catch (error: any) {
            toast({
                title: "Error",
                description: error.message,
                variant: "destructive",
            });
        } finally {
            setPitchLoading(null);
        }
    };

    const handleAnalyzeReply = async () => {
        if (!replyText || !activePartner) return;

        setAnalyzingReply(true);
        setNegotiationAnalysis(null);
        try {
            const apiKey = localStorage.getItem("gemini.apiKey") || "";
            const model = localStorage.getItem("genai.model") || "gemini-1.5-flash";

            const res = await fetch("/api/ai/analyze-reply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    replyText,
                    partnerName: activePartner.organizationName,
                    history: activePartner.interactionHistory, // Pass history if available
                    strategicContext: activePartner.strategicContext, // Pass manual context
                    apiKey,
                    model
                }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Analysis failed");

            setNegotiationAnalysis(data);
        } catch (error: any) {
            toast({
                title: "Error",
                description: error.message,
                variant: "destructive",
            });
        } finally {
            setAnalyzingReply(false);
        }
    };

    const savePitchToHistory = async (match: any) => {
        const pitch = generatedPitches[match.id];
        if (!pitch || !match.id) return;

        setSaving(true);
        try {
            const note = `[AI PITCH GENERATED]\nSubject: ${pitch.subject}\n\nStrategy: ${pitch.strategy_note}\n\nBody:\n${pitch.body.replace(/<br\s*\/?>/gi, '\n')}`;

            const history = match.partnerData.interactionHistory || [];
            const newHistory = [
                ...history,
                {
                    note,
                    author: "AI Copilot",
                    timestamp: new Date()
                }
            ];

            await updatePartner(db, match.id, { interactionHistory: newHistory });

            // Update local state to reflect change (optional, but good for UX)
            match.partnerData.interactionHistory = newHistory;

            toast({ title: "Saved", description: "Pitch saved to partner history." });
        } catch (e: any) {
            console.error("Save pitch error:", e);
            toast({ title: "Error", description: `Failed to save pitch: ${e.message}`, variant: "destructive" });
        } finally {
            setSaving(false);
        }
    };

    const saveNegotiationToHistory = async () => {
        if (!activePartner || !negotiationAnalysis || !replyText) return;

        setSaving(true);
        try {
            const note = `[NEGOTIATION COPILOT]\nTheir Reply: "${replyText}"\n\nDiagnosis: ${negotiationAnalysis.diagnosis}\nStrategy: ${negotiationAnalysis.strategy_applied}\n\nSuggested Response:\n${negotiationAnalysis.suggested_response}`;

            const history = activePartner.interactionHistory || [];
            const newHistory = [
                ...history,
                {
                    note,
                    author: "AI Copilot",
                    timestamp: new Date()
                }
            ];

            await updatePartner(db, activePartner.id, { interactionHistory: newHistory });

            // Update local state
            setActivePartner({ ...activePartner, interactionHistory: newHistory });

            toast({ title: "Logged", description: "Negotiation analysis logged to history." });
        } catch (e: any) {
            console.error("Log negotiation error:", e);
            toast({ title: "Error", description: `Failed to log negotiation: ${e.message}`, variant: "destructive" });
        } finally {
            setSaving(false);
        }
    };

    const openNegotiation = (match: any) => {
        setActivePartner(match);
        setReplyText("");
        setNegotiationAnalysis(null);
        setNegotiationOpen(true);
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        toast({ title: "Copied", description: "Pitch copied to clipboard." });
    };

    return (
        <AuthorizationGate permission="canManageSponsorsPartners">
            <div className="space-y-6 max-w-5xl mx-auto p-6">
                <div>
                    <h1 className="text-4xl font-bold text-glow mb-2 flex items-center gap-2">
                        <Sparkles className="text-yellow-400" /> AI Sponsor Match
                    </h1>
                    <p className="text-muted-foreground">
                        Find the perfect partners for your event based on existing agreements.
                    </p>
                </div>

                <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
                    <CardHeader>
                        <CardTitle>Event Details</CardTitle>
                        <CardDescription>Describe your event to find matching partners.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div>
                            <Label>Event Name</Label>
                            <Input
                                value={eventName}
                                onChange={(e) => setEventName(e.target.value)}
                                placeholder="e.g., National Rocketry Championship"
                            />
                        </div>
                        <div>
                            <Label>Filter by Status</Label>
                            <Select value={statusFilter} onValueChange={setStatusFilter}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select status" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="All">All Statuses</SelectItem>
                                    {STATUS_OPTIONS.map((status) => (
                                        <SelectItem key={status} value={status}>
                                            {status}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label>Event Needs & Goals</Label>
                            <Textarea
                                value={eventNeeds}
                                onChange={(e) => setEventNeeds(e.target.value)}
                                placeholder="e.g., We need media coverage, 3 technical judges, and $5k in prize money."
                                className="h-32"
                            />
                        </div>
                        <Button onClick={handleMatch} disabled={loading} className="w-full md:w-auto">
                            {loading ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {loadingMessage || "Analyzing Agreements..."}
                                </>
                            ) : (
                                <>
                                    <Sparkles className="mr-2 h-4 w-4" /> Find Partners
                                </>
                            )}
                        </Button>
                    </CardContent>
                </Card>

                {matches.length > 0 && (
                    <div className="grid grid-cols-1 gap-6">
                        <h2 className="text-2xl font-bold">Top Matches</h2>
                        {matches.map((match, idx) => (
                            <Card key={idx} className="border-l-4 border-l-primary">
                                <CardHeader>
                                    <CardTitle className="flex justify-between items-center">
                                        {match.organizationName}
                                        <div className="flex gap-2">
                                            <span className="text-sm font-normal text-muted-foreground bg-secondary px-2 py-1 rounded">
                                                Match Score: {match.score}/10
                                            </span>
                                            <Button size="sm" variant="outline" onClick={() => openNegotiation(match)}>
                                                <MessageSquare className="h-4 w-4 mr-2" />
                                                Negotiate
                                            </Button>
                                        </div>
                                    </CardTitle>
                                    <CardDescription>{match.reason}</CardDescription>
                                    {match.key_factors && (
                                        <ul className="list-disc list-inside text-sm text-muted-foreground mt-2">
                                            {match.key_factors.map((factor: string, i: number) => (
                                                <li key={i}>{factor}</li>
                                            ))}
                                        </ul>
                                    )}
                                </CardHeader>
                                <CardContent>
                                    {generatedPitches[match.id] ? (
                                        <div className="space-y-4 animate-in fade-in">
                                            <div className="bg-muted/50 p-4 rounded-lg border border-primary/10">
                                                <div className="flex justify-between items-center mb-2">
                                                    <span className="text-xs font-bold uppercase text-primary">Psychological Strategy</span>
                                                    <span className="text-xs text-muted-foreground italic whitespace-pre-wrap">{generatedPitches[match.id].strategy_note}</span>
                                                </div>
                                                <div className="space-y-2">
                                                    <Label>Subject Line</Label>
                                                    <div className="flex gap-2">
                                                        <Input readOnly value={generatedPitches[match.id].subject} className="font-mono text-sm" />
                                                        <Button size="icon" variant="ghost" onClick={() => copyToClipboard(generatedPitches[match.id].subject)}>
                                                            <Copy className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                </div>
                                                <div className="space-y-2 mt-4">
                                                    <Label>Email Body</Label>
                                                    <div className="relative">
                                                        <div
                                                            className="h-64 overflow-y-auto p-3 rounded-md border bg-background font-mono text-sm whitespace-pre-wrap"
                                                            dangerouslySetInnerHTML={{ __html: generatedPitches[match.id].body }}
                                                        />
                                                        <div className="absolute top-2 right-2 flex gap-2">
                                                            <Button
                                                                size="icon"
                                                                variant="ghost"
                                                                onClick={() => copyToClipboard(generatedPitches[match.id].body.replace(/<br\s*\/?>/gi, '\n'))}
                                                                title="Copy to Clipboard"
                                                            >
                                                                <Copy className="h-4 w-4" />
                                                            </Button>
                                                            <Button
                                                                size="icon"
                                                                variant="ghost"
                                                                onClick={() => savePitchToHistory(match)}
                                                                disabled={saving}
                                                                title="Save to Partner History"
                                                            >
                                                                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <Button
                                            onClick={() => handleGeneratePitch(match)}
                                            disabled={pitchLoading === match.id}
                                            className="w-full"
                                            variant="secondary"
                                        >
                                            {pitchLoading === match.id ? (
                                                <>
                                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Crafting Pitch...
                                                </>
                                            ) : (
                                                <>
                                                    <Sparkles className="mr-2 h-4 w-4" /> Generate Psychological Pitch
                                                </>
                                            )}
                                        </Button>
                                    )}
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}

                {/* Negotiation Dialog */}
                {negotiationOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                        <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-background border-primary/20 shadow-2xl">
                            <CardHeader className="sticky top-0 bg-background z-10 border-b">
                                <div className="flex justify-between items-center">
                                    <CardTitle className="flex items-center gap-2">
                                        <BrainCircuit className="h-5 w-5 text-purple-500" />
                                        Negotiation Copilot: {activePartner?.organizationName}
                                    </CardTitle>
                                    <Button variant="ghost" size="icon" onClick={() => setNegotiationOpen(false)}>
                                        <X className="h-4 w-4" />
                                    </Button>
                                </div>
                                <CardDescription>
                                    Paste their email/reply below. The AI will diagnose the barrier and craft a strategic counter-move.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4 p-6">
                                <div className="space-y-2">
                                    <Label>Their Reply</Label>
                                    <Textarea
                                        placeholder="Paste the email or message you received..."
                                        value={replyText}
                                        onChange={(e) => setReplyText(e.target.value)}
                                        className="h-32"
                                    />
                                </div>

                                <Button
                                    onClick={handleAnalyzeReply}
                                    disabled={analyzingReply || !replyText}
                                    className="w-full"
                                >
                                    {analyzingReply ? (
                                        <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Diagnosing Barrier...
                                        </>
                                    ) : (
                                        <>
                                            <Sparkles className="mr-2 h-4 w-4" /> Analyze & Generate Counter-Move
                                        </>
                                    )}
                                </Button>

                                {negotiationAnalysis && (
                                    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                                                <h4 className="font-bold text-red-500 text-sm uppercase mb-1">Diagnosis</h4>
                                                <p className="text-sm">{negotiationAnalysis.diagnosis}</p>
                                            </div>
                                            <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                                                <h4 className="font-bold text-green-500 text-sm uppercase mb-1">Strategy Applied</h4>
                                                <p className="text-sm">{negotiationAnalysis.strategy_applied}</p>
                                            </div>
                                        </div>

                                        <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                                            <h4 className="font-bold text-blue-500 text-sm uppercase mb-1 flex items-center gap-2">
                                                <Lightbulb className="h-4 w-4" /> Coaching Tip
                                            </h4>
                                            <p className="text-sm italic">{negotiationAnalysis.coaching_tip}</p>
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex justify-between items-center">
                                                <Label>Suggested Response</Label>
                                                <div className="flex gap-2">
                                                    <Button size="sm" variant="ghost" onClick={() => copyToClipboard(negotiationAnalysis.suggested_response)}>
                                                        <Copy className="h-4 w-4 mr-2" /> Copy
                                                    </Button>
                                                    <Button size="sm" variant="outline" onClick={saveNegotiationToHistory} disabled={saving}>
                                                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                                                        Log to History
                                                    </Button>
                                                </div>
                                            </div>
                                            <div
                                                className="p-4 rounded-md border bg-muted/30 font-mono text-sm whitespace-pre-wrap"
                                                dangerouslySetInnerHTML={{ __html: negotiationAnalysis.suggested_response.replace(/\n/g, '<br/>') }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                )}
            </div>
        </AuthorizationGate>
    );
}
