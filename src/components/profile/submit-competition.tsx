"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogDescription,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Send, Trophy, Gift, BookOpen, MoreHorizontal } from "lucide-react";
import { SubmissionType, DEFAULT_SUBMISSION_POINTS } from "@/lib/submission-types";

interface SubmitCompetitionProps {
    onSuccess?: () => void;
}

export default function SubmitCompetition({ onSuccess }: SubmitCompetitionProps) {
    const { toast } = useToast();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);

    const [formData, setFormData] = useState({
        type: "competition" as SubmissionType,
        title: "",
        url: "",
        description: "",
        organization: "",
        deadline: "",
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!formData.title.trim() || !formData.url.trim()) {
            toast({
                title: "Missing Fields",
                description: "Please provide a title and URL",
                variant: "destructive",
            });
            return;
        }

        // Basic URL validation
        try {
            new URL(formData.url);
        } catch {
            toast({
                title: "Invalid URL",
                description: "Please enter a valid URL (starting with http:// or https://)",
                variant: "destructive",
            });
            return;
        }

        setLoading(true);
        try {
            const res = await fetch("/api/submissions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...formData,
                    deadline: formData.deadline || undefined,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || "Failed to submit");
            }

            toast({
                title: "🎉 Submitted Successfully!",
                description: data.duplicateWarning
                    ? "Note: A similar URL was already submitted. Your submission is pending review."
                    : "Your submission is pending admin review. You'll be notified when it's approved!",
            });

            // Reset form and close
            setFormData({
                type: "competition",
                title: "",
                url: "",
                description: "",
                organization: "",
                deadline: "",
            });
            setOpen(false);
            onSuccess?.();

        } catch (error: any) {
            toast({
                title: "Submission Failed",
                description: error.message || "Please try again",
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    };

    const typeIcons: Record<SubmissionType, React.ReactNode> = {
        competition: <Trophy className="h-4 w-4" />,
        opportunity: <Gift className="h-4 w-4" />,
        resource: <BookOpen className="h-4 w-4" />,
        other: <MoreHorizontal className="h-4 w-4" />,
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="outline" className="gap-2">
                    <Send className="h-4 w-4" />
                    Submit Competition
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Trophy className="h-5 w-5 text-yellow-500" />
                        Submit a Competition or Opportunity
                    </DialogTitle>
                    <DialogDescription>
                        Share competitions, opportunities, or resources with the community.
                        Earn points when your submission is approved!
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                    {/* Type Selection */}
                    <div className="grid gap-2">
                        <Label>Type</Label>
                        <Select
                            value={formData.type}
                            onValueChange={(v) => setFormData((f) => ({ ...f, type: v as SubmissionType }))}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="competition">
                                    <span className="flex items-center gap-2">
                                        <Trophy className="h-4 w-4 text-yellow-500" />
                                        Competition ({DEFAULT_SUBMISSION_POINTS.competition} pts)
                                    </span>
                                </SelectItem>
                                <SelectItem value="opportunity">
                                    <span className="flex items-center gap-2">
                                        <Gift className="h-4 w-4 text-blue-500" />
                                        Opportunity ({DEFAULT_SUBMISSION_POINTS.opportunity} pts)
                                    </span>
                                </SelectItem>
                                <SelectItem value="resource">
                                    <span className="flex items-center gap-2">
                                        <BookOpen className="h-4 w-4 text-green-500" />
                                        Resource ({DEFAULT_SUBMISSION_POINTS.resource} pts)
                                    </span>
                                </SelectItem>
                                <SelectItem value="other">
                                    <span className="flex items-center gap-2">
                                        <MoreHorizontal className="h-4 w-4 text-gray-500" />
                                        Other ({DEFAULT_SUBMISSION_POINTS.other} pts)
                                    </span>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Title */}
                    <div className="grid gap-2">
                        <Label htmlFor="title">Title *</Label>
                        <Input
                            id="title"
                            placeholder="e.g., NASA Space Apps Challenge 2025"
                            value={formData.title}
                            onChange={(e) => setFormData((f) => ({ ...f, title: e.target.value }))}
                            required
                        />
                    </div>

                    {/* URL */}
                    <div className="grid gap-2">
                        <Label htmlFor="url">Link *</Label>
                        <Input
                            id="url"
                            type="url"
                            placeholder="https://..."
                            value={formData.url}
                            onChange={(e) => setFormData((f) => ({ ...f, url: e.target.value }))}
                            required
                        />
                    </div>

                    {/* Organization */}
                    <div className="grid gap-2">
                        <Label htmlFor="organization">Organization (optional)</Label>
                        <Input
                            id="organization"
                            placeholder="e.g., NASA, ESA, SpaceX"
                            value={formData.organization}
                            onChange={(e) => setFormData((f) => ({ ...f, organization: e.target.value }))}
                        />
                    </div>

                    {/* Deadline (for competitions) */}
                    {formData.type === "competition" && (
                        <div className="grid gap-2">
                            <Label htmlFor="deadline">Deadline (optional)</Label>
                            <Input
                                id="deadline"
                                type="date"
                                value={formData.deadline}
                                onChange={(e) => setFormData((f) => ({ ...f, deadline: e.target.value }))}
                            />
                        </div>
                    )}

                    {/* Description */}
                    <div className="grid gap-2">
                        <Label htmlFor="description">Description (optional)</Label>
                        <Textarea
                            id="description"
                            placeholder="Brief description of this competition or opportunity..."
                            value={formData.description}
                            onChange={(e) => setFormData((f) => ({ ...f, description: e.target.value }))}
                            rows={3}
                        />
                    </div>

                    {/* Points info */}
                    <div className="p-3 bg-muted rounded-lg text-sm text-muted-foreground">
                        <p className="font-medium text-foreground mb-1">How it works:</p>
                        <ol className="list-decimal list-inside space-y-1">
                            <li>Submit a competition or opportunity link</li>
                            <li>An admin will review your submission</li>
                            <li>If approved, you earn {DEFAULT_SUBMISSION_POINTS[formData.type]} points!</li>
                        </ol>
                    </div>

                    {/* Submit Button */}
                    <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Submitting...
                            </>
                        ) : (
                            <>
                                <Send className="h-4 w-4 mr-2" />
                                Submit for Review
                            </>
                        )}
                    </Button>
                </form>
            </DialogContent>
        </Dialog>
    );
}
