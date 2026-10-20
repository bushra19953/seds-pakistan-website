"use client";

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

interface StatusLookupFormProps {
  loading: boolean;
  error: string | null;
  onLookup: (referenceId: string, email: string) => Promise<void>;
}

/**
 * Signed-out lookup: the applicant proves identity with their reference
 * ID (shown on the induction page after applying) plus the email they
 * applied with. Both must match; the server returns one generic failure
 * either way so nothing about other applicants leaks.
 */
export default function StatusLookupForm({ loading, error, onLookup }: StatusLookupFormProps) {
  const [referenceId, setReferenceId] = useState('');
  const [email, setEmail] = useState('');

  return (
    <Card className="mx-auto w-full max-w-md border-primary/20">
      <CardHeader>
        <CardTitle>Find your application</CardTitle>
        <CardDescription>
          Enter your application reference ID and the email you applied with.
          Your reference ID is shown on the induction page after you apply.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onLookup(referenceId, email);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="lookup-ref">Reference ID</Label>
            <Input
              id="lookup-ref"
              value={referenceId}
              onChange={(e) => setReferenceId(e.target.value)}
              placeholder="SEDS-ABC123"
              autoComplete="off"
              className="font-mono uppercase"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lookup-email">Email</Label>
            <Input
              id="lookup-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={loading || !referenceId.trim() || !email.trim()}>
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Looking up...
              </span>
            ) : (
              'Look up application'
            )}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Signed in already? You are taken straight to your application below.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
