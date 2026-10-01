'use client';

import { useEffect, useState } from 'react';
import { firestore } from '@/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import createDOMPurify from 'dompurify';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Calendar, Shield } from 'lucide-react';

type PageContent = {
  title?: string;
  content?: string;
  meta_description?: string;
  version?: string;
  lastUpdatedAt?: any;
};

export default function PrivacyPolicyPage() {
  const [content, setContent] = useState<PageContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchContent = async () => {
      try {
        const ref = doc(firestore, 'pages', 'privacy-policy');
        const snap = await getDoc(ref);
        if (snap.exists()) {
          setContent(snap.data() as PageContent);
        } else {
          // Set default content if document doesn't exist
          setContent({
            title: 'Privacy Policy',
            content: `<h2>1. Information We Collect</h2>
<p>We collect information you provide directly to us, such as when you create an account, update your profile, or contact us for support.</p>

<h2>2. How We Use Your Information</h2>
<p>We use the information we collect to provide, maintain, and improve our services, process transactions, send communications, and provide customer support.</p>

<h2>3. Information Sharing</h2>
<p>We do not sell, trade, or otherwise transfer your personal information to third parties without your consent, except as described in this policy.</p>

<h2>4. Data Security</h2>
<p>We implement appropriate security measures to protect your personal information against unauthorized access, alteration, disclosure, or destruction.</p>

<h2>5. Your Rights</h2>
<p>You have the right to access, update, or delete your personal information. You may also opt out of certain communications from us.</p>

<h2>6. Cookies and Tracking</h2>
<p>We use cookies and similar tracking technologies to track activity on our service and hold certain information.</p>

<h2>7. Changes to This Policy</h2>
<p>We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page.</p>`,
            version: '1.0',
            meta_description: 'Privacy policy explaining how SEDS Pakistan collects and uses your information.'
          });
        }
        setError(null);
      } catch (err) {
        console.error('Failed to load Privacy Policy content', err);
        setError('Failed to load content. Please try again later.');
      } finally {
        setLoading(false);
      }
    };
    fetchContent();
  }, []);

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
            <CardTitle>Privacy Policy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">The privacy policy is not available at the moment. Please check back later.</p>
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
          <Shield className="h-8 w-8" />
          {content.title || 'Privacy Policy'}
        </h1>
        
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          {content.version && (
            <span className="flex items-center gap-1">
              <Shield className="h-4 w-4" />
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
        <p>By using this website, you acknowledge that you have read and understood our privacy policy.</p>
      </div>
    </div>
  );
}
