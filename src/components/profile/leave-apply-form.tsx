"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useUserContext } from "@/firebase/user-provider";
import { UserSelectionCombobox } from "@/components/admin/user-selection-combobox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * LeaveApplyForm
 *
 * Member-facing leave apply form. All writes go through POST /api/leave.
 * This component makes no direct Firestore writes and never flips any
 * vacation flag. Leave approval, flag setting, redirect-out, and return
 * are server-side flows owned by other slices.
 *
 * Cancelling a still-pending request also goes through POST /api/leave,
 * with body { action: 'cancel', id }. The server only allows the owner to
 * cancel, and only from status 'pending'.
 *
 * Intended mount: on the own-profile page near the VacationToggle mount
 * in src/components/profile/optimized-profile.tsx, or on its own route
 * such as /profile/leave. See NOTES.md for the mount snippet.
 */

export type LeaveType = "annual" | "sick" | "emergency" | "exam" | "personal";

export type LeaveRequest = {
  id: string;
  leaveType: LeaveType | string;
  startDate: string;
  endDate: string;
  reason: string;
  status: string;
  coveringOfficerId?: string | null;
  coveringOfficerName?: string | null;
  notes?: string | null;
  createdAt?: unknown;
};

export type LeaveApplyFormProps = {
  className?: string;
};

const LEAVE_TYPES: Array<{ value: LeaveType; label: string }> = [
  { value: "annual", label: "Annual leave" },
  { value: "sick", label: "Sick leave" },
  { value: "emergency", label: "Emergency leave" },
  { value: "exam", label: "Exam leave" },
  { value: "personal", label: "Personal leave" },
];

const LEAVE_TYPE_LABELS: Record<string, string> = {
  annual: "Annual leave",
  sick: "Sick leave",
  emergency: "Emergency leave",
  exam: "Exam leave",
  personal: "Personal leave",
};

const REASON_MAX_LENGTH = 500;
const COVERING_OFFICER_REQUIRED_AFTER_DAYS = 3;

function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function inclusiveDays(startValue: string, endValue: string): number | null {
  const start = parseLocalDate(startValue);
  const end = parseLocalDate(endValue);
  if (!start || !end) return null;
  const diffMs = end.getTime() - start.getTime();
  if (diffMs < 0) return null;
  return Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

function formatDate(value: string): string {
  const parsed = parseLocalDate(value);
  if (!parsed) return value || "Not set";
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatLeaveType(value: string): string {
  return LEAVE_TYPE_LABELS[value] || value || "Leave";
}

function statusBadgeClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "approved") return "bg-green-500/15 text-green-500 border-green-500/20";
  if (normalized === "rejected") return "bg-red-500/15 text-red-500 border-red-500/20";
  if (normalized === "pending") return "bg-amber-500/15 text-amber-500 border-amber-500/20";
  if (normalized === "completed") return "bg-blue-500/15 text-blue-500 border-blue-500/20";
  return "bg-muted text-muted-foreground border-border";
}

function normalizeRequests(data: unknown): LeaveRequest[] {
  if (Array.isArray(data)) return data as LeaveRequest[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.requests)) return record.requests as LeaveRequest[];
    if (Array.isArray(record.leaveRequests)) return record.leaveRequests as LeaveRequest[];
    if (Array.isArray(record.leaves)) return record.leaves as LeaveRequest[];
    if (Array.isArray(record.data)) return record.data as LeaveRequest[];
  }
  return [];
}

/** Pull the API error text verbatim. Falls back only when the API sent no message. */
function extractApiErrorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) return record.error;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  }
  return `Request failed with status ${status}.`;
}

export function LeaveApplyForm({ className }: LeaveApplyFormProps) {
  const { user: currentUser, isLoading: userLoading } = useUserContext();

  const [leaveType, setLeaveType] = useState<LeaveType>("annual");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [coveringOfficerId, setCoveringOfficerId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const todayString = useMemo(() => toLocalDateString(new Date()), []);
  const leaveDays = useMemo(() => inclusiveDays(startDate, endDate), [startDate, endDate]);
  const coveringRequired = leaveDays !== null && leaveDays > COVERING_OFFICER_REQUIRED_AFTER_DAYS;

  const fetchRequests = useCallback(async () => {
    if (!currentUser) {
      setRequests([]);
      setListLoading(false);
      return;
    }
    setListLoading(true);
    setListError(null);
    try {
      const idToken = await currentUser.getIdToken(false);
      const res = await fetch("/api/leave", {
        method: "GET",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setListError(extractApiErrorMessage(data, res.status));
        setRequests([]);
        return;
      }
      setRequests(normalizeRequests(data));
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load your leave requests.");
      setRequests([]);
    } finally {
      setListLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (userLoading) return;
    fetchRequests();
  }, [userLoading, fetchRequests]);

  async function handleCancelRequest(id: string) {
    if (!currentUser || cancellingId) return;
    setCancelError(null);
    setCancellingId(id);
    try {
      const idToken = await currentUser.getIdToken(false);
      const res = await fetch("/api/leave", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "cancel", id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // API error text is shown verbatim, never paraphrased.
        setCancelError(extractApiErrorMessage(data, res.status));
        return;
      }
      // The server confirmed the cancel. Mirror the returned status
      // locally so the badge and actions update without a refetch flash.
      setRequests((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status: "cancelled" } : item))
      );
      setConfirmCancelId(null);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Failed to cancel your leave request.");
    } finally {
      setCancellingId(null);
    }
  }

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};

    if (!LEAVE_TYPES.some((t) => t.value === leaveType)) {
      errors.leaveType = "Please select a valid leave type.";
    }

    const start = parseLocalDate(startDate);
    if (!startDate) {
      errors.startDate = "Start date is required.";
    } else if (!start) {
      errors.startDate = "Start date is not a valid date.";
    } else if (startDate < todayString) {
      errors.startDate = "Start date cannot be in the past.";
    }

    const end = parseLocalDate(endDate);
    if (!endDate) {
      errors.endDate = "End date is required.";
    } else if (!end) {
      errors.endDate = "End date is not a valid date.";
    } else if (start && end < start) {
      errors.endDate = "End date must be on or after the start date.";
    }

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      errors.reason = "Reason is required.";
    } else if (trimmedReason.length > REASON_MAX_LENGTH) {
      errors.reason = `Reason must be ${REASON_MAX_LENGTH} characters or fewer.`;
    }

    if (coveringOfficerId && currentUser && coveringOfficerId === currentUser.uid) {
      errors.coveringOfficerId = "Covering officer cannot be yourself.";
    }

    const days = inclusiveDays(startDate, endDate);
    if (days !== null && days > COVERING_OFFICER_REQUIRED_AFTER_DAYS && !coveringOfficerId) {
      errors.coveringOfficerId = `A covering officer is required for leaves longer than ${COVERING_OFFICER_REQUIRED_AFTER_DAYS} days.`;
    }

    return errors;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    if (!currentUser) {
      setFormError("Please sign in to apply for leave.");
      return;
    }

    setSubmitting(true);
    try {
      const idToken = await currentUser.getIdToken(false);
      const res = await fetch("/api/leave", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          leaveType,
          startDate,
          endDate,
          reason: reason.trim(),
          coveringOfficerId: coveringOfficerId || null,
          notes: notes.trim() ? notes.trim() : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // API error text is shown verbatim, never paraphrased.
        setFormError(extractApiErrorMessage(data, res.status));
        return;
      }

      const created = (data as Record<string, unknown>).request
        || (data as Record<string, unknown>).leaveRequest
        || (data as Record<string, unknown>).leave
        || data;
      const createdStatus =
        created && typeof created === "object" && typeof (created as Record<string, unknown>).status === "string"
          ? String((created as Record<string, unknown>).status)
          : "pending";
      setSuccessMessage(`Leave request submitted. Status: ${createdStatus}.`);

      setLeaveType("annual");
      setStartDate("");
      setEndDate("");
      setReason("");
      setCoveringOfficerId(null);
      setNotes("");
      setFieldErrors({});

      await fetchRequests();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to submit your leave request.");
    } finally {
      setSubmitting(false);
    }
  }

  if (userLoading) {
    return (
      <Card className={className}>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">Loading leave form...</p>
        </CardContent>
      </Card>
    );
  }

  if (!currentUser) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Apply for leave</CardTitle>
          <CardDescription>Please sign in to apply for leave.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className={cn("space-y-6", className)}>
      <Card>
        <CardHeader>
          <CardTitle>Apply for leave</CardTitle>
          <CardDescription>
            Submit a leave request for review. Approval is handled by an admin. This form does not
            change your availability status on its own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="leave-type">Leave type</Label>
                <select
                  id="leave-type"
                  value={leaveType}
                  onChange={(e) => setLeaveType(e.target.value as LeaveType)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {LEAVE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {fieldErrors.leaveType && (
                  <p className="text-xs text-destructive" role="alert">{fieldErrors.leaveType}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="leave-start-date">Start date</Label>
                <Input
                  id="leave-start-date"
                  type="date"
                  value={startDate}
                  min={todayString}
                  onChange={(e) => setStartDate(e.target.value)}
                />
                {fieldErrors.startDate && (
                  <p className="text-xs text-destructive" role="alert">{fieldErrors.startDate}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="leave-end-date">End date</Label>
                <Input
                  id="leave-end-date"
                  type="date"
                  value={endDate}
                  min={startDate || todayString}
                  onChange={(e) => setEndDate(e.target.value)}
                />
                {fieldErrors.endDate && (
                  <p className="text-xs text-destructive" role="alert">{fieldErrors.endDate}</p>
                )}
              </div>
            </div>

            {leaveDays !== null && (
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Leave length: {leaveDays} {leaveDays === 1 ? "day" : "days"}.
                {coveringRequired
                  ? " A covering officer is required for this leave."
                  : " A covering officer is optional for this leave."}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="leave-reason">Reason</Label>
              <Textarea
                id="leave-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX_LENGTH))}
                placeholder="Why do you need this leave?"
                rows={4}
                maxLength={REASON_MAX_LENGTH}
                aria-describedby="leave-reason-count"
              />
              <div className="flex items-center justify-between">
                <p id="leave-reason-count" className="text-xs text-muted-foreground">
                  {reason.length}/{REASON_MAX_LENGTH} characters
                </p>
                {fieldErrors.reason && (
                  <p className="text-xs text-destructive" role="alert">{fieldErrors.reason}</p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="leave-covering-officer">
                  Covering officer {coveringRequired ? "(required)" : "(optional)"}
                </Label>
                {coveringOfficerId && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-2 py-1 text-xs"
                    onClick={() => setCoveringOfficerId(null)}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <UserSelectionCombobox
                onSelect={(uid) => setCoveringOfficerId(uid)}
                selectedUid={coveringOfficerId}
                placeholder="Select a covering officer"
                filterFn={(u) => !currentUser || u.uid !== currentUser.uid}
              />
              <p className="text-xs text-muted-foreground">
                A covering officer is required for leaves longer than 3 days. Pick someone who can
                cover your work while you are away. People who are already on leave cannot be picked.
              </p>
              {fieldErrors.coveringOfficerId && (
                <p className="text-xs text-destructive" role="alert">{fieldErrors.coveringOfficerId}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="leave-notes">Notes (optional)</Label>
              <Textarea
                id="leave-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the reviewer should know, such as handover details."
                rows={3}
              />
            </div>

            {formError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2" role="alert">
                <p className="text-sm text-destructive">{formError}</p>
              </div>
            )}

            {successMessage && (
              <div className="rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2" role="status">
                <p className="text-sm text-green-600 dark:text-green-400">{successMessage}</p>
              </div>
            )}

            <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
              {submitting ? "Submitting..." : "Submit leave request"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your leave requests</CardTitle>
          <CardDescription>Your own requests, newest first when the API returns them in that order.</CardDescription>
        </CardHeader>
        <CardContent>
          {listLoading ? (
            <p className="text-sm text-muted-foreground">Loading your leave requests...</p>
          ) : listError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2" role="alert">
              <p className="text-sm text-destructive">{listError}</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={fetchRequests}>
                Try again
              </Button>
            </div>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">You have no leave requests yet.</p>
          ) : (
            <ul className="space-y-3">
              {requests.map((item) => (
                <li key={item.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold">{formatLeaveType(String(item.leaveType))}</p>
                    <Badge variant="outline" className={statusBadgeClass(String(item.status || ""))}>
                      {String(item.status || "pending")}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatDate(String(item.startDate))} to {formatDate(String(item.endDate))}
                  </p>
                  <p className="mt-1 text-sm">
                    Covering officer: {item.coveringOfficerName || item.coveringOfficerId || "None assigned"}
                  </p>
                  {item.reason && (
                    <p className="mt-2 text-sm text-muted-foreground">{item.reason}</p>
                  )}
                  {String(item.status || "").toLowerCase() === "pending" &&
                    (confirmCancelId === item.id ? (
                      <div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
                        <p className="text-sm">
                          Cancel this leave request? It will be withdrawn and will not be reviewed.
                        </p>
                        {cancelError && (
                          <p className="mt-2 text-sm text-destructive" role="alert">{cancelError}</p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={cancellingId === item.id}
                            onClick={() => handleCancelRequest(item.id)}
                          >
                            {cancellingId === item.id ? "Cancelling..." : "Yes, cancel request"}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={cancellingId === item.id}
                            onClick={() => {
                              setConfirmCancelId(null);
                              setCancelError(null);
                            }}
                          >
                            Keep request
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setCancelError(null);
                            setConfirmCancelId(item.id);
                          }}
                        >
                          Cancel request
                        </Button>
                      </div>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default LeaveApplyForm;
