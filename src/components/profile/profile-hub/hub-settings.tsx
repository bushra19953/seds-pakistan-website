'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2, Globe, Lock } from 'lucide-react';
import { useUser } from '@/firebase';
import { slugifyUsername } from '@/lib/profile-hub/telemetry';

/**
 * Public portfolio settings (WS3). Writes go through the existing
 * PATCH /api/profile/[userId] route, which validates username format
 * server-side.
 *
 * Shared-field decision: `publicDirectoryOptIn` boolean on the user doc.
 * Off by default for members, on by default for executives. Phone and email
 * are never public either way.
 */
export function HubPrivacySettings({
  uid,
  initialUsername,
  initialOptIn,
}: {
  uid: string;
  initialUsername: string;
  initialOptIn: boolean;
}) {
  const { user } = useUser();
  const [username, setUsername] = useState(initialUsername);
  const [optIn, setOptIn] = useState(initialOptIn);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUsername(initialUsername);
  }, [initialUsername]);
  useEffect(() => {
    setOptIn(initialOptIn);
  }, [initialOptIn]);

  const slug = slugifyUsername(username);

  const handleSave = async () => {
    if (!user) return;
    try {
      setSaving(true);
      setMessage(null);
      setError(null);
      const token = await user.getIdToken(true);
      const res = await fetch(`/api/profile/${uid}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: slug, publicDirectoryOptIn: optIn }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Save failed');
      }
      setMessage(
        optIn
          ? `Saved. Your public portfolio is live at /u/${slug}.`
          : 'Saved. Your public portfolio is hidden.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-border bg-background/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-5 w-5 text-primary" /> Public portfolio
        </CardTitle>
        <CardDescription>
          Control your public page at /u/your-name. Your phone number and email
          are never shown there.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="hub-username">Username</Label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">/u/</span>
            <Input
              id="hub-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your-name"
              className="max-w-xs"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            3 to 40 characters: lowercase letters, numbers and dashes.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Show my public portfolio</p>
            <p className="text-xs text-muted-foreground">
              {optIn
                ? 'Anyone can view your sanitised portfolio: bio, skills, badges, missions and certificates.'
                : 'Your portfolio returns Not Found to the public.'}
            </p>
          </div>
          <Switch checked={optIn} onCheckedChange={setOptIn} aria-label="Show my public portfolio" />
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />
          Warnings, points penalties and contact details never appear on the public page.
        </div>

        {message && <p className="text-sm text-emerald-400">{message}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        <Button onClick={handleSave} disabled={saving || !user} className="gap-2">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save portfolio settings
        </Button>
      </CardContent>
    </Card>
  );
}
