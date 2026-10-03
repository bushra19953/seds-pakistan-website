'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useFirestore, useCollection, useUser } from '@/firebase';
import { ContactsRepository } from '@/lib/contacts-repository';
import { PartnerRecord, STATUS_OPTIONS, Interaction, InteractionType, Direction } from '@/lib/partners';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardTitle, CardHeader, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter, SheetTrigger } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
    Search, Filter, Phone, Mail, Calendar, Plus, MessageSquare,
    ChevronDown, ChevronRight, User, Send, Inbox, Paperclip,
    MoreVertical, Star, Activity, Clock, Trash2, X, AlertTriangle, Maximize2,
    Users, BrainCircuit, Lightbulb, Copy, Save, Loader2, Sparkles
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';
import { Progress } from '@/components/ui/progress';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// --- Utility Functions ---

function safeDate(input: any): Date | null {
    if (!input) return null;
    if (input.toDate && typeof input.toDate === 'function') {
        return input.toDate();
    }
    const d = new Date(input);
    if (isNaN(d.getTime())) {
        return new Date();
    }
    return d;
}

// --- Utility Components ---

const PipelineStatusBar = ({ stats }: { stats: Record<string, number> }) => (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-6">
        {STATUS_OPTIONS.map(status => (
            <Card key={status} className="bg-card/50 border-primary/10">
                <CardContent className="p-3 flex flex-col items-center justify-center">
                    <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider">{status}</span>
                    <span className="text-2xl font-bold text-glow">{stats[status] || 0}</span>
                </CardContent>
            </Card>
        ))}
    </div>
);

const EditableText = ({ value, onSave, className, placeholder = "Empty" }: { value: string, onSave: (val: string) => void, className?: string, placeholder?: string }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [temp, setTemp] = useState(value);

    const handleBlur = () => {
        setIsEditing(false);
        if (temp !== value) onSave(temp);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleBlur();
        if (e.key === 'Escape') {
            setTemp(value);
            setIsEditing(false);
        }
    };

    if (isEditing) {
        return (
            <Input
                autoFocus
                value={temp}
                onChange={(e) => setTemp(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                className={cn("h-8 bg-background", className)}
            />
        );
    }

    return (
        <div
            onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
            className={cn("cursor-pointer hover:bg-muted px-2 py-1 rounded border border-transparent hover:border-border truncate min-h-[1.5rem] transition-colors", className)}
        >
            {value || <span className="text-muted-foreground opacity-50 italic">{placeholder}</span>}
        </div>
    );
};

const StatusSelector = ({ current, onSelect }: { current: string, onSelect: (val: string) => void }) => (
    <Select value={current} onValueChange={onSelect}>
        <SelectTrigger className="h-8 w-[140px] border-none bg-transparent hover:bg-muted p-0 px-2" onClick={e => e.stopPropagation()}>
            <Badge variant={current === 'Active' || current === 'Closed' ? 'default' : 'secondary'} className="rounded-sm pointer-events-none">
                {current}
            </Badge>
        </SelectTrigger>
        <SelectContent>
            {STATUS_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
        </SelectContent>
    </Select>
);

// --- Deep Relationship Components ---

const RelationshipTimeline = ({
    timeline,
    className,
    onDelete
}: {
    timeline: Interaction[],
    className?: string,
    onDelete: (id: string) => void
}) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const prevLenRef = useRef(0);
    const [filter, setFilter] = useState<string>('all');

    useEffect(() => {
        if (scrollRef.current) {
            if (timeline.length > prevLenRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
            prevLenRef.current = timeline.length;
        }
    }, [timeline.length]);

    const filteredTimeline = useMemo(() => {
        if (filter === 'all') return timeline;
        return timeline.filter(t => t.type === filter);
    }, [timeline, filter]);

    if (!timeline || timeline.length === 0) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50">
                <Inbox className="h-12 w-12 mb-2" />
                <p>No interaction history yet.</p>
                <p className="text-xs">Start the conversation below.</p>
            </div>
        );
    }

    return (
        <div className={cn("flex flex-col h-full", className)}>
            {/* Filter Bar */}
            <div className="flex gap-2 p-2 px-4 border-b border-white/5 overflow-x-auto">
                {['all', 'email', 'call', 'meeting', 'note'].map(f => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={cn(
                            "text-[10px] uppercase font-bold px-2 py-1 rounded-full transition-colors",
                            filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted"
                        )}
                    >
                        {f}
                    </button>
                ))}
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 scroll-smooth">
                {filteredTimeline.map((item, idx) => {
                    const isSent = item.direction === 'sent';
                    const date = safeDate(item.timestamp);
                    return (
                        <div key={item.id || idx} className={cn("flex w-full animate-in fade-in slide-in-from-bottom-2 duration-300", isSent ? "justify-end" : "justify-start")}>
                            <div className={cn(
                                "max-w-[85%] md:max-w-[75%] rounded-2xl p-4 shadow-md relative group text-sm leading-relaxed border transition-all min-w-0 overflow-hidden",
                                isSent
                                    ? "bg-blue-600/90 text-foreground border-blue-500/50 rounded-br-sm"
                                    : "bg-zinc-800/90 text-zinc-100 border-border rounded-bl-sm"
                            )}>
                                <div className="flex items-center gap-2 mb-2 opacity-70 border-b border-black/10 pb-1.5 text-xs">
                                    {item.type === 'call' && <Phone className="h-3 w-3" />}
                                    {item.type === 'email' && <Mail className="h-3 w-3" />}
                                    {item.type === 'meeting' && <User className="h-3 w-3" />}
                                    {item.type === 'note' && <MessageSquare className="h-3 w-3" />}
                                    <span className="uppercase font-bold tracking-wider opacity-90">{item.type}</span>
                                    <span className="ml-auto opacity-80">
                                        {date ? formatDistanceToNow(date, { addSuffix: true }) : ''}
                                    </span>

                                    <AlertDialog>
                                        <AlertDialogTrigger asChild>
                                            <button className="ml-2 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400">
                                                <Trash2 className="h-3 w-3" />
                                            </button>
                                        </AlertDialogTrigger>
                                        <AlertDialogContent>
                                            <AlertDialogHeader>
                                                <AlertDialogTitle>Delete Log?</AlertDialogTitle>
                                                <AlertDialogDescription>
                                                    This cannot be easily undone.
                                                </AlertDialogDescription>
                                            </AlertDialogHeader>
                                            <AlertDialogFooter>
                                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                <AlertDialogAction onClick={() => onDelete(item.id)} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
                                            </AlertDialogFooter>
                                        </AlertDialogContent>
                                    </AlertDialog>
                                </div>
                                <div className="whitespace-pre-wrap break-words overflow-wrap-anywhere">{item.content}</div>
                                {item.author && !isSent && (
                                    <div className="text-[10px] mt-2 opacity-40 text-right italic">- {item.author}</div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

const LogComposer = ({ onSend }: { onSend: (data: any) => void }) => {
    const [content, setContent] = useState('');
    const [type, setType] = useState<InteractionType>('note');
    const [direction, setDirection] = useState<Direction>('sent');

    const handleSend = () => {
        if (!content.trim()) return;
        onSend({ content, type, direction });
        setContent('');
        if (type === 'call' || type === 'email') setDirection('sent');
    };

    return (
        <div className="border-t border-border bg-zinc-900/50 backdrop-blur-md p-4 space-y-3">
            <div className="flex items-center justify-between overflow-x-auto gap-2 pb-2 md:pb-0">
                <div className="flex bg-black/20 p-1 rounded-lg border border-white/5 flex-none">
                    {(['note', 'call', 'email', 'meeting'] as const).map(t => (
                        <Button
                            key={t}
                            variant={type === t ? 'secondary' : 'ghost'}
                            size="sm"
                            onClick={() => setType(t)}
                            className="h-7 text-xs px-3 rounded-md capitalize"
                        >
                            {t}
                        </Button>
                    ))}
                </div>

                <div className="flex bg-black/20 p-1 rounded-lg border border-white/5 flex-none">
                    <Button
                        variant={direction === 'sent' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setDirection('sent')}
                        className={cn("h-7 text-xs px-3 rounded-md", direction === 'sent' && "bg-blue-600 hover:bg-blue-500")}
                    >
                        Sent
                    </Button>
                    <Button
                        variant={direction === 'received' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setDirection('received')}
                        className={cn("h-7 text-xs px-3 rounded-md", direction === 'received' && "bg-zinc-600 hover:bg-zinc-500")}
                    >
                        Received
                    </Button>
                </div>
            </div>

            <div className="relative group">
                <Textarea
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder={`Log details about this ${type}...`}
                    className="min-h-[80px] w-full bg-background/80 border-border focus:border-blue-500/50 resize-none pr-12 text-sm rounded-xl py-3 shadow-inner"
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                />
                <Button
                    className="absolute right-2 bottom-2 h-8 w-8 rounded-lg shadow-lg"
                    size="icon"
                    onClick={handleSend}
                    disabled={!content.trim()}
                >
                    <Send className="h-4 w-4" />
                </Button>
            </div>
        </div>
    );
};

const RelationshipScore = ({ contact }: { contact: PartnerRecord }) => {
    const score = contact.relationshipScore || 5;
    const lastContact = safeDate(contact.lastContactAt);
    const daysSince = lastContact ? Math.floor((new Date().getTime() - lastContact.getTime()) / (1000 * 3600 * 24)) : 999;

    let healthColor = "bg-green-500";
    if (daysSince > 14) healthColor = "bg-yellow-500";
    if (daysSince > 30) healthColor = "bg-red-500";

    return (
        <Card className="bg-card/40 border-primary/5">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    RELATIONSHIP HEALTH
                    <div className={cn("h-2 w-2 rounded-full", healthColor)} />
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div>
                    <div className="flex justify-between text-2xl font-bold mb-1">
                        {score}/10
                        <Activity className="h-6 w-6 text-muted-foreground opacity-20" />
                    </div>
                    <Progress value={score * 10} className="h-2" />
                </div>

                <div className="text-sm space-y-2 pt-2 border-t border-white/5">
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">Last Contact</span>
                        <span className={cn(daysSince > 14 ? "text-red-400" : "text-foreground")}>
                            {daysSince === 999 ? 'Never' : `${daysSince}d ago`}
                        </span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">Streak</span>
                        <span className="text-primary font-mono">3🔥</span>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
};

// --- Full Screen Deep Dive Sheet ---

// --- Create Contact Dialog ---

const CreateContactDialog = ({ repo, open, onOpenChange }: { repo: ContactsRepository, open: boolean, onOpenChange: (v: boolean) => void }) => {
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        organizationName: '',
        status: 'Prospect',
        contactName: '',
        contactEmail: '',
        contactPhone: ''
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            await repo.createContact({
                organizationName: formData.organizationName,
                status: formData.status as any,
                relationshipType: 'Sponsor', // Default
                primaryContact: {
                    name: formData.contactName,
                    email: formData.contactEmail,
                    phone: formData.contactPhone
                },
                financials: { pledgedAmount: 0 },
                interactionHistory: [],
                timeline: []
            });
            onOpenChange(false);
            setFormData({ organizationName: '', status: 'Prospect', contactName: '', contactEmail: '', contactPhone: '' });
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[425px] bg-zinc-950 border-border">
                <DialogHeader>
                    <DialogTitle>Add New Contact</DialogTitle>
                    <DialogDescription>
                        Create a new relationship record.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label>Organization Name</Label>
                        <Input
                            required
                            placeholder="e.g. Acme Corp"
                            className="bg-black/20"
                            value={formData.organizationName}
                            onChange={e => setFormData({ ...formData, organizationName: e.target.value })}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label>Stage</Label>
                        <Select
                            value={formData.status}
                            onValueChange={v => setFormData({ ...formData, status: v })}
                        >
                            <SelectTrigger className="bg-black/20">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {STATUS_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label>Primary Contact Name</Label>
                        <Input
                            placeholder="Data Access"
                            className="bg-black/20"
                            value={formData.contactName}
                            onChange={e => setFormData({ ...formData, contactName: e.target.value })}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label>Email</Label>
                            <Input
                                placeholder="name@org.com"
                                className="bg-black/20"
                                value={formData.contactEmail}
                                onChange={e => setFormData({ ...formData, contactEmail: e.target.value })}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Phone</Label>
                            <Input
                                placeholder="+1..."
                                className="bg-black/20"
                                value={formData.contactPhone}
                                onChange={e => setFormData({ ...formData, contactPhone: e.target.value })}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="submit" disabled={loading}>
                            {loading ? 'Creating...' : 'Create Contact'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

// --- Phase 3 Components ---

// Simple ID generator to avoid strict crypto requirement in some environments
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

const NextActionsList = ({ contact, repo }: { contact: PartnerRecord, repo: ContactsRepository }) => {
    const [newAction, setNewAction] = useState('');
    const [date, setDate] = useState('');

    const actions = contact.nextActions || [];

    const handleAdd = async () => {
        if (!newAction.trim()) return;
        const fresh = [
            ...actions,
            {
                id: generateId(),
                text: newAction,
                dueDate: date || undefined,
                isCompleted: false
            }
        ];
        await repo.updateField(contact.id!, 'nextActions', fresh);

        // Also update legacy field for table view compatibility if it's the first one or earliest
        if (date) {
            const current = contact.nextActionDate ? new Date(contact.nextActionDate).getTime() : Infinity;
            if (new Date(date).getTime() < current) {
                await repo.updateField(contact.id!, 'nextActionDate', new Date(date));
            }
        }

        setNewAction('');
        setDate('');
    };

    const toggle = async (actionId: string, currentStatus: boolean) => {
        const updated = actions.map(a => a.id === actionId ? { ...a, isCompleted: !currentStatus, completedAt: !currentStatus ? new Date().toISOString() : undefined } : a);
        await repo.updateField(contact.id!, 'nextActions', updated);
    };

    const remove = async (actionId: string) => {
        const updated = actions.filter(a => a.id !== actionId);
        await repo.updateField(contact.id!, 'nextActions', updated);
    };

    return (
        <Card className="bg-transparent border-border">
            <CardHeader className="p-4 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Clock className="h-4 w-4" /> NEXT ACTIONS
                </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 space-y-3">
                <div className="flex gap-2">
                    <Input
                        placeholder="Add next step..."
                        value={newAction}
                        onChange={e => setNewAction(e.target.value)}
                        className="h-8 bg-black/20 border-border text-xs"
                        onKeyDown={e => e.key === 'Enter' && handleAdd()}
                    />
                    <Input
                        type="date"
                        value={date}
                        onChange={e => setDate(e.target.value)}
                        className="h-8 w-[110px] bg-black/20 border-border text-xs"
                    />
                    <Button size="sm" onClick={handleAdd} className="h-8 px-2">
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>

                <div className="space-y-1">
                    {actions.length === 0 && <p className="text-xs text-muted-foreground italic">No tracked actions.</p>}
                    {actions.map(action => (
                        <div key={action.id} className="flex items-center gap-2 group p-1 hover:bg-muted rounded">
                            <div
                                onClick={() => toggle(action.id, action.isCompleted)}
                                className={cn(
                                    "h-4 w-4 rounded border flex items-center justify-center cursor-pointer transition-colors",
                                    action.isCompleted ? "bg-green-500/20 border-green-500 text-green-500" : "border-border hover:border-white/40"
                                )}
                            >
                                {action.isCompleted && <div className="h-2 w-2 bg-green-500 rounded-full" />}
                            </div>
                            <span className={cn("text-xs flex-1", action.isCompleted && "line-through opacity-50")}>
                                {action.text}
                            </span>
                            {action.dueDate && (
                                <span className={cn("text-[10px]", new Date(action.dueDate) < new Date() && !action.isCompleted ? "text-red-400 font-bold" : "text-muted-foreground")}>
                                    {format(new Date(action.dueDate), 'MMM d')}
                                </span>
                            )}
                            <button onClick={() => remove(action.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400">
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
};

const AIAssistantPanel = ({ contact, repo }: { contact: PartnerRecord, repo: ContactsRepository }) => {
    const { toast } = useToast();
    const [generating, setGenerating] = useState(false);
    const [suggestion, setSuggestion] = useState<{ reply: string, actions: string[], rationale: string } | null>(null);
    const [isCollapsed, setIsCollapsed] = useState(false);

    // Enhanced: Negotiation Copilot state
    const [mode, setMode] = useState<'quick' | 'deep'>('quick');
    const [negotiationAnalysis, setNegotiationAnalysis] = useState<{
        diagnosis: string;
        strategy_applied: string;
        suggested_response: string;
        coaching_tip: string;
    } | null>(null);
    const [analyzingNegotiation, setAnalyzingNegotiation] = useState(false);
    const [savingToTimeline, setSavingToTimeline] = useState(false);
    const [customReplyText, setCustomReplyText] = useState('');

    // Auto-detect last received message from timeline for context
    const lastReceivedMessage = useMemo(() => {
        if (!contact.timeline || contact.timeline.length === 0) return null;
        const received = contact.timeline.filter(t => t.direction === 'received');
        return received.length > 0 ? received[received.length - 1] : null;
    }, [contact.timeline]);

    // Quick mode: Simple reply generation (existing logic)
    const generateQuick = async () => {
        setGenerating(true);
        await new Promise(r => setTimeout(r, 1500));

        const lastLog = lastReceivedMessage || (contact.timeline && contact.timeline.length > 0 ? contact.timeline[contact.timeline.length - 1] : null);
        let reply = "Hi [Name],\n\nJust checking in on our partnership. Do you have 15 mins to chat next week?\n\nBest,\nAdmin";
        let actions = ["Follow up in 3 days", "Send capabilities deck"];

        if (lastLog?.type === 'email' && lastLog.direction === 'received') {
            reply = `Hi ${contact.primaryContact?.name || 'there'},\n\nThanks for the update. I've reviewed the points you raised regarding the sponsorship tier. We can definitely accommodate the logo placement request.\n\nLet's finalize the agreement by Friday.\n\nBest,\nAdmin`;
            actions = ["Draft Agreement V2", "Schedule closing call"];
        } else if (contact.status === 'Prospect') {
            reply = `Hi ${contact.primaryContact?.name || 'there'},\n\nI'd love to introduce our SEDS chapter to your team at ${contact.organizationName}. We have some exciting projects launching soon aligned with your mission.\n\nAre you open to a brief intro call?\n\nBest,\nAdmin`;
            actions = ["Research recent company news", "Find warm intro match"];
        }

        setSuggestion({ reply, actions, rationale: "Based on recent activity, this contact is approaching a decision point. A direct but value-focused nudge is recommended." });
        setGenerating(false);
    };

    // Save quick reply to timeline
    const [savingQuickReply, setSavingQuickReply] = useState(false);
    const saveQuickReplyToTimeline = async () => {
        if (!suggestion || !contact.id) return;

        setSavingQuickReply(true);
        try {
            const newInteraction: Interaction = {
                id: generateId(),
                type: 'note',
                direction: 'sent',
                content: `[AI GENERATED REPLY]\n${suggestion.reply}\n\n---\nNext Steps: ${suggestion.actions.join(', ')}`,
                timestamp: new Date().toISOString(),
                author: 'AI Quick Reply'
            };

            await repo.addInteraction(contact.id, contact.timeline || [], newInteraction);
            toast({ title: "Logged", description: "Quick reply saved to timeline." });
        } catch (e: any) {
            toast({ title: "Error", description: e.message, variant: "destructive" });
        } finally {
            setSavingQuickReply(false);
        }
    };

    // Deep mode: Full Negotiation Copilot analysis
    const generateDeepAnalysis = async () => {
        const replyText = customReplyText || lastReceivedMessage?.content;
        if (!replyText) {
            toast({ title: "No message to analyze", description: "Enter or detect a message first.", variant: "destructive" });
            return;
        }

        setAnalyzingNegotiation(true);
        setNegotiationAnalysis(null);

        try {
            const apiKey = ""; // AI key is managed server-side via GEMINI_API_KEY.
            const model = localStorage.getItem("genai.model") || DEFAULT_AI_MODEL;

            const res = await fetch("/api/ai/analyze-reply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    replyText,
                    partnerName: contact.organizationName,
                    history: contact.timeline,
                    strategicContext: contact.strategicContext,
                    apiKey,
                    model
                }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Analysis failed");

            setNegotiationAnalysis(data);
        } catch (error: any) {
            toast({ title: "Error", description: error.message, variant: "destructive" });
        } finally {
            setAnalyzingNegotiation(false);
        }
    };

    // Save negotiation analysis to timeline
    const saveNegotiationToTimeline = async () => {
        if (!negotiationAnalysis || !contact.id) return;

        setSavingToTimeline(true);
        try {
            const replyText = customReplyText || lastReceivedMessage?.content || '';
            const note = `[NEGOTIATION COPILOT]\nTheir Reply: "${replyText.substring(0, 200)}${replyText.length > 200 ? '...' : ''}"\n\nDiagnosis: ${negotiationAnalysis.diagnosis}\nStrategy: ${negotiationAnalysis.strategy_applied}\n\nSuggested Response:\n${negotiationAnalysis.suggested_response}`;

            const newInteraction: Interaction = {
                id: generateId(),
                type: 'note',
                direction: 'sent',
                content: note,
                timestamp: new Date().toISOString(),
                author: 'AI Copilot'
            };

            await repo.addInteraction(contact.id, contact.timeline || [], newInteraction);
            toast({ title: "Logged", description: "Negotiation analysis saved to timeline." });
        } catch (e: any) {
            toast({ title: "Error", description: e.message, variant: "destructive" });
        } finally {
            setSavingToTimeline(false);
        }
    };

    const saveActions = async () => {
        if (!suggestion) return;
        const current = contact.nextActions || [];
        const newOnes = suggestion.actions.map(text => ({
            id: generateId(),
            text,
            isCompleted: false
        }));
        await repo.updateField(contact.id!, 'nextActions', [...current, ...newOnes]);
        toast({ title: "Added", description: "Actions added to checklist." });
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        toast({ title: "Copied", description: "Text copied to clipboard." });
    };

    return (
        <Card className="bg-indigo-500/10 border-indigo-500/20">
            <CardHeader className="p-3 sm:p-4 pb-2">
                <CardTitle className="text-xs sm:text-sm font-bold text-indigo-300 flex items-center justify-between gap-2 flex-wrap">
                    <button
                        onClick={() => setIsCollapsed(!isCollapsed)}
                        className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                    >
                        <BrainCircuit className="h-3 w-3 sm:h-4 sm:w-4 text-purple-400" />
                        <span className="text-xs sm:text-sm">AI NEGOTIATION</span>
                        <ChevronDown className={cn("h-3 w-3 transition-transform", isCollapsed ? "" : "rotate-180")} />
                    </button>

                    {/* Mode Toggle */}
                    {!isCollapsed && (
                        <div className="flex gap-1 bg-black/20 rounded-full p-0.5">
                            <button
                                onClick={() => { setMode('quick'); setNegotiationAnalysis(null); }}
                                className={cn(
                                    "px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors",
                                    mode === 'quick' ? "bg-indigo-500 text-foreground" : "text-indigo-300 hover:bg-muted"
                                )}
                            >
                                Quick
                            </button>
                            <button
                                onClick={() => { setMode('deep'); setSuggestion(null); }}
                                className={cn(
                                    "px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors",
                                    mode === 'deep' ? "bg-purple-500 text-foreground" : "text-purple-300 hover:bg-muted"
                                )}
                            >
                                Deep
                            </button>
                        </div>
                    )}
                </CardTitle>
            </CardHeader>

            {!isCollapsed && (
                <CardContent className="p-3 sm:p-4 pt-0 space-y-3 sm:space-y-4">
                    {/* QUICK MODE */}
                    {mode === 'quick' && (
                        <>
                            {lastReceivedMessage && !suggestion && (
                                <div className="bg-black/20 rounded-lg p-2 sm:p-3 border border-white/5">
                                    <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1 flex items-center gap-1">
                                        <Mail className="h-3 w-3" />
                                        Last Received Message
                                    </div>
                                    <div className="text-xs text-zinc-400 line-clamp-2">
                                        {lastReceivedMessage.content?.substring(0, 150)}
                                        {(lastReceivedMessage.content?.length || 0) > 150 && '...'}
                                    </div>
                                </div>
                            )}

                            <Button
                                size="sm"
                                className="w-full h-8 text-xs bg-indigo-600 hover:bg-indigo-500"
                                onClick={generateQuick}
                                disabled={generating}
                            >
                                {generating ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Activity className="mr-2 h-3 w-3" />}
                                {generating ? 'Generating...' : 'Generate Quick Reply'}
                            </Button>

                            {suggestion && (
                                <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2">
                                    <div className="bg-black/30 p-2 sm:p-3 rounded-lg border border-white/5">
                                        <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Suggested Reply</div>
                                        <div className="text-xs whitespace-pre-wrap font-mono text-zinc-300 max-h-32 overflow-y-auto">
                                            {suggestion.reply}
                                        </div>
                                        <div className="flex justify-end gap-1 mt-2">
                                            <Button size="sm" className="h-5 text-[10px] px-2" variant="secondary" onClick={() => copyToClipboard(suggestion.reply)}>
                                                <Copy className="h-2.5 w-2.5 mr-1" /> Copy
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-5 text-[10px] px-2 border-indigo-500/30 text-indigo-300"
                                                onClick={saveQuickReplyToTimeline}
                                                disabled={savingQuickReply}
                                            >
                                                {savingQuickReply ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Save className="h-2.5 w-2.5 mr-1" />}
                                                Log
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="bg-black/30 p-2 rounded-lg border border-white/5">
                                        <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Next Steps</div>
                                        <ul className="space-y-1">
                                            {suggestion.actions.map(a => (
                                                <li key={a} className="text-xs flex items-center gap-2">
                                                    <div className="h-1 w-1 rounded-full bg-indigo-400 flex-shrink-0" />
                                                    <span className="truncate">{a}</span>
                                                </li>
                                            ))}
                                        </ul>
                                        <div className="flex justify-end mt-2">
                                            <Button size="sm" className="h-5 text-[10px] px-2 bg-indigo-600 hover:bg-indigo-500 text-foreground" onClick={saveActions}>
                                                Add to Checklist
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {/* DEEP MODE - Full Negotiation Copilot */}
                    {mode === 'deep' && (
                        <>
                            {/* Auto-detected context */}
                            <div className="bg-black/20 rounded-lg p-2 sm:p-3 border border-white/5">
                                <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1 flex items-center gap-1">
                                    <Mail className="h-3 w-3" />
                                    {lastReceivedMessage ? 'Auto-Detected Message (editable)' : 'Paste Their Reply'}
                                </div>
                                <Textarea
                                    placeholder="Paste the email or message you received..."
                                    value={customReplyText || lastReceivedMessage?.content || ''}
                                    onChange={(e) => setCustomReplyText(e.target.value)}
                                    className="min-h-[80px] text-xs bg-black/20 border-border resize-none"
                                />
                            </div>

                            <Button
                                size="sm"
                                className="w-full h-8 text-xs bg-purple-600 hover:bg-purple-500"
                                onClick={generateDeepAnalysis}
                                disabled={analyzingNegotiation || (!customReplyText && !lastReceivedMessage)}
                            >
                                {analyzingNegotiation ? (
                                    <><Loader2 className="mr-2 h-3 w-3 animate-spin" /> Diagnosing Barrier...</>
                                ) : (
                                    <><Sparkles className="mr-2 h-3 w-3" /> Analyze & Generate Counter-Move</>
                                )}
                            </Button>

                            {/* Negotiation Analysis Results */}
                            {negotiationAnalysis && (
                                <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        <div className="p-2 sm:p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                                            <h4 className="font-bold text-red-400 text-[10px] uppercase mb-1">Diagnosis</h4>
                                            <p className="text-xs text-zinc-300">{negotiationAnalysis.diagnosis}</p>
                                        </div>
                                        <div className="p-2 sm:p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                                            <h4 className="font-bold text-green-400 text-[10px] uppercase mb-1">Strategy</h4>
                                            <p className="text-xs text-zinc-300">{negotiationAnalysis.strategy_applied}</p>
                                        </div>
                                    </div>

                                    <div className="p-2 sm:p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                                        <h4 className="font-bold text-blue-400 text-[10px] uppercase mb-1 flex items-center gap-1">
                                            <Lightbulb className="h-3 w-3" /> Coaching Tip
                                        </h4>
                                        <p className="text-xs text-zinc-300 italic">{negotiationAnalysis.coaching_tip}</p>
                                    </div>

                                    <div className="bg-black/30 p-2 sm:p-3 rounded-lg border border-white/5">
                                        <div className="flex justify-between items-center mb-1">
                                            <div className="text-[10px] text-muted-foreground uppercase font-bold">Suggested Response</div>
                                            <div className="flex gap-1">
                                                <Button size="sm" variant="ghost" className="h-5 text-[10px] px-1.5" onClick={() => copyToClipboard(negotiationAnalysis.suggested_response)}>
                                                    <Copy className="h-2.5 w-2.5 mr-1" /> Copy
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-5 text-[10px] px-1.5 border-purple-500/30 text-purple-300"
                                                    onClick={saveNegotiationToTimeline}
                                                    disabled={savingToTimeline}
                                                >
                                                    {savingToTimeline ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Save className="h-2.5 w-2.5 mr-1" />}
                                                    Log
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="text-xs whitespace-pre-wrap font-mono text-zinc-300 max-h-40 overflow-y-auto bg-black/20 p-2 rounded">
                                            {negotiationAnalysis.suggested_response}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {!negotiationAnalysis && !analyzingNegotiation && !lastReceivedMessage && !customReplyText && (
                                <div className="text-center py-3 text-[10px] text-muted-foreground opacity-70">
                                    No received messages detected. Paste their reply above to analyze.
                                </div>
                            )}
                        </>
                    )}
                </CardContent>
            )}
        </Card>
    );
};

// --- Full Screen Deep Dive Sheet ---

const FullScreenContact = ({ contact, repo, open, onOpenChange, onLog }: { contact: PartnerRecord, repo: ContactsRepository, open: boolean, onOpenChange: (open: boolean) => void, onLog: (data: any) => void }) => {
    const timeline = useMemo(() => {
        const raw = contact.timeline || [];
        return [...raw].sort((a, b) => {
            const tA = safeDate(a.timestamp)?.getTime() || 0;
            const tB = safeDate(b.timestamp)?.getTime() || 0;
            return tA - tB;
        });
    }, [contact.timeline]);

    const handleDelete = async (interactionId: string) => {
        try {
            await repo.deleteInteraction(contact.id!, contact.timeline || [], interactionId);
        } catch (e) {
            console.error(e);
        }
    };

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            {/* 
               Changed to side="right" for better desktop CRM experience.
               Added w-full/sm:max-w-classes to control width responsively. 
            */}
            <SheetContent
                side="right"
                className="w-full sm:max-w-[700px] lg:max-w-[900px] p-0 flex flex-col bg-zinc-950 border-l border-border overflow-x-hidden"
            >
                <SheetHeader className="p-4 md:p-6 border-b border-border bg-zinc-900/50 backdrop-blur-md flex-none">
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <SheetTitle className="text-2xl font-bold text-foreground flex items-center gap-3">
                                {contact.organizationName}
                                <StatusSelector
                                    current={contact.status}
                                    onSelect={(v) => repo.updateStage(contact.id!, v as any)}
                                />
                            </SheetTitle>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground mt-1">
                            {contact.primaryContact?.email && (
                                <span className="flex items-center gap-1.5 text-foreground">
                                    <Mail className="h-3.5 w-3.5 opacity-70" />
                                    {contact.primaryContact.email}
                                </span>
                            )}
                            {contact.primaryContact?.phone && (
                                <span className="flex items-center gap-1.5 text-white/80">
                                    <Phone className="h-3.5 w-3.5 opacity-70" />
                                    {contact.primaryContact.phone}
                                </span>
                            )}
                            {contact.website && (
                                <span className="text-blue-400 hover:underline cursor-pointer">
                                    {contact.website}
                                </span>
                            )}
                        </div>
                    </div>
                </SheetHeader>

                <div className="flex-1 overflow-hidden">
                    <Tabs defaultValue="timeline" className="h-full flex flex-col">
                        <div className="px-6 pt-2 border-b border-white/5 flex-none">
                            <TabsList className="bg-transparent h-10 p-0 space-x-6">
                                <TabsTrigger value="timeline" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 pb-2">
                                    Timeline
                                </TabsTrigger>
                                <TabsTrigger value="hq" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 pb-2">
                                    Headquarters
                                </TabsTrigger>
                                <TabsTrigger value="details" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 pb-2">
                                    Context
                                </TabsTrigger>
                            </TabsList>
                        </div>

                        <TabsContent value="timeline" className="flex-1 flex flex-col min-h-0 mt-0 data-[state=inactive]:hidden">
                            <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-background/50">
                                <RelationshipTimeline timeline={timeline} className="flex-1" onDelete={handleDelete} />
                                <LogComposer onSend={onLog} />
                            </div>
                        </TabsContent>

                        <TabsContent value="hq" className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 mt-0 data-[state=inactive]:hidden bg-black/10">
                            <AIAssistantPanel contact={contact} repo={repo} />
                            <NextActionsList contact={contact} repo={repo} />
                            <div className="md:hidden">
                                <RelationshipScore contact={contact} />
                            </div>
                        </TabsContent>

                        <TabsContent value="details" className="flex-1 overflow-y-auto p-6 space-y-6 mt-0 data-[state=inactive]:hidden">
                            <RelationshipScore contact={contact} />

                            <Card className="bg-transparent border-border">
                                <CardHeader className="p-0 pb-3">
                                    <CardTitle className="text-sm font-medium text-muted-foreground">STRATEGIC CONTEXT</CardTitle>
                                </CardHeader>
                                <Textarea
                                    className="min-h-[300px] bg-black/20 border-border text-sm resize-none leading-relaxed p-4"
                                    placeholder="Key context, leverage points, negotiation notes..."
                                    defaultValue={contact.strategicContext}
                                    onBlur={(e) => repo.updateField(contact.id!, 'strategicContext', e.target.value)}
                                />
                            </Card>

                            <Card className="bg-transparent border-border">
                                <CardHeader className="p-0 pb-3">
                                    <CardTitle className="text-sm font-medium text-muted-foreground">FINANCIALS (PLEDGED)</CardTitle>
                                </CardHeader>
                                <div className="text-3xl font-mono font-bold text-green-400">
                                    ${contact.financials?.pledgedAmount || '0'}
                                </div>
                            </Card>
                        </TabsContent>
                    </Tabs>
                </div>
            </SheetContent>
        </Sheet>
    );
};

// --- Row Component ---

const CRMRow = ({ contact, repo, onLog, onExpand }: { contact: PartnerRecord, repo: ContactsRepository, onLog: (id: string, data: any) => void, onExpand: () => void }) => {

    // Sort timeline (just for preview)
    const timeline = useMemo(() => {
        const raw = contact.timeline || [];
        // Ensure sorted by time
        return [...raw].sort((a, b) => {
            const tA = safeDate(a.timestamp)?.getTime() || 0;
            const tB = safeDate(b.timestamp)?.getTime() || 0;
            return tA - tB;
        });
    }, [contact.timeline]);

    const lastInteractionDate = timeline.length > 0 ? safeDate(timeline[timeline.length - 1].timestamp) : null;
    const nextActionDate = safeDate(contact.nextActionDate);

    // Dynamic Last Touch Display
    const lastActivityInfo = useMemo(() => {
        if (contact.lastActivityAt) {
            return {
                date: safeDate(contact.lastActivityAt),
                label: contact.lastActivityType || 'Update'
            };
        }
        return { date: lastInteractionDate, label: 'Interaction' };
    }, [contact, lastInteractionDate]);

    return (
        <TableRow
            className="cursor-pointer hover:bg-muted border-white/5 group transition-colors"
            onClick={onExpand}
        >
            <TableCell className="w-[10px]">
                <Maximize2 className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </TableCell>
            <TableCell>
                <div className="font-medium flex items-center gap-2">
                    <span className="text-base font-bold">{contact.organizationName}</span>
                    {/* Health Dot */}
                    <div className="h-1.5 w-1.5 rounded-full bg-green-500" title="Good Health" />
                </div>
                <div className="flex flex-col mt-1 space-y-0.5">
                    {contact.primaryContact?.email ? (
                        <span className="text-xs text-white/90 font-medium tracking-wide flex items-center gap-1.5">
                            <Mail className="h-3 w-3 opacity-50" />
                            {contact.primaryContact.email}
                        </span>
                    ) : (
                        <span className="text-xs text-muted-foreground italic">No Email</span>
                    )}

                    {contact.primaryContact?.phone && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                            <Phone className="h-3 w-3 opacity-50" />
                            {contact.primaryContact.phone}
                        </span>
                    )}
                </div>
            </TableCell>
            <TableCell>
                <Badge variant="outline" className="bg-muted border-border">{contact.status}</Badge>
            </TableCell>
            <TableCell>
                <div className="flex items-center gap-1 font-mono text-sm">
                    <span className="text-muted-foreground">$</span>
                    <span className="font-medium">{contact.financials?.pledgedAmount || 0}</span>
                </div>
            </TableCell>
            <TableCell>
                <div className={cn("text-xs font-medium px-2 py-1 rounded inline-block", !nextActionDate ? "text-muted-foreground" : "bg-red-500/10 text-red-400 border border-red-500/20")}>
                    {nextActionDate ? format(nextActionDate, 'MMM d') : 'None'}
                </div>
            </TableCell>
            <TableCell>
                <div className="flex flex-col">
                    <span className="text-xs font-medium text-white/80">
                        {lastActivityInfo.date ? formatDistanceToNow(lastActivityInfo.date, { addSuffix: true }) : 'Never'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                        {lastActivityInfo.label}
                    </span>
                </div>
            </TableCell>
        </TableRow>
    );
};

const CRMCard = ({ contact, onExpand }: { contact: PartnerRecord, onExpand: () => void }) => {
    const lastActivityDate = safeDate(contact.lastActivityAt || contact.updatedAt);

    return (
        <div
            onClick={onExpand}
            className="bg-card/40 border border-border rounded-xl p-4 active:scale-[0.98] transition-all cursor-pointer"
        >
            <div className="flex justify-between items-start mb-3">
                <div>
                    <h3 className="font-bold text-lg text-foreground mb-1">{contact.organizationName}</h3>
                    <Badge variant="secondary" className="text-[10px] h-5">{contact.status}</Badge>
                </div>
                <div className="flex flex-col items-end text-right">
                    <span className="text-xs font-bold text-green-400 font-mono">${contact.financials?.pledgedAmount || 0}</span>
                    <span className="text-[10px] text-muted-foreground mt-1">
                        {lastActivityDate ? formatDistanceToNow(lastActivityDate, { addSuffix: true }) : 'No activity'}
                    </span>
                </div>
            </div>

            <div className="flex items-center gap-3 text-sm text-muted-foreground">
                {contact.primaryContact?.email && (
                    <div className="flex items-center gap-1.5 truncate">
                        <Mail className="h-3.5 w-3.5" />
                        <span className="truncate max-w-[150px]">{contact.primaryContact.email}</span>
                    </div>
                )}
                {contact.primaryContact?.phone && (
                    <div className="flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5" />
                        <span>Call</span>
                    </div>
                )}
            </div>
        </div>
    );
};

// --- Main Page ---

// Default AI model for server-routed AI calls. The admin model preference
// is stored in the browser under "genai.model" (not a secret).
const DEFAULT_AI_MODEL = "gemini-1.5-flash";

export default function CRMPage() {
    const db = useFirestore();
    const repo = useMemo(() => new ContactsRepository(db), [db]);
    const { user } = useUser();
    const { toast } = useToast();

    // Data Loading
    const { data: contacts, loading } = useCollection(repo.getAllQuery(), { listen: true });

    // State
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('__ALL__');
    const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
    const [createOpen, setCreateOpen] = useState(false);

    // Sort State
    const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'lastActivityAt', direction: 'desc' });

    // Filter & Sort Logic
    const filtered = useMemo(() => {
        if (!contacts) return [];
        let res = [...contacts]; // Clone for sorting

        // Filter
        if (statusFilter !== '__ALL__') {
            res = res.filter(c => c.status === statusFilter);
        }
        if (search) {
            const lower = search.toLowerCase();
            res = res.filter(c =>
                c.organizationName?.toLowerCase().includes(lower) ||
                c.primaryContact?.name?.toLowerCase().includes(lower) ||
                c.primaryContact?.email?.toLowerCase().includes(lower)
            );
        }

        // Sort
        res.sort((a, b) => {
            let valA: any = '';
            let valB: any = '';

            switch (sortConfig.key) {
                case 'organizationName':
                    valA = a.organizationName?.toLowerCase() || '';
                    valB = b.organizationName?.toLowerCase() || '';
                    break;
                case 'financials.pledgedAmount':
                    valA = a.financials?.pledgedAmount || 0;
                    valB = b.financials?.pledgedAmount || 0;
                    break;
                case 'lastActivityAt':
                    // Prioritize lastActivityAt, fallback to updatedAt
                    valA = safeDate(a.lastActivityAt || a.updatedAt)?.getTime() || 0;
                    valB = safeDate(b.lastActivityAt || b.updatedAt)?.getTime() || 0;
                    break;
                default:
                    valA = 0;
                    valB = 0;
            }

            if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
            if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
            return 0;
        });

        return res;
    }, [contacts, search, statusFilter, sortConfig]);

    const handleSort = (key: string) => {
        setSortConfig(current => ({
            key,
            direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc'
        }));
    };

    // Stats
    const stats = useMemo(() => {
        const s: Record<string, number> = {};
        contacts?.forEach(c => {
            s[c.status] = (s[c.status] || 0) + 1;
        });
        return s;
    }, [contacts]);

    // Handlers
    const handleLogInteraction = async (id: string, data: any) => {
        try {
            const contact = contacts?.find(c => c.id === id);
            if (!contact) return;

            await repo.addInteraction(id, contact.timeline || [], {
                ...data,
                author: user?.displayName || 'Admin'
            });

            toast({ title: "Logged", description: "Relationship updated." });
        } catch (e: any) {
            console.error(e);
            toast({ title: "Error", description: "Failed to log interaction.", variant: "destructive" });
        }
    };

    const selectedContact = useMemo(() => contacts?.find(c => c.id === selectedContactId), [contacts, selectedContactId]);

    return (
        <AuthorizationGate permission="canManageSponsorsPartners">
            <div className="flex flex-col h-[calc(100vh-4rem)]">
                {/* Header Section */}
                <div className="flex-none p-4 pb-0 space-y-4">
                    <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-4">
                        <div>
                            <h1 className="text-3xl font-bold text-glow">CRM Command Center</h1>
                            <p className="text-muted-foreground text-sm">Review pipeline, track health, and deepen relationships.</p>
                        </div>
                        <div className="flex gap-2">
                            <Button onClick={() => setCreateOpen(true)} className="bg-primary hover:bg-primary/90 text-foreground shadow-lg shadow-primary/20">
                                <Plus className="h-4 w-4 mr-2" />
                                Add Contact
                            </Button>
                            <Button variant="outline" asChild className="hidden sm:flex">
                                <Link href="/admin/sponsors-partners">Legacy Table</Link>
                            </Button>
                        </div>
                    </div>

                    <PipelineStatusBar stats={stats} />

                    <div className="flex flex-col sm:flex-row gap-3 items-center bg-card/30 p-3 rounded-lg border border-white/5 backdrop-blur-sm">
                        <div className="relative flex-1 w-full">
                            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search contacts..."
                                className="pl-8 bg-background/50 border-transparent focus:border-primary/50"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                            />
                        </div>
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="w-[150px] bg-background/50 border-transparent">
                                <SelectValue placeholder="Stage" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__ALL__">All Stages</SelectItem>
                                {STATUS_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                {/* Main Content Area */}
                <div className="flex-1 overflow-hidden p-4">
                    {filtered.length === 0 && !loading ? (
                        <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                            <p>No contacts found matching your filters.</p>
                        </div>
                    ) : (
                        <div className="h-full overflow-auto rounded-md border-0 md:border md:border-border bg-transparent md:bg-card/20 md:backdrop-blur-md">

                            {/* Mobile: Cards */}
                            <div className="md:hidden space-y-3 pb-20">
                                {filtered.map(contact => (
                                    <CRMCard
                                        key={contact.id}
                                        contact={contact}
                                        onExpand={() => setSelectedContactId(contact.id!)}
                                    />
                                ))}
                            </div>

                            {/* Desktop: Table */}
                            <Table className="hidden md:table">
                                <TableHeader className="bg-background/80 sticky top-0 z-10 backdrop-blur-md shadow-sm">
                                    <TableRow className="hover:bg-transparent border-white/5">
                                        <TableHead className="w-[40px]"></TableHead>
                                        <TableHead
                                            className="w-[300px] cursor-pointer hover:text-foreground transition-colors select-none"
                                            onClick={() => handleSort('organizationName')}
                                        >
                                            Entity {sortConfig.key === 'organizationName' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                                        </TableHead>
                                        <TableHead className="w-[150px]">Status</TableHead>
                                        <TableHead
                                            className="w-[150px] cursor-pointer hover:text-foreground transition-colors select-none"
                                            onClick={() => handleSort('financials.pledgedAmount')}
                                        >
                                            Value {sortConfig.key === 'financials.pledgedAmount' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                                        </TableHead>
                                        <TableHead className="w-[100px]">Next Actions</TableHead>
                                        <TableHead
                                            className="cursor-pointer hover:text-foreground transition-colors select-none"
                                            onClick={() => handleSort('lastActivityAt')}
                                        >
                                            Last Activity {sortConfig.key === 'lastActivityAt' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map(contact => (
                                        <CRMRow
                                            key={contact.id}
                                            contact={contact}
                                            repo={repo}
                                            onLog={handleLogInteraction}
                                            onExpand={() => setSelectedContactId(contact.id!)}
                                        />
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </div>

                {selectedContact && (
                    <FullScreenContact
                        open={!!selectedContactId}
                        onOpenChange={(v) => !v && setSelectedContactId(null)}
                        contact={selectedContact}
                        repo={repo}
                        onLog={(data) => handleLogInteraction(selectedContact.id!, data)}
                    />
                )}

                <CreateContactDialog
                    repo={repo}
                    open={createOpen}
                    onOpenChange={setCreateOpen}
                />
            </div>
        </AuthorizationGate>
    );
}
