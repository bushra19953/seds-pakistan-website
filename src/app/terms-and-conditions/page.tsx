'use client';

import { useEffect, useState } from 'react';
import { useUser, useFirestore, firestore } from '@/firebase';
import { doc, getDoc, serverTimestamp } from 'firebase/firestore';
;
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import createDOMPurify from 'dompurify';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Calendar, FileText, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { updateDoc } from '@/lib/client/firestore-wrapper';

type PageContent = {
  title?: string;
  content?: string;
  meta_description?: string;
  version?: string;
  lastUpdatedAt?: any;
};

export default function TermsAndConditionsPage() {
  const { user } = useUser();
  const fs = useFirestore();
  const [content, setContent] = useState<PageContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState<boolean | null>(null);
  const { showToast: toast } = useEnhancedToast();

  // Check if user already accepted on mount (persists across reloads)
  useEffect(() => {
    if (!user?.uid || !fs) return;
    const checkAcceptance = async () => {
      try {
        const userRef = doc(fs, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists() && userSnap.data()?.termsAccepted) {
          setAccepted(true);
        }
      } catch { /* tolerate */ }
    };
    checkAcceptance();
  }, [user?.uid, fs]);

  useEffect(() => {
    const fetchContent = async () => {
      try {
        const ref = doc(firestore, 'pages', 'terms-and-conditions');
        const snap = await getDoc(ref);
        if (snap.exists()) {
          setContent(snap.data() as PageContent);
        } else {
          // Set default content if document doesn't exist
          setContent({
            title: 'Terms and Conditions',
            content: `<h2>1. Acceptance of Terms</h2>
<p>By accessing and using this website, you accept and agree to be bound by the terms and provision of this agreement.</p>

<h2>2. Use License</h2>
<p>Permission is granted to temporarily download one copy of the materials (information or software) on SEDS Pakistan's website for personal, non-commercial transitory viewing only.</p>

<h2>3. Disclaimer</h2>
<p>The materials on SEDS Pakistan's website are provided on an 'as is' basis. SEDS Pakistan makes no warranties, expressed or implied, and hereby disclaims and negates all other warranties including, without limitation, implied warranties or conditions of merchantability, fitness for a particular purpose, or non-infringement of intellectual property or other violation of rights.</p>

<h2>4. Limitations</h2>
<p>In no event shall SEDS Pakistan or its suppliers be liable for any damages (including, without limitation, damages for loss of data or profit, or due to business interruption) arising out of the use or inability to use the materials on SEDS Pakistan's website.</p>

<h2>5. Revisions and Errata</h2>
<p>The materials appearing on SEDS Pakistan's website could include technical, typographical, or photographic errors. SEDS Pakistan does not warrant that any of the materials on its website are accurate, complete or current.</p>`,
            version: '1.0',
            meta_description: 'Terms and conditions for using SEDS Pakistan website and services.'
          });
        }
        setError(null);
      } catch (err) {
        console.error('Failed to load Terms and Conditions content', err);
        setError('Failed to load content. Please try again later.');
      } finally {
        setLoading(false);
      }
    };
    fetchContent();
  }, []);

  const handleAccept = async () => {
    if (!user || !fs) {
      toast({ variant: 'destructive', title: 'Not signed in', description: 'Please log in to accept the terms.' });
      return;
    }
    try {
      setAccepting(true);
      const userRef = doc(fs, 'users', user.uid);
      const version = (content?.version || '1.0').toString();
      await updateDoc(userRef, {
        termsAccepted: true,
        termsAcceptedAt: serverTimestamp(),
        termsVersion: version,
      } as any);
      setAccepted(true);
      toast({ title: 'Terms accepted', description: 'Thank you for accepting the Terms and Conditions.' });
    } catch (e) {
      console.error('Accept terms error:', e);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to record acceptance. Please try again.' });
    } finally {
      setAccepting(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card className="mb-6">
          <CardHeader>
            <Skeleton className="h-8 w-64" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-6 w-48 mt-4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Terms and Conditions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">The terms and conditions are not available at the moment. Please check back later.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const lastUpdated = content.lastUpdatedAt ?
    new Date(content.lastUpdatedAt?.toDate?.() || content.lastUpdatedAt).toLocaleDateString() :
    null;

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      {content.meta_description && (
        <meta name="description" content={content.meta_description} />
      )}

      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2 flex items-center gap-2">
          <FileText className="h-8 w-8" />
          {content.title || 'Terms and Conditions'}
        </h1>

        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          {content.version && (
            <span className="flex items-center gap-1">
              <FileText className="h-4 w-4" />
              Version {content.version}
            </span>
          )}
          {lastUpdated && (
            <span className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              Last updated: {lastUpdated}
            </span>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="prose prose-lg max-w-none pt-6">
          <div
            dangerouslySetInnerHTML={{
              __html: (() => {
                const purifier = createDOMPurify(window as unknown as any);
                return purifier.sanitize(String(content.content || '<p>Content not available.</p>'));
              })()
            }}
          />
        </CardContent>
      </Card>

      <div className="mt-6 text-center text-sm text-muted-foreground">
        <p>By using this website, you agree to these terms and conditions.</p>
      </div>

      <div className="mt-6 flex items-center gap-3">
        {accepted ? (
          <span className="flex items-center gap-2 text-green-600 text-sm font-medium">
            <CheckCircle className="h-4 w-4" /> You have accepted these terms
          </span>
        ) : user ? (
          <Button onClick={handleAccept} disabled={accepting}>
            {accepting ? 'Recording...' : 'Accept Terms'}
          </Button>
        ) : (
          <Button variant="outline" asChild>
            <Link href="/auth/login">Sign In to Accept</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
