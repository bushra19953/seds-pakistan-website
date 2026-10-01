"use client";
import React from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { format, parse, isValid as isValidDate } from "date-fns";

const announcementSchema = z.object({
  title: z.string().min(3, "Title is required").max(120),
  content: z.string().min(1, "Content is required"),
  audience: z.enum(["all", "members", "team_leaders"]).default("all"),
  status: z.enum(["draft", "published"]).default("draft"),
  publish_date: z.string().optional(),
  slug: z.string().optional(),
  meta_title: z.string().optional(),
  meta_description: z.string().optional(),
  keywords: z.string().optional(),
  isFeatured: z.boolean().optional(),
  ctaText: z.string().optional(),
  ctaLink: z.string().url("Provide a valid URL").optional(),
  ctaExpiredText: z.string().optional(),
  // Precise expiration as a Date; allow undefined to represent "no expiry"
  expiresAt: z.date().optional(),
  priority: z.number().int().min(0).optional().default(0),
});

export type AnnouncementFormValues = z.infer<typeof announcementSchema>;

interface AnnouncementFormProps {
  initial?: Partial<AnnouncementFormValues>;
  onSubmit: (values: AnnouncementFormValues) => Promise<void> | void;
  onCancel?: () => void;
}

export default function AnnouncementForm({ initial, onSubmit, onCancel }: AnnouncementFormProps) {
  // Helper: coerce any incoming initial value to a Date
  const toDateOrUndefined = (val: any): Date | undefined => {
    try {
      if (!val) return undefined;
      if (val instanceof Date) return isValidDate(val) ? val : undefined;
      if (typeof val === "string") {
        // Accept ISO or yyyy-MM-dd
        const isoTry = new Date(val);
        if (!isNaN(isoTry.getTime())) return isoTry;
        const ymdTry = parse(val, "yyyy-MM-dd", new Date());
        return isValidDate(ymdTry) ? ymdTry : undefined;
      }
      if (typeof val === "object" && typeof val.toDate === "function") {
        const d = val.toDate();
        return isValidDate(d) ? d : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const form = useForm<AnnouncementFormValues>({
    resolver: zodResolver(announcementSchema),
    defaultValues: {
      title: initial?.title || "",
      content: initial?.content || "",
      audience: initial?.audience || "all",
      status: initial?.status || "draft",
      publish_date: initial?.publish_date || "",
      slug: initial?.slug || "",
      meta_title: initial?.meta_title || "",
      meta_description: initial?.meta_description || "",
      keywords: initial?.keywords || "",
      isFeatured: initial?.isFeatured ?? false,
      ctaText: initial?.ctaText || "",
      ctaLink: initial?.ctaLink || "",
      ctaExpiredText: initial?.ctaExpiredText || "",
      // Normalize initial.expiresAt into a Date if provided
      expiresAt: toDateOrUndefined(initial?.expiresAt),
      priority: initial?.priority ?? 0,
    },
  });

  // Local UI state for time inputs next to date picker
  const initialExpires = form.getValues("expiresAt");
  const [expiresDateStr, setExpiresDateStr] = React.useState<string>(
    initialExpires ? format(initialExpires, "yyyy-MM-dd") : ""
  );
  const [expiresHour, setExpiresHour] = React.useState<string>(
    initialExpires ? String(initialExpires.getHours()).padStart(2, "0") : ""
  );
  const [expiresMinute, setExpiresMinute] = React.useState<string>(
    initialExpires ? String(initialExpires.getMinutes()).padStart(2, "0") : ""
  );

  // Utility: combine date string + hour/minute into a single Date
  const combineDateAndTime = React.useCallback(
    (dateStr: string, hourStr: string, minuteStr: string): Date | undefined => {
      if (!dateStr) return undefined;
      const base = parse(dateStr, "yyyy-MM-dd", new Date());
      if (!isValidDate(base)) return undefined;
      const h = Math.min(23, Math.max(0, Number(hourStr))); // defaults to 0 if NaN
      const m = Math.min(59, Math.max(0, Number(minuteStr)));
      base.setHours(isNaN(h) ? 0 : h, isNaN(m) ? 0 : m, 0, 0);
      return base;
    },
    []
  );

  // Keep RHF value in sync when any of the three parts change
  const updateExpiresAt = React.useCallback(
    (nextDateStr: string, nextHour: string, nextMinute: string) => {
      const combined = combineDateAndTime(nextDateStr, nextHour, nextMinute);
      form.setValue("expiresAt", combined, { shouldDirty: true });
    },
    [combineDateAndTime, form]
  );

  const handleSubmit = (values: AnnouncementFormValues) => {
    return onSubmit(values);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
              <FormControl>
                <Input placeholder="Announcement title" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="content"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Content</FormLabel>
              <FormControl>
                <Textarea rows={5} placeholder="Announcement content" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="audience"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Audience</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select audience" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="members">Members</SelectItem>
                    <SelectItem value="team_leaders">Team Leaders</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="published">Published</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="publish_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Publish Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="expiresAt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Expires At</FormLabel>
                <div className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-6">
                    <FormControl>
                      <Input
                        type="date"
                        value={expiresDateStr}
                        onChange={(e) => {
                          const next = e.target.value;
                          setExpiresDateStr(next);
                          updateExpiresAt(next, expiresHour, expiresMinute);
                        }}
                      />
                    </FormControl>
                  </div>
                  <div className="col-span-3">
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={23}
                        placeholder="HH"
                        value={expiresHour}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const clamped = raw === "" ? "" : String(Math.min(23, Math.max(0, Number(raw))));
                          setExpiresHour(clamped);
                          if (expiresDateStr) updateExpiresAt(expiresDateStr, clamped, expiresMinute);
                        }}
                      />
                    </FormControl>
                  </div>
                  <div className="col-span-3">
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={59}
                        placeholder="MM"
                        value={expiresMinute}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const clamped = raw === "" ? "" : String(Math.min(59, Math.max(0, Number(raw))));
                          setExpiresMinute(clamped);
                          if (expiresDateStr) updateExpiresAt(expiresDateStr, expiresHour, clamped);
                        }}
                      />
                    </FormControl>
                  </div>
                </div>
                <FormDescription>
                  Choose a date and optionally set hour and minute. Empty time defaults to 00:00.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="isFeatured"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 col-span-1">
                <FormLabel className="text-sm">Feature on homepage</FormLabel>
                <FormControl>
                  <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="priority"
            render={({ field }) => (
              <FormItem className="col-span-1">
                <FormLabel>Priority (Lower displays first)</FormLabel>
                <FormControl>
                  <Input type="number" min="0" {...field} onChange={e => field.onChange(parseInt(e.target.value) || 0)} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
              <FormItem className="col-span-1">
                <FormLabel>Slug</FormLabel>
                <FormControl>
                  <Input placeholder="optional-slug" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="meta_title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Meta Title</FormLabel>
                <FormControl>
                  <Input placeholder="Optional SEO title" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="keywords"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Keywords</FormLabel>
                <FormControl>
                  <Input placeholder="comma,separated,keywords" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="meta_description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Meta Description</FormLabel>
              <FormControl>
                <Textarea rows={3} placeholder="Optional SEO description" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="ctaText"
            render={({ field }) => (
              <FormItem>
                <FormLabel>CTA Text</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., Apply Now" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="ctaLink"
            render={({ field }) => (
              <FormItem>
                <FormLabel>CTA Link</FormLabel>
                <FormControl>
                  <Input placeholder="https://example.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="ctaExpiredText"
            render={({ field }) => (
              <FormItem>
                <FormLabel>CTA Expired Text</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., Applications Closed" {...field} />
                </FormControl>
                <FormDescription>Shown when the announcement has passed its expiry.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end gap-3">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit">Save changes</Button>
        </div>
      </form>
    </Form>
  );
}