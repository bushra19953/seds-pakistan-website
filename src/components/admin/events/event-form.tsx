'use client';

import { useMemo, useState, useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { cn } from '@/lib/utils';

import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCollection } from '@/firebase';
import { collection, query, where } from 'firebase/firestore';
import { firestore } from '@/firebase';
import type { EventDoc, StrategicFraming } from '@/types/event';
import ImageUploader from '@/components/admin/image-uploader';
import Image from 'next/image';
import { X, Plus, Move, Type, Palette, Maximize2, Link2 } from 'lucide-react';
import TicketAlignmentEditor from './ticket-alignment-editor';

/**
 * Zod Schema: Event Form (partial)
 * - Focuses on Strategic Framing and includes the new `mindsetFraming` object
 * - All fields remain optional to be Spark Plan–friendly
 */
const emotionalFramingSchema = z
  .object({
    costOfInactionStatement: z.string().optional().or(z.literal('')),
    freedomMetricsStatement: z.string().optional().or(z.literal('')),
    socialImpactStatement: z.string().optional().or(z.literal('')),
  })
  .optional();

/**
 * NEW: Mindset & Philosophical Framing schema with optional strings
 * - characterAmplifierStatement
 * - contributionCapacityStatement
 * - actionOverCriticismStatement
 */
const mindsetFramingSchema = z
  .object({
    characterAmplifierStatement: z.string().optional().or(z.literal('')),
    contributionCapacityStatement: z.string().optional().or(z.literal('')),
    actionOverCriticismStatement: z.string().optional().or(z.literal('')),
  })
  .optional();

const strategicFramingSchema = z
  .object({
    lifestyleTargetHeadline: z.string().optional().or(z.literal('')),
    // Single text input transformed to array on submit
    lifestyleTargetExamplesInput: z.string().optional().or(z.literal('')),
    incomeVehicleStatement: z.string().optional().or(z.literal('')),
    dailyActionExample: z.string().optional().or(z.literal('')),
    emotionalFraming: emotionalFramingSchema,
    mindsetFraming: mindsetFramingSchema, // NEW: wired into schema
  })
  .optional();

export const eventFormSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional().or(z.literal('')),
  valueProposition: z.string().optional().or(z.literal('')),
  catalystStatement: z.string().optional().or(z.literal('')),
  lifestyleOutcome: z.string().optional().or(z.literal('')),
  location: z.string().optional().or(z.literal('')),
  startDate: z.string().optional().or(z.literal('')),
  endDate: z.string().optional().or(z.literal('')),
  // Unified admin fields
  type: z.enum(['event', 'workshop', 'webinar']).optional(),
  status: z.enum(['draft', 'scheduled', 'published', 'archived']).optional(),
  visibility: z.enum(['public', 'members', 'private']).optional(),
  isOnline: z.boolean().optional(),
  venue: z.string().optional().or(z.literal('')),
  mapUrl: z.string().optional().or(z.literal('')),
  tagsInput: z.string().optional().or(z.literal('')),
  capacityInput: z.string().optional().or(z.literal('')),
  registrationOpen: z.boolean().optional(),
  imageUrl: z.string().optional().or(z.literal('')),
  ticketImageUrl: z.string().optional().or(z.literal('')),
  ticketBackImageUrl: z.string().optional().or(z.literal('')),
  // Payment details
  isPaid: z.boolean().optional(),
  amountInput: z.string().optional().or(z.literal('')),
  currency: z.string().optional().or(z.literal('')),
  method: z.string().optional().or(z.literal('')),
  instructions: z.string().optional().or(z.literal('')),
  qrCodeUrl: z.string().optional().or(z.literal('')),
  productId: z.string().optional().or(z.literal('')),
  registrationDeadline: z.string().optional().or(z.literal('')),
  strategicFraming: strategicFramingSchema,
  // Ticket Branding
  ticketAssets: z.object({
    frontUrl: z.string().optional().or(z.literal('')),
    backUrl: z.string().optional().or(z.literal('')),
  }).optional(),
  ticketConfig: z.object({
    frontOverlays: z.record(z.any()).optional(),
    backOverlays: z.record(z.any()).optional(),
    lookFeel: z.object({
      theme: z.string().optional(),
      texture: z.string().optional(),
      atmosphere: z.string().optional(),
    }).optional(),
  }).optional(),
});

export type EventFormValues = z.infer<typeof eventFormSchema>;

export interface EventFormProps {
  className?: string;
  initialData?: Partial<EventDoc>;
  defaultValues?: Partial<EventFormValues>;
  onSubmit?: (payload: EventFormSubmitPayload) => Promise<void> | void;
  submitLabel?: string;
}

/**
 * Submit payload: EventDoc fields plus the raw string dates.
 * The parent pages read startDate/endDate and convert them to
 * Firestore Timestamps (startAt/endAt) before writing.
 */
export type EventFormSubmitPayload = Partial<EventDoc> & {
  startDate?: string;
  endDate?: string;
};

function buildStrategicFramingPayload(values: EventFormValues): StrategicFraming | undefined {
  const sf = values.strategicFraming;
  if (!sf) return undefined;

  const exList = (sf.lifestyleTargetExamplesInput || '')
    .split(/\r?\n|,/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);

  const payload: StrategicFraming = {};
  if (sf.lifestyleTargetHeadline) payload.lifestyleTargetHeadline = sf.lifestyleTargetHeadline;
  if (exList.length > 0) payload.lifestyleTargetExamples = exList;
  if (sf.incomeVehicleStatement) payload.incomeVehicleStatement = sf.incomeVehicleStatement;
  if (sf.dailyActionExample) payload.dailyActionExample = sf.dailyActionExample;

  const ef = sf.emotionalFraming || {};
  const efPayload: NonNullable<StrategicFraming['emotionalFraming']> = {};
  if (ef.costOfInactionStatement) efPayload.costOfInactionStatement = ef.costOfInactionStatement;
  if (ef.freedomMetricsStatement) efPayload.freedomMetricsStatement = ef.freedomMetricsStatement;
  if (ef.socialImpactStatement) efPayload.socialImpactStatement = ef.socialImpactStatement;
  if (Object.keys(efPayload).length > 0) payload.emotionalFraming = efPayload;

  const mf = sf.mindsetFraming || {};
  const mfPayload: NonNullable<StrategicFraming['mindsetFraming']> = {};
  // NEW: Mindset & Philosophical payload mapping
  if (mf.characterAmplifierStatement) mfPayload.characterAmplifierStatement = mf.characterAmplifierStatement;
  if (mf.contributionCapacityStatement) mfPayload.contributionCapacityStatement = mf.contributionCapacityStatement;
  if (mf.actionOverCriticismStatement) mfPayload.actionOverCriticismStatement = mf.actionOverCriticismStatement;
  if (Object.keys(mfPayload).length > 0) payload.mindsetFraming = mfPayload;

  return Object.keys(payload).length > 0 ? payload : undefined;
}

/**
 * Static base defaults for the event form.
 * Hoisted out of the useMemo object literal: explicit props must not precede
 * override spreads in the same literal (TS2783), so the base lives here and
 * the memo only spreads (...base, ...defaultValues, ...initialData).
 */
const baseEventFormDefaults: EventFormValues = {
  title: '',
  description: '',
  valueProposition: '',
  catalystStatement: '',
  lifestyleOutcome: '',
  location: '',
  startDate: '',
  endDate: '',
  type: 'event',
  status: 'draft',
  visibility: 'public',
  isOnline: false,
  venue: '',
  mapUrl: '',
  tagsInput: '',
  capacityInput: '',
  registrationOpen: false,
  imageUrl: '',
  ticketImageUrl: '',
  isPaid: false,
  amountInput: '',
  currency: 'USD',
  method: '',
  instructions: '',
  qrCodeUrl: '',
  productId: '',
  registrationDeadline: '',
  strategicFraming: {
    lifestyleTargetHeadline: '',
    lifestyleTargetExamplesInput: '',
    incomeVehicleStatement: '',
    dailyActionExample: '',
    emotionalFraming: {
      costOfInactionStatement: '',
      freedomMetricsStatement: '',
      socialImpactStatement: '',
    },
    mindsetFraming: {
      characterAmplifierStatement: '',
      contributionCapacityStatement: '',
      actionOverCriticismStatement: '',
    },
  },
};

export default function EventForm({ className, initialData, defaultValues, onSubmit, submitLabel = 'Save' }: EventFormProps) {
  const [showFrontEditor, setShowFrontEditor] = useState(false);
  const [showBackEditor, setShowBackEditor] = useState(false);
  const [isDraftSaved, setIsDraftSaved] = useState(false);

  // Fetch all active products for linking
  const productsQuery = useMemo(
    () => query(collection(firestore, 'products'), where('isActive', '==', true)),
    []
  );
  const { data: products } = useCollection(productsQuery, { listen: false });
  const eventProducts = (products || []).filter((p: any) => p.category === 'event-ticket' || p.category === 'event');

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: useMemo(() => ({
      ...baseEventFormDefaults,
      ...(defaultValues || {}),
      ...(initialData
        ? {
          title: initialData.title || '',
          description: initialData.description || '',
          valueProposition: initialData.valueProposition || '',
          catalystStatement: initialData.catalystStatement || '',
          lifestyleOutcome: initialData.lifestyleOutcome || '',
          location: initialData.location || '',
          startDate: initialData.startAt ? initialData.startAt.toDate().toISOString().slice(0, 10) : '',
          endDate: initialData.endAt ? initialData.endAt.toDate().toISOString().slice(0, 10) : '',
          type: initialData.type || 'event',
          status: initialData.status || 'draft',
          visibility: initialData.visibility || 'public',
          isOnline: initialData.isOnline || false,
          venue: initialData.venue || '',
          mapUrl: initialData.mapUrl || '',
          tagsInput: Array.isArray(initialData.tags) ? initialData.tags.join(', ') : '',
          capacityInput: typeof initialData.capacity === 'number' ? String(initialData.capacity) : '',
          registrationOpen: initialData.registrationOpen || false,
          imageUrl: initialData.imageUrl || '',
          ticketImageUrl: initialData.ticketImageUrl || '',
          ticketBackImageUrl: initialData.ticketBackImageUrl || '',
          isPaid: !!initialData.paymentDetails?.isPaid,
          amountInput: typeof initialData.paymentDetails?.amount === 'number' ? String(initialData.paymentDetails!.amount) : '',
          currency: initialData.paymentDetails?.currency || 'USD',
          method: initialData.paymentDetails?.method || '',
          instructions: initialData.paymentDetails?.instructions || '',
          qrCodeUrl: initialData.paymentDetails?.qrCodeUrl || '',
          productId: (initialData as any)?.productId || '',
          registrationDeadline: (initialData as any)?.registrationDeadline
            ? (() => { try { const d = (initialData as any).registrationDeadline; const dt = d?.toDate ? d.toDate() : new Date(d); return dt.toISOString().slice(0, 16); } catch { return ''; } })()
            : '',
          strategicFraming: {
            lifestyleTargetHeadline: initialData.strategicFraming?.lifestyleTargetHeadline || '',
            lifestyleTargetExamplesInput: Array.isArray(initialData.strategicFraming?.lifestyleTargetExamples)
              ? (initialData.strategicFraming!.lifestyleTargetExamples || []).join('\n')
              : '',
            incomeVehicleStatement: initialData.strategicFraming?.incomeVehicleStatement || '',
            dailyActionExample: initialData.strategicFraming?.dailyActionExample || '',
            emotionalFraming: {
              costOfInactionStatement: initialData.strategicFraming?.emotionalFraming?.costOfInactionStatement || '',
              freedomMetricsStatement: initialData.strategicFraming?.emotionalFraming?.freedomMetricsStatement || '',
              socialImpactStatement: initialData.strategicFraming?.emotionalFraming?.socialImpactStatement || '',
            },
            mindsetFraming: {
              characterAmplifierStatement: initialData.strategicFraming?.mindsetFraming?.characterAmplifierStatement || '',
              contributionCapacityStatement: initialData.strategicFraming?.mindsetFraming?.contributionCapacityStatement || '',
              actionOverCriticismStatement: initialData.strategicFraming?.mindsetFraming?.actionOverCriticismStatement || '',
            },
          },
          ticketAssets: {
            frontUrl: initialData.ticketAssets?.frontUrl || '',
            backUrl: initialData.ticketAssets?.backUrl || '',
          },
          ticketConfig: {
            frontOverlays: initialData.ticketConfig?.frontOverlays || initialData.ticketConfig?.overlays || {
              name: { x: 50, y: 50, size: 24, color: '#FFFFFF', enabled: true },
              ticketNum: { x: 50, y: 60, size: 16, color: '#AAAAAA', enabled: true },
              email: { x: 50, y: 70, size: 16, color: '#AAAAAA', enabled: false },
              eventTitle: { x: 50, y: 30, size: 28, color: '#FFFFFF', enabled: false },
              eventDate: { x: 50, y: 35, size: 16, color: '#FFFFFF', enabled: false },
              eventVenue: { x: 50, y: 40, size: 16, color: '#FFFFFF', enabled: false },
              logo: { x: 10, y: 10, size: 40, enabled: false },
              orgName: { x: 20, y: 10, size: 14, color: '#FFFFFF', enabled: false },
              orgTagline: { x: 20, y: 13, size: 10, color: '#AAAAAA', enabled: false },
              issuedDate: { x: 50, y: 90, size: 10, color: '#AAAAAA', enabled: false },
              statusBadge: { x: 50, y: 85, size: 16, enabled: false },
              paymentRef: { x: 10, y: 80, size: 10, color: '#AAAAAA', enabled: false },
              verificationUrl: { x: 10, y: 75, size: 10, color: '#4F46E5', enabled: false },
              disclaimer: { x: 50, y: 95, size: 8, color: '#64748B', enabled: false },
              qrCode: { x: 80, y: 80, size: 100, enabled: true },
            },
            backOverlays: initialData.ticketConfig?.backOverlays || {
              name: { x: 50, y: 80, size: 16, color: '#FFFFFF', enabled: false },
              ticketNum: { x: 50, y: 85, size: 14, color: '#AAAAAA', enabled: false },
              email: { x: 50, y: 90, size: 12, color: '#AAAAAA', enabled: false },
              eventTitle: { x: 50, y: 10, size: 24, color: '#FFFFFF', enabled: false },
              eventDate: { x: 50, y: 15, size: 14, color: '#FFFFFF', enabled: false },
              eventVenue: { x: 50, y: 20, size: 14, color: '#FFFFFF', enabled: false },
              logo: { x: 10, y: 10, size: 40, enabled: false },
              orgName: { x: 20, y: 10, size: 14, color: '#FFFFFF', enabled: false },
              orgTagline: { x: 20, y: 13, size: 10, color: '#AAAAAA', enabled: false },
              issuedDate: { x: 50, y: 90, size: 10, color: '#AAAAAA', enabled: false },
              statusBadge: { x: 50, y: 85, size: 16, enabled: false },
              paymentRef: { x: 10, y: 80, size: 10, color: '#AAAAAA', enabled: false },
              verificationUrl: { x: 10, y: 75, size: 10, color: '#4F46E5', enabled: false },
              disclaimer: { x: 50, y: 95, size: 8, color: '#64748B', enabled: false },
              qrCode: { x: 50, y: 50, size: 140, enabled: true },
            },
            lookFeel: initialData.ticketConfig?.lookFeel || {
              theme: 'Dark Nebula',
              texture: 'None',
              atmosphere: '',
            },
          },
        }
        : {
          ticketAssets: { frontUrl: '', backUrl: '' },
          ticketConfig: {
            frontOverlays: {
              name: { x: 50, y: 50, size: 24, color: '#FFFFFF', enabled: true },
              ticketNum: { x: 50, y: 60, size: 16, color: '#AAAAAA', enabled: true },
              qrCode: { x: 80, y: 80, size: 100, enabled: true },
            },
            backOverlays: {
              qrCode: { x: 80, y: 80, size: 100, enabled: false },
            },
            lookFeel: { theme: 'Dark Nebula', texture: 'None', atmosphere: '' },
          },
        }),
    }), [defaultValues, initialData]),
  });

  // Draft Persistence Logic (v29.1 Fix My Shit Upgrade)
  const draftKey = useMemo(() => {
    if ((initialData as any)?.id) return `seds_event_draft_${(initialData as any).id}`;
    return 'seds_event_draft_new';
  }, [initialData]);

  // Restore Draft on Mount
  useEffect(() => {
    const saved = localStorage.getItem(draftKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          // Merge current values with draft to ensure structural integrity
          form.reset({ ...form.getValues(), ...parsed });
        }
      } catch (e) {
        console.error('Draft restoration failed', e);
      }
    }
  }, [draftKey, form]);

  // Auto-Save Draft on Change
  const formValues = useWatch({ control: form.control });
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(draftKey, JSON.stringify(formValues));
      setIsDraftSaved(true);
      setTimeout(() => setIsDraftSaved(false), 2000);
    }, 1000); // 1s Debounce
    return () => clearTimeout(timer);
  }, [formValues, draftKey]);

  // Compute slug for display (read-only)
  const titleWatch = useWatch({ control: form.control, name: 'title' }) as string | undefined;
  const computedSlug = useMemo(() => {
    const src = (titleWatch || '').toLowerCase().trim();
    return src
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }, [titleWatch]);

  const handleSubmit = async (values: EventFormValues) => {
    const strategicFraming = buildStrategicFramingPayload(values);
    const payload: EventFormSubmitPayload = {
      title: values.title,
      description: values.description || undefined,
      valueProposition: values.valueProposition || undefined,
      catalystStatement: values.catalystStatement || undefined,
      lifestyleOutcome: values.lifestyleOutcome || undefined,
      location: values.location || undefined,
      // NOTE: Dates left as strings here; parent can convert to Timestamp/Date
      type: values.type,
      status: values.status,
      visibility: values.visibility,
      isOnline: values.isOnline,
      venue: values.venue || undefined,
      mapUrl: values.mapUrl || undefined,
      startDate: values.startDate || undefined,
      endDate: values.endDate || undefined,
      tags: (values.tagsInput || '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .slice(0, 50),
      capacity: values.capacityInput ? parseInt(values.capacityInput) || undefined : undefined,
      registrationOpen: values.registrationOpen,
      imageUrl: values.imageUrl || undefined,
      ticketImageUrl: values.ticketImageUrl || undefined,
      ticketBackImageUrl: values.ticketBackImageUrl || undefined,
      paymentDetails: values.isPaid
        ? {
          isPaid: true,
          amount: values.amountInput ? parseFloat(values.amountInput) || 0 : 0,
          currency: values.currency || 'USD',
          method: values.method || undefined,
          instructions: values.instructions || undefined,
          qrCodeUrl: values.qrCodeUrl || undefined,
        }
        : { isPaid: false },
      productId: values.productId || undefined,
      registrationDeadline: values.registrationDeadline
        ? (() => { try { const d = new Date(values.registrationDeadline!); return isNaN(d.getTime()) ? undefined : d.toISOString(); } catch { return undefined; } })()
        : undefined,
      strategicFraming,
      ticketAssets: values.ticketAssets,
      // Boundary cast: the form schema intentionally types overlays loosely
      // (z.record(z.any())) for the visual editor, while EventDoc is strict.
      // Runtime values conform to EventDoc (built from EventDoc-typed initialData
      // or the strict inline defaults above).
      ticketConfig: values.ticketConfig as EventDoc['ticketConfig'],
    };

    // Firebase will throw an error if any field in the object is explicitly `undefined`. 
    // JSON.stringify strips out `undefined` keys entirely, deeply cleaning the object safely 
    // because this payload contains only simple scalars, arrays, and standard objects (no Dates yet).
    const safePayload = JSON.parse(JSON.stringify(payload));

    await onSubmit?.(safePayload);
    // Clear draft on successful submission
    localStorage.removeItem(draftKey);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className={cn('space-y-6', className)}>
        {/* Basic fields */}
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
              <FormControl>
                <Input placeholder="Enter event title" maxLength={200} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea rows={10} placeholder="Write your event description here..." {...field} />
              </FormControl>
              <FormDescription>Supports HTML if your editor enables it.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Slug (read-only, computed) */}
        <FormItem>
          <FormLabel>Slug (auto-generated)</FormLabel>
          <FormControl>
            <Input value={computedSlug} readOnly />
          </FormControl>
        </FormItem>

        {/* Persuasive Copy */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="valueProposition"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Value Proposition</FormLabel>
                <FormControl>
                  <Textarea rows={3} placeholder="E.g., Build and launch space tech faster with expert mentoring" {...field} />
                </FormControl>
                <FormDescription>What they gain. Keep it concrete and outcome-focused.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="catalystStatement"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Catalyst Statement</FormLabel>
                <FormControl>
                  <Textarea rows={3} placeholder="E.g., Apply now — seats are limited" {...field} />
                </FormControl>
                <FormDescription>A nudge to act now. Use scarcity or immediacy.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="lifestyleOutcome"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Lifestyle Outcome</FormLabel>
                <FormControl>
                  <Textarea rows={3} placeholder="E.g., Ship projects that look great on your resume" {...field} />
                </FormControl>
                <FormDescription>How life looks after success. Inspire without hype.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Type / Status / Visibility */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="event">Event</SelectItem>
                    <SelectItem value="workshop">Workshop</SelectItem>
                    <SelectItem value="webinar">Webinar</SelectItem>
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
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="published">Published</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="visibility"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Visibility</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select visibility" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="members">Members</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Timing */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="startDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start Date & Time</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} value={field.value && !isNaN(new Date(field.value).getTime()) ? new Date(field.value).toISOString().slice(0, 16) : ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="endDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>End Date & Time</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} value={field.value && !isNaN(new Date(field.value).getTime()) ? new Date(field.value).toISOString().slice(0, 16) : ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Registration Deadline */}
        <FormField
          control={form.control}
          name="registrationDeadline"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Registration Deadline</FormLabel>
              <FormControl>
                <Input
                  type="datetime-local"
                  {...field}
                  title="Last date/time users can register for this event"
                />
              </FormControl>
              <FormDescription>
                After this date/time, registration will be locked. A live countdown will appear on the event page.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="isOnline"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Online Event</FormLabel>
                <div className="flex items-center gap-2">
                  <Switch checked={!!field.value} onCheckedChange={field.onChange} />
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="registrationOpen"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Registration Open</FormLabel>
                <div className="flex items-center gap-2">
                  <Switch checked={!!field.value} onCheckedChange={field.onChange} />
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="location"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Location</FormLabel>
                <FormControl>
                  <Input placeholder="Enter event location" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="venue"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Venue</FormLabel>
                <FormControl>
                  <Input placeholder="Enter venue" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="mapUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Map URL</FormLabel>
                <FormControl>
                  <Input placeholder="https://..." {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Metadata */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="tagsInput"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tags (comma separated)</FormLabel>
                <FormControl>
                  <Input placeholder="workshop, robotics" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="capacityInput"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Capacity</FormLabel>
                <FormControl>
                  <Input type="number" placeholder="e.g., 100" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="imageUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Image URL</FormLabel>
              <FormControl>
                <Input placeholder="https://..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Payment details */}
        <div className="space-y-2">
          <FormField
            control={form.control}
            name="isPaid"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Paid Event</FormLabel>
                <div className="flex items-center gap-2">
                  <Switch checked={!!field.value} onCheckedChange={field.onChange} />
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
          {!!useWatch({ control: form.control, name: 'isPaid' }) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="amountInput"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Price</FormLabel>
                    <FormControl>
                      <Input type="number" placeholder="e.g., 500" {...field} />
                    </FormControl>
                    <FormDescription>The amount to be paid for registration.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Currency</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., PKR" {...field} />
                    </FormControl>
                    <FormDescription>Price currency (e.g., PKR or USD).</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}
        </div>

        <FormField
          control={form.control}
          name="ticketImageUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <Maximize2 className="w-4 h-4 text-primary" />
                Ticket Front Template (PNG URL)
              </FormLabel>
              <FormControl>
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://example.com/ticket-front.png"
                      className="flex-1 bg-card border-border"
                      {...field}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowFrontEditor(true)}
                      disabled={!field.value}
                      className="shrink-0 border-primary/50 text-primary hover:bg-primary/10"
                    >
                      <Move className="w-4 h-4 mr-2" /> Live Align
                    </Button>
                  </div>
                  {field.value && (
                    <div className="group relative w-full rounded-2xl overflow-hidden shadow-2xl border-2 border-white/5 bg-slate-950 flex flex-col items-center justify-center cursor-pointer"
                      onClick={() => setShowFrontEditor(true)}
                    >
                      <img
                        src={field.value}
                        alt="Ticket Front Preview"
                        className="w-full h-auto transition-transform group-hover:scale-[1.02] block"
                      />

                      {/* Live Overlay Preview */}
                      <div className="absolute inset-0 pointer-events-none w-full h-full">
                        {Object.entries(form.getValues('ticketConfig.frontOverlays') || {}).map(([key, config]: [string, any]) => {
                          if (!config || !config.enabled) return null;
                          return (
                            <div
                              key={key}
                              className="absolute"
                              style={{
                                left: `${config.x}%`,
                                top: `${config.y}%`,
                                transform: 'translate(-50%, -50%)',
                                fontSize: `${config.size * 0.4}px`, // Scaled down for preview
                                color: config.color,
                                fontWeight: config.fontWeight || 'bold',
                                fontFamily: config.fontFamily || 'inherit',
                                textShadow: '0px 1px 2px rgba(0,0,0,0.8)'
                              }}
                            >
                              {key === 'qrCode' ? (
                                <div className="bg-white p-1 rounded-sm" style={{ width: config.size * 0.4, height: config.size * 0.4 }} />
                              ) : (
                                <div className="whitespace-nowrap px-1">{key} text</div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <p className="text-foreground font-bold flex items-center gap-2">
                          <Maximize2 className="w-5 h-5" /> Click to Edit Alignment
                        </p>
                      </div>
                    </div>
                  )}
                  <FormDescription>Must be a direct link to a PNG file. This will be the front face of the issued ticket.</FormDescription>
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="ticketBackImageUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <Maximize2 className="w-4 h-4 text-indigo-400" />
                Ticket Back Template (PNG URL)
              </FormLabel>
              <FormControl>
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://example.com/ticket-back.png"
                      className="flex-1 bg-card border-border"
                      {...field}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowBackEditor(true)}
                      disabled={!field.value}
                      className="shrink-0 border-indigo-500/50 text-indigo-400 hover:bg-indigo-400/10"
                    >
                      <Move className="w-4 h-4 mr-2" /> Live Align
                    </Button>
                  </div>
                  {field.value && (
                    <div className="group relative w-full rounded-2xl overflow-hidden shadow-2xl border-2 border-white/5 bg-slate-950 flex flex-col items-center justify-center cursor-pointer"
                      onClick={() => setShowBackEditor(true)}
                    >
                      <img
                        src={field.value}
                        alt="Ticket Back Preview"
                        className="w-full h-auto transition-transform group-hover:scale-[1.02] block"
                      />

                      {/* Live Overlay Preview */}
                      <div className="absolute inset-0 pointer-events-none w-full h-full">
                        {Object.entries(form.getValues('ticketConfig.backOverlays') || {}).map(([key, config]: [string, any]) => {
                          if (!config || !config.enabled) return null;
                          return (
                            <div
                              key={key}
                              className="absolute"
                              style={{
                                left: `${config.x}%`,
                                top: `${config.y}%`,
                                transform: 'translate(-50%, -50%)',
                                fontSize: `${config.size * 0.4}px`, // Scaled down for preview
                                color: config.color,
                                fontWeight: config.fontWeight || 'bold',
                                fontFamily: config.fontFamily || 'inherit',
                                textShadow: '0px 1px 2px rgba(0,0,0,0.8)'
                              }}
                            >
                              {key === 'qrCode' ? (
                                <div className="bg-white p-1 rounded-sm" style={{ width: config.size * 0.4, height: config.size * 0.4 }} />
                              ) : (
                                <div className="whitespace-nowrap px-1">{key} text</div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <p className="text-foreground font-bold flex items-center gap-2">
                          <Maximize2 className="w-5 h-5" /> Click to Edit Alignment
                        </p>
                      </div>
                    </div>
                  )}
                  <FormDescription>Optional. If set, this will be the back face of the issued ticket.</FormDescription>
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Ticket Overlays Controllers (Hidden but registered) */}
        <FormField
          control={form.control}
          name="ticketConfig.frontOverlays"
          render={({ field }) => (
            showFrontEditor ? (
              <TicketAlignmentEditor
                side="front"
                title="Front Side Alignment"
                imageUrl={form.getValues('ticketImageUrl') || ''}
                overlays={field.value || {}}
                previewData={{
                  title: form.getValues('title'),
                  startDate: form.getValues('startDate'),
                  venue: form.getValues('location'),
                  orgName: form.getValues('ticketConfig.lookFeel.atmosphere')?.split('|')[0] || 'SEDS Pakistan',
                  orgTagline: form.getValues('ticketConfig.lookFeel.atmosphere')?.split('|')[1] || 'Students for Space Exploration',
                  issuedDate: new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }),
                  disclaimer: form.getValues('ticketConfig.lookFeel.atmosphere')?.split('|')[2] || '© SEDS Pakistan 2026. All Rights Reserved.'
                }}
                onClose={() => setShowFrontEditor(false)}
                onChange={field.onChange}
              />
            ) : <></>
          )}
        />

        <FormField
          control={form.control}
          name="ticketConfig.backOverlays"
          render={({ field }) => (
            showBackEditor ? (
              <TicketAlignmentEditor
                side="back"
                title="Back Side Alignment"
                imageUrl={form.getValues('ticketBackImageUrl') || ''}
                overlays={field.value || {}}
                previewData={{
                  title: form.getValues('title'),
                  startDate: form.getValues('startDate'),
                  venue: form.getValues('location'),
                  orgName: form.getValues('ticketConfig.lookFeel.atmosphere')?.split('|')[0] || 'SEDS Pakistan',
                  orgTagline: form.getValues('ticketConfig.lookFeel.atmosphere')?.split('|')[1] || 'Students for Space Exploration',
                  issuedDate: new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }),
                  disclaimer: form.getValues('ticketConfig.lookFeel.atmosphere')?.split('|')[2] || '© SEDS Pakistan 2026. All Rights Reserved.'
                }}
                onClose={() => setShowBackEditor(false)}
                onChange={field.onChange}
              />
            ) : <></>
          )}
        />

        {/* Store Integration (The Single Source of Truth) */}
        <div className="bg-primary/5 p-6 rounded-2xl border border-primary/20 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Link2 className="w-5 h-5 text-primary" />
            <h3 className="text-lg font-bold">Store Integration</h3>
          </div>
          <FormField
            control={form.control}
            name="productId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Linked Store Product</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={(val) => {
                    field.onChange(val);
                    // Sync price/currency from product for backward compatibility
                    const selectedProduct = eventProducts.find((p: any) => p.id === val);
                    if (selectedProduct) {
                      form.setValue('amountInput', String(selectedProduct.price));
                      form.setValue('currency', selectedProduct.currency);
                      form.setValue('isPaid', true);
                    }
                  }}
                >
                  <FormControl>
                    <SelectTrigger className="bg-card border-border">
                      <SelectValue placeholder="Select a product from the Store" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="bg-card border-border">
                    <SelectItem value="none">None (Free Event)</SelectItem>
                    {eventProducts.map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.currency} {p.price})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Link this event to a Store Product to enable payments. All pricing is controlled from the Store Management page.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Aesthetic Controls */}
        <div className="space-y-6 border-t pt-6 bg-slate-900/40 p-6 rounded-2xl border border-white/5">
          <div>
            <h3 className="text-xl font-bold flex items-center gap-2">
              <Palette className="h-5 w-5 text-primary" /> Visual Identity & Look
            </h3>
            <p className="text-sm text-muted-foreground">Define the premium aesthetic for issued tickets.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="ticketConfig.lookFeel.theme"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Theme</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select theme" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Dark Nebula">Dark Nebula</SelectItem>
                      <SelectItem value="Galactic White">Galactic White</SelectItem>
                      <SelectItem value="Interstellar">Interstellar</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ticketConfig.lookFeel.texture"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Texture</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select texture" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="None">None</SelectItem>
                      <SelectItem value="Matte">Matte</SelectItem>
                      <SelectItem value="Gloss">Gloss</SelectItem>
                      <SelectItem value="Linen">Linen</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ticketConfig.lookFeel.atmosphere"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Atmosphere (AI Suggestion)</FormLabel>
                  <FormControl>
                    <Input placeholder="E.g., Forged in the heart of IST..." {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>

        </div>

        {/* Strategic Framing */}
        <div>
          <h3 className="text-lg font-semibold mt-2 mb-4">Strategic Framing</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="strategicFraming.lifestyleTargetHeadline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lifestyle Target Headline</FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="E.g., Live on your terms by hitting clear targets" {...field} />
                  </FormControl>
                  <FormDescription>Quantify the desired lifestyle outcome in one line.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="strategicFraming.incomeVehicleStatement"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Automated Income Vehicle</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="E.g., Use automated income for speed — not manual effort" {...field} />
                  </FormControl>
                  <FormDescription>State the fast path powered by automation.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="strategicFraming.dailyActionExample"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Daily Action Example</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="E.g., Ship one small feature daily toward target" {...field} />
                  </FormControl>
                  <FormDescription>Break targets into daily, concrete steps.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={form.control}
            name="strategicFraming.lifestyleTargetExamplesInput"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Lifestyle Target Examples (up to 8)</FormLabel>
                <FormControl>
                  <Textarea rows={4} placeholder="One example per line (or comma-separated)" {...field} />
                </FormControl>
                <FormDescription>Each line becomes an example; up to 8 items.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Emotional & Moral Framing */}
          <h4 className="text-md font-semibold mt-6 mb-2">Emotional & Moral Framing</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="strategicFraming.emotionalFraming.costOfInactionStatement"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cost of Inaction Statement</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="E.g., If you delay, you risk losing career momentum" {...field} />
                  </FormControl>
                  <FormDescription>Frame the consequences of not acting.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="strategicFraming.emotionalFraming.freedomMetricsStatement"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Freedom Metrics Statement</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="E.g., Measure freedom by time, autonomy, and choices" {...field} />
                  </FormControl>
                  <FormDescription>Define success with moral/emotional resonance.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="strategicFraming.emotionalFraming.socialImpactStatement"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Social Impact Statement</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="E.g., Your work uplifts peers and builds community" {...field} />
                  </FormControl>
                  <FormDescription>Connect the work to broader social good.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* NEW: Mindset & Philosophical Framing */}
          <h4 className="text-md font-semibold mt-6 mb-2">Mindset & Philosophical Framing</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="strategicFraming.mindsetFraming.characterAmplifierStatement"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amplification of Character Statement</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="E.g., Strengthen character through disciplined projects and reliable delivery" {...field} />
                  </FormControl>
                  <FormDescription>Frame growth as character amplification and reliability.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="strategicFraming.mindsetFraming.contributionCapacityStatement"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Capacity to Contribute Statement</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="E.g., Build the capability to meaningfully contribute at higher levels" {...field} />
                  </FormControl>
                  <FormDescription>Emphasize building capacity to deliver value to others.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="strategicFraming.mindsetFraming.actionOverCriticismStatement"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Action Over Criticism Statement</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="E.g., Ship work; favor constructive action over criticism and inaction" {...field} />
                  </FormControl>
                  <FormDescription>Promote choosing constructive action over criticism or inaction.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <div className="flex items-center gap-4 justify-end">
          {isDraftSaved && (
            <span className="text-[10px] text-primary/60 font-black tracking-widest uppercase animate-pulse flex items-center gap-1">
              <div className="w-1 h-1 rounded-full bg-primary" />
              Draft Auto-Saved
            </span>
          )}
          <Button type="submit" className="min-w-[120px] font-bold">{submitLabel}</Button>
        </div>
      </form >
    </Form >
  );
}
