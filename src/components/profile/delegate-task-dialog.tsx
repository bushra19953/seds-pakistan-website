"use client";

import { useState, useEffect } from "react";
import { useUser } from "@/firebase/auth/use-user";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowRightLeft,
  Loader2,
  User,
  AlertTriangle,
  Link2,
  Plus,
  X,
  Sparkles,
  Pencil,
  Trash2,
  CheckCircle2,
  Target,
  LayoutGrid,
  Settings2,
  Eye,
  EyeOff,
  GitBranch,
  ShieldCheck,
  ChevronRight,
  ChevronDown,
  Cpu,
  Wrench
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface DelegateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  totalPoints: number;
  onDelegated?: () => void;
}

interface WorkflowStep {
  title: string;
  description: string;
  assigneeId: string;
  assigneeIds?: string[];
  assigneeName?: string;
  points: number;
  reason?: string;
}

interface Subordinate {
  id: string;
  name: string;
  role: string;
  taskCount: number;
  photoURL?: string;
  depth: number;
  managerId?: string;
}

const PRESET_MODELS = [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (Fast)" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Precision)" },
];

export function DelegateTaskDialog({
  open,
  onOpenChange,
  taskId,
  taskTitle,
  taskDescription,
  totalPoints,
  onDelegated,
}: DelegateTaskDialogProps) {
  const { user } = useUser();
  
  // State
  const [phase, setPhase] = useState<"input" | "review">("input");
  const [context, setContext] = useState("");
  const [links, setLinks] = useState<string[]>([""]);
  const [pointsKept, setPointsKept] = useState(Math.floor(totalPoints * 0.2)); 
  
  // AI Config
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [apiKey, setAiApiKey] = useState("");
  const [aiModel, setAiModel] = useState("gemini-2.5-flash");
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [customModelName, setCustomModelName] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  const [orchestrating, setOrchestrating] = useState(false);
  const [subordinates, setSubordinates] = useState<Subordinate[]>([]);
  const [roleDefinitions, setRoleDefinitions] = useState<any[]>([]);
  
  const [missionSteps, setMissionSteps] = useState<WorkflowStep[]>([]);
  const [editingStepIdx, setEditingStepIdx] = useState<number | null>(null);
  // UIDs the AI suggested that were not in the team pool sent to it.
  // Those picks are dropped and the steps are left unassigned.
  const [droppedPicks, setDroppedPicks] = useState<string[]>([]);
  
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showTeamViz, setShowTeamViz] = useState(false);

  const totalDelegatedPoints = missionSteps.reduce((sum, s) => sum + s.points, 0);
  const totalAllocated = totalDelegatedPoints + pointsKept;

  // Resolve a step's assignees as an array (primary first). Older steps only
  // carry the singular assigneeId.
  const getStepAssigneeIds = (s: WorkflowStep): string[] =>
    Array.isArray(s.assigneeIds) && s.assigneeIds.length
      ? s.assigneeIds
      : (s.assigneeId ? [s.assigneeId] : []);

  // Load AI config from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const storedKey = localStorage.getItem('gemini.apiKey') || "";
      const storedModel = localStorage.getItem('genai.model') || "gemini-2.5-flash";
      
      setAiApiKey(storedKey);
      
      const isPreset = PRESET_MODELS.some(m => m.id === storedModel);
      if (isPreset) {
          setAiModel(storedModel);
          setIsCustomModel(false);
      } else {
          setAiModel("custom");
          setCustomModelName(storedModel);
          setIsCustomModel(true);
      }
    }
  }, [open]);

  // Save AI config to localStorage
  const saveAiConfig = (key: string, model: string) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('gemini.apiKey', key);
      localStorage.setItem('genai.model', model);
    }
  };

  useEffect(() => {
    if (open && user) fetchHierarchy();
  }, [open, user]);

  const fetchHierarchy = async () => {
    try {
        const token = await user?.getIdToken();
        const res = await fetch('/api/admin/hierarchy/workload', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            setSubordinates(data.subordinates || []);
            setRoleDefinitions(data.roleDefinitions || []);
        }
    } catch (e) { console.error(e); }
  };

  // Reset state on open/close
  useEffect(() => {
    if (!open) {
      setPhase("input");
      setContext("");
      setLinks([""]);
      setMissionSteps([]);
      setDroppedPicks([]);
      setError("");
      setOrchestrating(false);
      setShowAiSettings(false);
    }
  }, [open]);

  const handleOrchestrate = async () => {
    if (!user) return;
    if (!apiKey) {
        setShowAiSettings(true);
        return;
    }

    setOrchestrating(true);
    setError("");
    setDroppedPicks([]);

    const finalModel = isCustomModel ? customModelName : aiModel;

    try {
      const token = await user.getIdToken();
      
      const aiRes = await fetch('/api/ai-task-generator', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `${taskTitle}\n\n${taskDescription}\n\nEXTRA CONTEXT: ${context}\nLINKS: ${links.join(', ')}`,
          totalPoints: totalPoints - pointsKept,
          subordinates: subordinates,
          roleDefinitions: roleDefinitions,
          apiKey: apiKey,
          model: finalModel
        })
      });

      const aiData = await aiRes.json();
      if (!aiRes.ok) throw new Error(aiData.error || "AI failed to orchestrate.");

      // Guard: only accept AI-suggested assignees that are non-empty strings
      // present in the same subordinate pool that was sent to the AI. Anything
      // else is dropped and the step is left unassigned so a bad pick can never
      // become a real assignment. Accepts an assigneeUids array when the AI
      // returns one; assigneeIds carries every validated pick (primary first).
      const validUidSet = new Set(subordinates.map((sub) => sub.id));
      const dropped: string[] = [];
      const orchestratedSteps = aiData.orchestration.steps.map((s: any) => {
        const rawUids: string[] = Array.isArray(s.assigneeUids) && s.assigneeUids.length
          ? s.assigneeUids.map(String)
          : (typeof s.assigneeUid === "string" ? [s.assigneeUid] : []);
        const validUids = rawUids.filter((uid) => uid && validUidSet.has(uid));
        const droppedUids = rawUids.filter((uid) => !uid || !validUidSet.has(uid));
        if (validUids.length > 0) {
          dropped.push(...droppedUids);
          return {
            ...s,
            assigneeId: validUids[0],
            assigneeIds: validUids,
            assigneeName:
              subordinates.find((sub: Subordinate) => sub.id === validUids[0])?.name || validUids[0],
          };
        }
        dropped.push(...(droppedUids.length ? droppedUids : ["(no assignee returned)"]));
        return { ...s, assigneeId: "", assigneeIds: [], assigneeName: "" };
      });

      setMissionSteps(orchestratedSteps);
      setDroppedPicks(dropped);
      setPhase("review");
    } catch (err: any) {
      setError(err.message || "Orchestration failed");
    } finally {
      setOrchestrating(false);
    }
  };

  const handleLaunch = async () => {
    if (!user) return;
    if (totalAllocated !== totalPoints) {
      setError(`Point mismatch. Total must be ${totalPoints}. Currently: ${totalAllocated}`);
      return;
    }
    // Never launch with a step that has no real assignee (e.g. a dropped AI pick).
    const unassignedCount = missionSteps.filter((s) => getStepAssigneeIds(s).length === 0).length;
    if (unassignedCount > 0) {
      setError(
        `Cannot launch: ${unassignedCount} step${unassignedCount === 1 ? "" : "s"} ${
          unassignedCount === 1 ? "has" : "have"
        } no assignee. Pick someone for each step first.`
      );
      return;
    }

    setSubmitting(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/tasks/delegate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          pointsKept,
          reason: context,
          workflowSteps: missionSteps.map(s => ({
            title: s.title,
            description: s.description,
            assigneeId: s.assigneeId,
            assigneeIds: getStepAssigneeIds(s),
            points: s.points
          }))
        })
      });

      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Launch failed");
      }

      onDelegated?.();
      onOpenChange(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-3xl bg-slate-950 border-slate-800 text-foreground p-0 overflow-hidden flex flex-col h-[90vh] shadow-2xl">
        
        {/* Header */}
        <div className="p-6 border-b border-slate-800 bg-card/50 flex items-center justify-between">
          <div>
            <DialogTitle className="text-2xl font-black font-mono flex items-center gap-3">
              <Target className="h-6 w-6 text-primary" /> MISSION COMMAND
            </DialogTitle>
            <DialogDescription className="text-muted-foreground font-mono text-xs mt-1 uppercase tracking-widest">
              Orchestrating: {taskTitle}
            </DialogDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setShowAiSettings(!showAiSettings)} className={showAiSettings || !apiKey ? "text-primary" : "text-muted-foreground"}>
            {apiKey ? <Settings2 className="h-5 w-5" /> : <Cpu className="h-5 w-5 animate-pulse text-amber-500" />}
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-8">
            
            {(!apiKey || showAiSettings) && phase === 'input' && (
              <div className={`bg-card border p-6 rounded-2xl space-y-6 animate-in slide-in-from-top-4 duration-300 ${!apiKey ? 'border-amber-500/30' : 'border-primary/20'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${!apiKey ? 'bg-amber-500/20 text-amber-500' : 'bg-primary/20 text-primary'}`}>
                        <Sparkles className="h-5 w-5" />
                    </div>
                    <div>
                        <h4 className="text-sm font-black uppercase tracking-widest text-foreground">
                            {apiKey ? 'Intelligence Config' : 'AI Mission Intelligence Offline'}
                        </h4>
                        <p className="text-[10px] text-muted-foreground uppercase font-mono">
                            {apiKey ? 'Configuration Active' : 'API Key required to orchestrate missions'}
                        </p>
                    </div>
                  </div>
                  {!apiKey && <Badge className="bg-amber-500/20 text-amber-500 border-0 text-[10px] font-black uppercase tracking-tighter">Setup Required</Badge>}
                </div>
                
                <div className="grid gap-5">
                  <div className="space-y-2">
                    <Label className="text-[10px] font-black uppercase text-muted-foreground tracking-widest">Google Gemini API Key</Label>
                    <div className="relative">
                        <Input 
                          type={showApiKey ? "text" : "password"}
                          value={apiKey} 
                          onChange={e => {
                            setAiApiKey(e.target.value);
                            saveAiConfig(e.target.value, isCustomModel ? customModelName : aiModel);
                          }}
                          placeholder="Paste your Gemini API key from AI Studio..."
                          className="bg-background/80 border-slate-800 font-mono text-xs h-12 pr-12 focus:border-primary/50 transition-all"
                        />
                        <button type="button" onClick={() => setShowApiKey(!showApiKey)} className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                    </div>
                    <div className="flex items-center justify-between">
                        <p className="text-[10px] text-slate-600 italic">Saved only in your local browser storage.</p>
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" className="text-[10px] text-primary font-bold hover:underline flex items-center gap-1">
                            GET FREE KEY <ChevronRight className="h-3 w-3" />
                        </a>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label className="text-[10px] font-black uppercase text-muted-foreground tracking-widest">Intelligence Model</Label>
                        <Select value={aiModel} onValueChange={val => {
                            if (val === "custom") {
                                setIsCustomModel(true);
                                setAiModel("custom");
                            } else {
                                setIsCustomModel(false);
                                setAiModel(val);
                                saveAiConfig(apiKey, val);
                            }
                        }}>
                            <SelectTrigger className="bg-background/80 border-slate-800 font-mono text-xs h-12">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-card border-slate-800">
                                {PRESET_MODELS.map(m => (
                                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                                ))}
                                <SelectItem value="custom" className="text-primary font-bold">
                                    <span className="flex items-center gap-2"><Wrench className="h-3 w-3" /> CUSTOM MODEL</span>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    {isCustomModel && (
                        <div className="space-y-2 animate-in fade-in slide-in-from-left-2">
                            <Label className="text-[10px] font-black uppercase text-primary tracking-widest">Enter Model ID</Label>
                            <Input 
                                value={customModelName}
                                onChange={e => {
                                    setCustomModelName(e.target.value);
                                    saveAiConfig(apiKey, e.target.value);
                                }}
                                placeholder="e.g. gemini-2.0-pro-exp"
                                className="bg-primary/5 border-primary/30 font-mono text-xs h-12 text-primary placeholder:text-primary/30"
                            />
                        </div>
                    )}
                  </div>
                  
                  {apiKey && (
                    <Button onClick={() => setShowAiSettings(false)} className="bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 h-10 font-bold uppercase text-[10px]">
                        Close Settings & Begin Orchestration
                    </Button>
                  )}
                </div>
              </div>
            )}

            {phase === "input" ? (
              <div className={`space-y-6 ${!apiKey ? 'opacity-40 pointer-events-none grayscale' : ''}`}>
                <div className="bg-card/30 border border-slate-800 p-4 rounded-xl space-y-3">
                    <button onClick={() => setShowTeamViz(!showTeamViz)} className="w-full flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
                        <span className="flex items-center gap-2"><GitBranch className="h-3 w-3 text-primary" /> Sub-Hierarchy Analyzed ({subordinates.length})</span>
                        {showTeamViz ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </button>
                    {showTeamViz && (
                        <div className="space-y-1 mt-4 max-h-[200px] overflow-y-auto pr-2 custom-scrollbar">
                            {subordinates.map(sub => (
                                <div key={sub.id} className="flex items-center gap-3 p-2 rounded-lg bg-black/20 border border-white/5" style={{ marginLeft: `${(sub.depth-1) * 12}px` }}>
                                    <Avatar className="h-5 w-5 border border-border shrink-0">
                                        <AvatarImage src={sub.photoURL || undefined} />
                                        <AvatarFallback className="bg-muted text-[8px] font-black">{sub.name.charAt(0)}</AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0 flex-1 flex items-center justify-between text-[10px]">
                                        <div className="min-w-0">
                                            <p className="font-bold text-foreground truncate">{sub.name}</p>
                                            <p className="text-[8px] text-muted-foreground uppercase">{sub.role.replace(/_/g, ' ')}</p>
                                        </div>
                                        <span className="text-slate-600 font-mono">{sub.taskCount} TASKS</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="bg-card/50 border border-slate-800 p-5 rounded-2xl space-y-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] font-black uppercase text-muted-foreground tracking-widest">Management Reserve</Label>
                    <Badge className="bg-primary/20 text-primary border-0 font-mono px-3">{pointsKept} / {totalPoints} PTS</Badge>
                  </div>
                  <Input type="number" value={pointsKept} onChange={e => setPointsKept(parseInt(e.target.value) || 0)} className="bg-slate-950 border-slate-800 font-mono h-12 text-lg text-center" />
                  <p className="text-[9px] text-muted-foreground italic text-center">Points reserved for your oversight and final briefing review.</p>
                </div>

                <div className="space-y-3">
                  <Label className="text-[10px] font-black uppercase text-muted-foreground tracking-widest flex items-center gap-2">
                    <LayoutGrid className="h-3 w-3 text-primary" /> Operational Context
                  </Label>
                  <Textarea placeholder="Detail the mission requirements, technical constraints, and goals..." value={context} onChange={e => setContext(e.target.value)} className="bg-card border-slate-800 min-h-[150px] resize-none focus:border-primary/50 text-sm p-4 rounded-2xl" />
                </div>

                <div className="space-y-3">
                  <Label className="text-[10px] font-black uppercase text-muted-foreground tracking-widest flex items-center gap-2">
                    <Link2 className="h-3 w-3 text-blue-400" /> Intelligence Assets (Links)
                  </Label>
                  {links.map((link, idx) => (
                    <div key={idx} className="flex gap-2">
                      <Input value={link} onChange={e => { const next = [...links]; next[idx] = e.target.value; setLinks(next); }} placeholder="https://..." className="bg-card border-slate-800 h-11 font-mono text-xs rounded-xl" />
                      <Button variant="ghost" size="icon" onClick={() => setLinks(links.filter((_, i) => i !== idx))} className="text-muted-foreground hover:text-red-400 h-11 w-11 shrink-0"><X className="h-4 w-4" /></Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={() => setLinks([...links, ""])} className="border-dashed border-slate-800 text-muted-foreground hover:text-foreground w-full h-11 rounded-xl">
                    <Plus className="h-3 w-3 mr-2" /> Add Additional Asset
                  </Button>
                </div>

                <Button onClick={handleOrchestrate} disabled={orchestrating} className="w-full h-16 bg-primary text-black hover:bg-primary/90 font-black uppercase tracking-[0.3em] shadow-[0_0_30px_rgba(16,185,129,0.15)] text-sm rounded-2xl transition-all">
                  {orchestrating ? <Loader2 className="h-6 w-6 animate-spin mr-3" /> : <Sparkles className="h-6 w-6 mr-3" />}
                  {orchestrating ? "AI ANALYZING MISSION GRID..." : "Orchestrate Mission with AI"}
                </Button>
              </div>
            ) : (
              <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                  <h3 className="text-xs font-black uppercase tracking-widest text-primary flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4" /> Proposed Architecture
                  </h3>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    ALLOCATED: <span className={totalAllocated === totalPoints ? "text-green-400 font-bold" : "text-red-400 font-bold"}>{totalAllocated}</span> / {totalPoints} PTS
                  </div>
                </div>

                {droppedPicks.length > 0 && (
                  <div className="p-5 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-start gap-4 text-amber-400 text-xs animate-in fade-in duration-300">
                    <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="font-black uppercase tracking-tight mb-1">AI pick rejected: not on your team</p>
                      <p className="font-mono text-[10px] leading-relaxed break-words">
                        The AI suggested {droppedPicks.length === 1 ? "an assignee" : "assignees"} outside the team list it was given: {droppedPicks.join(", ")}. {droppedPicks.length === 1 ? "That step was" : "Those steps were"} left unassigned. Pick someone for each step before launching.
                      </p>
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  {missionSteps.map((step, idx) => (
                    <div key={idx} className={`group relative border transition-all rounded-2xl p-5 ${editingStepIdx === idx ? 'border-primary bg-primary/5 shadow-[0_0_20px_rgba(16,185,129,0.05)]' : 'border-slate-800 bg-card/30 hover:border-slate-700'}`}>
                      {editingStepIdx === idx ? (
                        <div className="space-y-4">
                          <Input value={step.title} onChange={e => { const next = [...missionSteps]; next[idx].title = e.target.value; setMissionSteps(next); }} className="bg-slate-950 border-slate-800 font-bold h-10 rounded-xl" />
                          <Textarea value={step.description} onChange={e => { const next = [...missionSteps]; next[idx].description = e.target.value; setMissionSteps(next); }} className="bg-slate-950 border-slate-800 text-sm min-h-[100px] rounded-xl" />
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <label className="text-[10px] font-black uppercase text-muted-foreground">Field Operators (first picked = primary)</label>
                              <ScrollArea className="max-h-[168px] rounded-xl border border-slate-800 bg-slate-950">
                                <div className="p-1.5 space-y-1">
                                  {subordinates.map(s => {
                                    const ids = getStepAssigneeIds(step);
                                    const selected = ids.includes(s.id);
                                    return (
                                      <button
                                        key={s.id}
                                        type="button"
                                        onClick={() => {
                                          const next = [...missionSteps];
                                          const cur = getStepAssigneeIds(next[idx]);
                                          const updated = selected ? cur.filter(id => id !== s.id) : [...cur, s.id];
                                          next[idx].assigneeIds = updated;
                                          next[idx].assigneeId = updated[0] || "";
                                          next[idx].assigneeName = subordinates.find(x => x.id === updated[0])?.name || "";
                                          setMissionSteps(next);
                                        }}
                                        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${selected ? 'bg-primary/15 border border-primary/40' : 'border border-transparent hover:bg-white/5'}`}
                                      >
                                        {selected
                                          ? <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                                          : <div className="h-4 w-4 rounded-full border border-slate-600 shrink-0" />}
                                        <span className="min-w-0">
                                          <span className="block text-xs font-bold text-foreground truncate">{s.name}</span>
                                          <span className="block text-[9px] text-muted-foreground uppercase">{s.role.replace(/_/g, ' ')}</span>
                                        </span>
                                      </button>
                                    );
                                  })}
                                  {subordinates.length === 0 && (
                                    <p className="text-[10px] text-muted-foreground px-2 py-3 text-center">No subordinates loaded.</p>
                                  )}
                                </div>
                              </ScrollArea>
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-[10px] font-black uppercase text-muted-foreground">Point Value</label>
                              <Input type="number" value={step.points} onChange={e => { const next = [...missionSteps]; next[idx].points = parseInt(e.target.value) || 0; setMissionSteps(next); }} className="bg-slate-950 border-slate-800 h-10 font-mono text-center font-bold rounded-xl" />
                            </div>
                          </div>
                          <Button size="sm" className="w-full bg-muted font-bold h-10 rounded-xl" onClick={() => setEditingStepIdx(null)}><CheckCircle2 className="h-4 w-4 mr-2" /> Commit Edit</Button>
                        </div>
                      ) : (
                        <div className="flex items-start gap-4">
                          <div className="h-12 w-12 rounded-full bg-muted border border-slate-700 flex items-center justify-center font-mono font-bold text-primary shrink-0">
                            {idx + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1">
                              <h4 className="font-bold text-foreground truncate text-base">{step.title}</h4>
                              <div className="flex items-center gap-2">
                                <Badge className="bg-muted text-muted-foreground border-0 font-mono text-[10px] h-5 px-2">{step.points} PTS</Badge>
                                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => setEditingStepIdx(idx)}><Pencil className="h-3.5 w-3.5" /></Button>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => setMissionSteps(missionSteps.filter((_, i) => i !== idx))}><Trash2 className="h-3.5 w-3.5" /></Button>
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-2 mb-4 leading-relaxed">{step.description}</p>
                            <div className="flex flex-wrap items-center gap-3">
                              <div className="flex items-center gap-2 bg-slate-950/50 px-3 py-1.5 rounded-xl border border-slate-800">
                                <User className="h-3.5 w-3.5 text-primary" />
                                <span className="text-[10px] font-black text-muted-foreground uppercase">{step.assigneeName || "Unassigned"}</span>
                                {getStepAssigneeIds(step).length > 1 && (
                                  <span className="text-[9px] text-primary font-bold">+{getStepAssigneeIds(step).length - 1} in the loop</span>
                                )}
                              </div>
                              {step.reason && (
                                <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground italic truncate max-w-[250px]">
                                  <Sparkles className="h-3 w-3 text-amber-500/40" /> {step.reason}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <Button variant="outline" className="w-full border-dashed border-slate-800 h-14 text-muted-foreground hover:text-foreground rounded-2xl text-[10px] font-black uppercase tracking-[0.2em]" onClick={() => setMissionSteps([...missionSteps, { title: "New Step", description: "", assigneeId: subordinates[0]?.id || "", assigneeIds: subordinates[0]?.id ? [subordinates[0].id] : [], assigneeName: subordinates[0]?.name || "", points: 0 }])}>
                  <Plus className="h-4 w-4 mr-3" /> Insert Manual Deployment Step
                </Button>

                <div className="pt-6 border-t border-slate-800">
                  <Button onClick={handleLaunch} disabled={submitting || totalAllocated !== totalPoints} className="w-full h-16 bg-gradient-to-r from-amber-600 to-orange-600 text-black hover:from-amber-500 hover:to-orange-500 font-black uppercase tracking-[0.3em] shadow-xl shadow-orange-950/20 text-base rounded-2xl transition-all">
                    {submitting ? <Loader2 className="h-6 w-6 animate-spin mr-3" /> : <Target className="h-6 w-6 mr-3" />}
                    Launch Mission Command
                  </Button>
                  <Button variant="ghost" className="w-full mt-3 text-muted-foreground text-[10px] uppercase font-black tracking-widest h-10" onClick={() => setPhase("input")}>Return to Briefing</Button>
                </div>
              </div>
            )}

            {error && (
              <div className="p-5 bg-red-500/10 border border-red-500/30 rounded-2xl flex items-center gap-4 text-red-400 text-xs animate-in shake-in duration-300">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <span className="font-black uppercase tracking-tight">{error}</span>
              </div>
            )}

          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
