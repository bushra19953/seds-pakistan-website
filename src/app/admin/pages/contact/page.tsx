'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Eye, Save, Plus, Trash2 } from 'lucide-react';
import { useUser, useFirestore, useDoc } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
// Removed old AdminLayout; admin layout is now app/admin/layout.tsx
// Starry background is provided globally by the admin layout
import { doc, serverTimestamp, type FirestoreDataConverter, type Timestamp } from 'firebase/firestore';
import { setDoc } from '@/lib/client/firestore-wrapper';

;

export const dynamic = 'force-dynamic';

type ContactMethodType = 'email' | 'link';

interface ContactMethod {
  title: string;
  description?: string;
  icon?: string; // lucide icon name or custom string
  type: ContactMethodType;
  value: string; // email address or URL
}

interface ContactPageDoc {
  title: string;
  subtitle?: string;
  contactMethods: ContactMethod[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

const contactPageConverter: FirestoreDataConverter<ContactPageDoc> = {
  toFirestore: (data) => ({
    title: data.title,
    subtitle: data.subtitle ?? '',
    contactMethods: Array.isArray(data.contactMethods)
      ? data.contactMethods.map((m) => ({
        title: (m as any)?.title ?? '',
        description: (m as any)?.description ?? '',
        icon: (m as any)?.icon ?? null,
        type: (((m as any)?.type ?? 'email') as ContactMethodType),
        value: (m as any)?.value ?? '',
      }))
      : [],
    createdAt: data.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  }),
  fromFirestore: (snap) => {
    const d = snap.data();
    return {
      title: (d.title as string) ?? '',
      subtitle: (d.subtitle as string) ?? '',
      contactMethods: Array.isArray(d.contactMethods) ? (d.contactMethods as ContactMethod[]) : [],
      createdAt: d.createdAt as Timestamp | undefined,
      updatedAt: d.updatedAt as Timestamp | undefined,
    };
  },
};

export default function AdminContactPageEditor() {
  const router = useRouter();
  const { user, role, isLoading } = useUser();
  const firestore = useFirestore();
  const contactDocRef = useMemo(() => doc(firestore, 'pages', 'contact').withConverter(contactPageConverter), [firestore]);
  const { data, loading: docLoading } = useDoc<ContactPageDoc>(contactDocRef, { listen: true });

  const [form, setForm] = useState<ContactPageDoc>({ title: '', subtitle: '', contactMethods: [] });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        title: data.title || '',
        subtitle: data.subtitle || '',
        contactMethods: Array.isArray(data.contactMethods) ? data.contactMethods : [],
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      });
      setHasChanges(false);
    }
  }, [data]);

  const updateField = <K extends keyof ContactPageDoc>(key: K, value: ContactPageDoc[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      setHasChanges(true);
      return next;
    });
  };

  const addMethod = () => {
    setForm((prev) => {
      const nextMethods = [
        ...prev.contactMethods,
        { title: 'Email', description: '', icon: 'Mail', type: 'email' as ContactMethodType, value: '' },
      ];
      setHasChanges(true);
      return { ...prev, contactMethods: nextMethods };
    });
  };

  const updateMethod = (idx: number, patch: Partial<ContactMethod>) => {
    setForm((prev) => {
      const next = prev.contactMethods.map((m, i) => (i === idx ? { ...m, ...patch } : m));
      setHasChanges(true);
      return { ...prev, contactMethods: next };
    });
  };

  const removeMethod = (idx: number) => {
    setForm((prev) => {
      const next = prev.contactMethods.filter((_, i) => i !== idx);
      setHasChanges(true);
      return { ...prev, contactMethods: next };
    });
  };

  const moveMethodUp = (idx: number) => {
    if (idx <= 0) return;
    setForm((prev) => {
      const next = [...prev.contactMethods];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      setHasChanges(true);
      return { ...prev, contactMethods: next };
    });
  };

  const moveMethodDown = (idx: number) => {
    if (idx >= form.contactMethods.length - 1) return;
    setForm((prev) => {
      const next = [...prev.contactMethods];
      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
      setHasChanges(true);
      return { ...prev, contactMethods: next };
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError('');
    setSuccess('');
    try {
      // Basic client-side validations aligned with rules
      if (!form.title || form.title.trim().length === 0) throw new Error('Title is required');
      if (form.contactMethods.length > 20) throw new Error('Maximum 20 contact methods allowed');

      await setDoc(contactDocRef, {
        title: form.title,
        subtitle: form.subtitle || '',
        contactMethods: form.contactMethods.map((m) => ({
          title: m.title || '',
          description: m.description || '',
          icon: m.icon || undefined,
          type: m.type,
          value: m.value || '',
        })),
        createdAt: form.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSuccess('Contact page saved.');
      setHasChanges(false);
    } catch (e: any) {
      console.error('[AdminContactPageEditor] Save error', e);
      setError(e?.message || 'Failed to save contact page');
    } finally {
      setIsSaving(false);
    }
  };

  // Loading states
  if (isLoading || docLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading contact page editor...</p>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManagePages">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-glow mb-2">Contact Page Editor</h1>
        <p className="text-muted-foreground">Manage contact information shown publicly</p>
      </div>
      <div className="space-y-6">
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Contact Content</CardTitle>
                <CardDescription>Title, subtitle, and contact methods</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href="/contact" target="_blank">
                    <Eye className="h-4 w-4 mr-1" /> View Page
                  </Link>
                </Button>
                <Button onClick={handleSave} disabled={isSaving || !hasChanges} size="sm">
                  {isSaving ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-1" /> Save Changes
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {error && (
              <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
            )}
            {success && (
              <Alert><AlertDescription>{success}</AlertDescription></Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="contact-title">Title</Label>
              <Input id="contact-title" value={form.title} onChange={(e) => updateField('title', e.target.value)} placeholder="Contact Us" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="contact-subtitle">Subtitle</Label>
              <Textarea id="contact-subtitle" value={form.subtitle} onChange={(e) => updateField('subtitle', e.target.value)} placeholder="We’d love to hear from you." rows={2} />
            </div>

            <div className="flex items-center justify-between">
              <Label className="font-medium">Contact Methods</Label>
              <Button variant="outline" size="sm" onClick={addMethod}><Plus className="h-4 w-4 mr-1" /> Add Method</Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {form.contactMethods.map((m, idx) => (
                <Card key={idx} className="bg-card/70">
                  <CardContent className="space-y-3 pt-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label>Title</Label>
                        <Input value={m.title} onChange={(e) => updateMethod(idx, { title: e.target.value })} placeholder="Email" />
                      </div>
                      <div className="space-y-2">
                        <Label>Icon</Label>
                        <Select value={(m.icon || '').toLowerCase()} onValueChange={(val) => updateMethod(idx, { icon: val })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose an icon" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="mail">Mail</SelectItem>
                            <SelectItem value="phone">Phone</SelectItem>
                            <SelectItem value="instagram">Instagram</SelectItem>
                            <SelectItem value="twitter">Twitter</SelectItem>
                            <SelectItem value="globe">Globe</SelectItem>
                            <SelectItem value="link">Link</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input value={m.icon || ''} onChange={(e) => updateMethod(idx, { icon: e.target.value })} placeholder="Or type a custom icon name (lucide)" />
                      </div>
                      <div className="space-y-2 col-span-2">
                        <Label>Description</Label>
                        <Textarea value={m.description || ''} onChange={(e) => updateMethod(idx, { description: e.target.value })} rows={2} placeholder="Reach us for projects, partnerships, or membership." />
                      </div>
                      <div className="space-y-2">
                        <Label>Type</Label>
                        <Select value={m.type} onValueChange={(val: ContactMethodType) => updateMethod(idx, { type: val })}>
                          <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="email">Email</SelectItem>
                            <SelectItem value="link">Link</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>{m.type === 'email' ? 'Email Address' : 'URL'}</Label>
                        <Input value={m.value} onChange={(e) => updateMethod(idx, { value: e.target.value })} placeholder={m.type === 'email' ? 'info@seds.org' : 'https://example.com/contact'} />
                      </div>
                    </div>
                    <div className="flex justify-between">
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => moveMethodUp(idx)} disabled={idx === 0}>↑ Move Up</Button>
                        <Button variant="outline" size="sm" onClick={() => moveMethodDown(idx)} disabled={idx === form.contactMethods.length - 1}>↓ Move Down</Button>
                      </div>
                      <Button variant="destructive" size="sm" onClick={() => removeMethod(idx)}>
                        <Trash2 className="h-4 w-4 mr-1" /> Remove
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
}
