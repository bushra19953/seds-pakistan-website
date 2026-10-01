"use client";

import { useEffect, useMemo, useState } from "react";
import { useFirestore } from "@/firebase";
import {
  collection, getDocs, orderBy, query, doc, serverTimestamp, arrayUnion } from 'firebase/firestore';
;
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuthorization } from "@/hooks/use-authorization";
import { Badge } from "@/components/ui/badge";
import { updateDoc } from '@/lib/client/firestore-wrapper';

type BadgeOption = {
  slug: string;
  name: string;
  pointsRequired?: number;
  isActive?: boolean;
};

type AwardBadgeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userUid: string;
  userName?: string;
};

export default function AwardBadgeDialog({ open, onOpenChange, userUid, userName }: AwardBadgeDialogProps) {
  const firestore = useFirestore();
  const { toast } = useToast();
  const { isAuthorized: canManageBadges } = useAuthorization('canManageBadges');

  const [loadingBadges, setLoadingBadges] = useState<boolean>(false);
  const [badges, setBadges] = useState<BadgeOption[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);

  // Load badges when dialog opens
  useEffect(() => {
    let mounted = true;
    async function loadBadges() {
      if (!open) return;
      if (!canManageBadges) return; // skip loading if unauthorized
      setLoadingBadges(true);
      try {
        const q = query(collection(firestore, "badges"), orderBy("name"));
        const snap = await getDocs(q);
        const items: BadgeOption[] = snap.docs
          .map((d) => d.data() as any)
          .map((b) => ({
            slug: String(b.slug || ""),
            name: String(b.name || b.slug || ""),
            pointsRequired: Number(b.pointsRequired || 0),
            isActive: b.isActive !== false,
          }))
          .filter((b) => b.slug.length > 0 && b.name.length > 0)
          .filter((b) => b.isActive);
        if (mounted) setBadges(items);
      } catch (e) {
        console.error("Failed to load badges", e);
        toast({ variant: "destructive", title: "Error", description: "Failed to load badges." });
      } finally {
        if (mounted) setLoadingBadges(false);
      }
    }
    loadBadges();
    return () => {
      mounted = false;
    };
  }, [open, firestore, toast, canManageBadges]);

  const selectedBadgeLabel = useMemo(() => {
    const item = badges.find((b) => b.slug === selectedSlug);
    if (!item) return "Select a badge";
    const pts = Number(item.pointsRequired || 0);
    return `${item.name}${pts === 0 ? " (Manual Only)" : ""}`;
  }, [badges, selectedSlug]);

  const handleAward = async () => {
    if (!canManageBadges) {
      toast({ variant: "destructive", title: "Unauthorized", description: "You do not have permission to award badges." });
      return;
    }
    if (!selectedSlug) {
      toast({ variant: "destructive", title: "Select a badge", description: "Please choose a badge to award." });
      return;
    }
    setSaving(true);
    try {
      await updateDoc(doc(firestore, "users", userUid), {
        badges: arrayUnion(selectedSlug),
        updatedAt: serverTimestamp(),
      });
      toast({ title: "Badge Awarded", description: `Awarded '${selectedSlug}' to ${userName || userUid}.` });
      onOpenChange(false);
      setSelectedSlug("");
    } catch (e) {
      console.error("Failed to award badge", e);
      toast({ variant: "destructive", title: "Error", description: "Failed to award badge." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Award Badge</DialogTitle>
          <DialogDescription>
            {userName ? (
              <>Award a badge to <span className="font-medium">{userName}</span>.</>
            ) : (
              <>Award a badge to user <span className="font-mono">{userUid}</span>.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="badge-select">Badge</Label>
            <Select value={selectedSlug} onValueChange={setSelectedSlug} disabled={loadingBadges || saving || !canManageBadges}>
              <SelectTrigger id="badge-select">
                <SelectValue placeholder="Select a badge">{selectedBadgeLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {badges.map((b) => (
                  <SelectItem key={b.slug} value={b.slug}>
                    {b.name}{Number(b.pointsRequired || 0) === 0 ? " (Manual Only)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-sm text-muted-foreground">
            Badges with <span className="font-mono">0</span> points are treated as manual-award-only.
          </p>
          {!canManageBadges && (
            <p className="text-sm text-red-600">You do not have permission to award badges.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleAward} disabled={saving || !selectedSlug || !canManageBadges}>
            {saving ? "Awarding…" : "Award"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
