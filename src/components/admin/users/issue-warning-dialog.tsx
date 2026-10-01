"use client";

import { useEffect, useState } from "react";
import { useFirestore, useUser } from "@/firebase";
import {
  addDoc, collection, serverTimestamp, Timestamp, doc, increment, getDoc } from 'firebase/firestore';
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
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useAuthorization } from "@/hooks/use-authorization";
import { updateDoc } from '@/lib/client/firestore-wrapper';

import {
  WarningType,
  WARNING_TYPE_LABELS,
  WarningSettings,
  DEFAULT_WARNING_SETTINGS,
} from "@/types/user";

type IssueWarningDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userUid: string;
  userName?: string;
};

const REASON_TEMPLATES = [
  "Missed 3 consecutive General Body Meetings without prior notice.",
  "Repeated failure to meet project deadlines.",
  "Inappropriate conduct during a club event.",
  "Violation of SEDS hardware/lab usage policy.",
  "Unexcused absence from mandatory volunteering activity.",
];

export default function IssueWarningDialog({
  open,
  onOpenChange,
  userUid,
  userName,
}: IssueWarningDialogProps) {
  const firestore = useFirestore();
  const { user } = useUser();
  const { toast } = useToast();
  const { isAuthorized: canManageUsers } = useAuthorization("canManageUsers");

  const [reason, setReason] = useState<string>("");
  const [warningType, setWarningType] = useState<WarningType>("misconduct");
  const [expiresDays, setExpiresDays] = useState<number>(DEFAULT_WARNING_SETTINGS.expirationDays);
  const [isPermanent, setIsPermanent] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [settings, setSettings] = useState<WarningSettings>(DEFAULT_WARNING_SETTINGS);

  // Load global warning settings to pre-populate expiry default
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settingsRef = doc(firestore, "warningConfig", "global");
        const snap = await getDoc(settingsRef);
        if (snap.exists()) {
          const data = snap.data() as WarningSettings;
          setSettings(data);
          setExpiresDays(data.expirationDays ?? DEFAULT_WARNING_SETTINGS.expirationDays);
        }
      } catch {
        // Use defaults silently
      }
    };
    if (open) {
      setReason("");
      setWarningType("misconduct");
      setIsPermanent(false);
      loadSettings();
    }
  }, [open, firestore]);

  const handleTemplateChange = (val: string) => {
    if (val !== "custom") {
      setReason(val);
    }
  };

  const handleSave = async () => {
    if (!user?.uid || !canManageUsers) {
      toast({
        variant: "destructive",
        title: "Unauthorized",
        description: "You do not have permission to issue warnings.",
      });
      return;
    }
    if (!reason.trim()) {
      toast({
        variant: "destructive",
        title: "Reason required",
        description: "Please provide a warning reason.",
      });
      return;
    }

    const now = new Date();
    // If permanent, set expiry 100 years in the future
    const days = isPermanent ? 36500 : Math.max(1, Number(expiresDays || settings.expirationDays));
    const expiresAtDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    setSaving(true);
    try {
      // Write the warning to the subcollection
      const warningsRef = collection(firestore, "users", userUid, "warnings");
      await addDoc(warningsRef, {
        reason: reason.trim(),
        type: warningType,
        severity: "medium",
        notes: "",
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromDate(expiresAtDate),
        isActive: true,
        isPermanent: isPermanent,
        appealStatus: "none",
      });

      // Read current warning count to determine if blacklist threshold is met
      const userRef = doc(firestore, "users", userUid);
      const userSnap = await getDoc(userRef);
      const currentCount = (userSnap.data()?.warningCount as number) || 0;
      const newCount = currentCount + 1;
      const threshold =
        settings.blacklistThreshold ?? DEFAULT_WARNING_SETTINGS.blacklistThreshold;
      const shouldBlacklist = newCount >= threshold;

      const userUpdate: Record<string, unknown> = {
        warningCount: increment(1),
        updatedAt: serverTimestamp(),
      };

      if (shouldBlacklist) {
        userUpdate.isBlacklisted = true;
        userUpdate.blacklistReason = `Reached ${threshold} active warnings.`;
        userUpdate.blacklistedAt = serverTimestamp();
      }

      await updateDoc(userRef, userUpdate);

      toast({
        title: shouldBlacklist
          ? "⚠️ Warning Issued — User Blacklisted"
          : "Warning Issued",
        description: `Warning issued to ${userName || userUid}.${shouldBlacklist
            ? ` They have reached ${threshold} warnings and are now BLACKLISTED.`
            : ""
          }`,
      });
      onOpenChange(false);
    } catch (e) {
      console.error("Failed to issue warning", e);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to issue warning.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Issue Warning</DialogTitle>
          <DialogDescription>
            {userName ? (
              <>
                Issue a formal warning to{" "}
                <span className="font-medium">{userName}</span>.
              </>
            ) : (
              <>
                Issue a formal warning to user{" "}
                <span className="font-mono">{userUid}</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Warning Type & Templates row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="warning-type">Warning Type</Label>
              <Select
                value={warningType}
                onValueChange={(v) => setWarningType(v as WarningType)}
                disabled={!canManageUsers || saving}
              >
                <SelectTrigger id="warning-type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(WARNING_TYPE_LABELS) as [WarningType, string][]
                  ).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="warning-template">Quick Template</Label>
              <Select onValueChange={handleTemplateChange} disabled={!canManageUsers || saving}>
                <SelectTrigger id="warning-template">
                  <SelectValue placeholder="Custom Reason" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">-- Custom --</SelectItem>
                  {REASON_TEMPLATES.map((tmpl, idx) => (
                    <SelectItem key={idx} value={tmpl}>
                      {tmpl.substring(0, 30)}...
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="warning-reason">Detailed Reason</Label>
            <Textarea
              id="warning-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="Describe the reason for this warning…"
              disabled={!canManageUsers || saving}
            />
          </div>

          {/* Expiry and Permanent */}
          <div className="flex items-end gap-4 p-4 bg-muted/30 rounded-lg border">
            <div className="space-y-2 flex-grow">
              <Label htmlFor="warning-expires">
                Expires in (days)
              </Label>
              <Input
                id="warning-expires"
                type="number"
                min={1}
                value={String(expiresDays)}
                onChange={(e) => setExpiresDays(Number(e.target.value))}
                disabled={!canManageUsers || saving || isPermanent}
              />
            </div>
            <div className="flex items-center space-x-2 pb-[10px]">
              <Checkbox 
                id="permanent" 
                checked={isPermanent}
                onCheckedChange={(c) => setIsPermanent(!!c)}
                disabled={!canManageUsers || saving}
              />
              <Label htmlFor="permanent" className="text-destructive font-semibold cursor-pointer">
                Permanent Warning
              </Label>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Blacklist threshold: <strong>{settings.blacklistThreshold}</strong> active warnings.{' '}
            {!isPermanent ? `Global default expiry is ${settings.expirationDays} days.` : 'Permanent warnings do not expire organically.'}
          </p>

          {!canManageUsers && (
            <p className="text-sm text-red-600">
              You do not have permission to issue warnings.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !reason.trim() || !canManageUsers}
          >
            {saving ? "Saving…" : "Issue Warning"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
