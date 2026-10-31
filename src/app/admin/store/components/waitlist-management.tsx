"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/firebase";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

export const WAITLIST_SOURCE_LABELS: Record<string, string> = {
  product_page_oos: "Product page (out of stock)",
  product_page_rail: "Product page (also available)",
  store_search_empty: "Store search",
  order_confirmation: "Order confirmation",
};

export interface WaitlistEntry {
  id: string;
  productId: string | null;
  requestedText: string;
  searchQuery: string | null;
  contactName: string;
  contactPhone: string;
  source: string;
  status: string;
  createdAt: string | null;
}

const ACTIONS: Record<string, Array<{ status: string; label: string }>> = {
  open: [
    { status: "notified", label: "Mark notified" },
    { status: "fulfilled", label: "Mark fulfilled" },
    { status: "closed", label: "Close" },
  ],
  notified: [
    { status: "fulfilled", label: "Mark fulfilled" },
    { status: "closed", label: "Close" },
    { status: "open", label: "Reopen" },
  ],
  fulfilled: [{ status: "open", label: "Reopen" }],
  closed: [{ status: "open", label: "Reopen" }],
};

export function WaitlistManagement() {
  const { user } = useUser();
  const { toast } = useToast();
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (!user) return;
      try {
        const token = await user.getIdToken();
        const params = new URLSearchParams();
        if (statusFilter !== "all") params.set("status", statusFilter);
        if (cursor) params.set("cursor", cursor);
        const res = await fetch(`/api/store/waitlist?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Failed to load waitlist");
        setEntries((prev) => (cursor ? [...prev, ...data.entries] : data.entries));
        setNextCursor(data.hasMore ? data.nextCursor : null);
      } catch (e: any) {
        toast({ variant: "destructive", title: "Load failed", description: e.message });
      } finally {
        setLoading(false);
      }
    },
    [user, statusFilter, toast],
  );

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const changeStatus = async (entry: WaitlistEntry, status: string) => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/store/waitlist/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Update failed");
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, ...data.entry } : e)));
      toast({ title: "Waitlist updated", description: `Entry marked ${status}.` });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Update failed", description: e.message });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold">Waitlist</h2>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="notified">Notified</SelectItem>
            <SelectItem value="fulfilled">Fulfilled</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No waitlist entries yet. Entries appear when a buyer asks for a product that is not available.
          </CardContent>
        </Card>
      ) : (
        <>
          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardContent className="py-4 space-y-2">
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">{entry.requestedText}</p>
                    <p className="text-sm text-muted-foreground">
                      {WAITLIST_SOURCE_LABELS[entry.source] ?? entry.source}
                      {entry.productId ? ` · Product ${entry.productId.slice(0, 8)}` : ""}
                      {entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleDateString("en-GB")}` : ""}
                    </p>
                    {entry.searchQuery && <p className="text-sm text-muted-foreground">Searched for: {entry.searchQuery}</p>}
                    <p className="text-sm">
                      {entry.contactName} · {entry.contactPhone}
                    </p>
                  </div>
                  <Badge variant="secondary">{entry.status}</Badge>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {(ACTIONS[entry.status] ?? []).map((a) => (
                    <Button key={a.status} size="sm" variant="outline" onClick={() => changeStatus(entry, a.status)}>
                      {a.label}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
          {nextCursor && (
            <Button variant="outline" onClick={() => load(nextCursor)}>
              Load more
            </Button>
          )}
        </>
      )}
    </div>
  );
}
