'use client';

import { useState, useEffect } from 'react';
import { firestore } from '@/firebase';
import { doc, getDoc, serverTimestamp } from 'firebase/firestore';
;
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Save, FileText, Scale, AlertCircle, CheckCircle } from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { setDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

interface LegalDocument {
  id: string;
  title: string;
  content: string;
  version: string;
  lastUpdatedAt?: any;
  meta_description?: string;
}

const DEFAULT_DOCUMENTS = {
  'terms-and-conditions': {
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
  },
  'privacy-policy': {
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
<p>You have the right to access, update, or delete your personal information. You may also opt out of certain communications from us.</p>`,
    version: '1.0',
    meta_description: 'Privacy policy explaining how SEDS Pakistan collects and uses your information.'
  }
};

export default function LegalDocumentsAdminPage() {
  const [documents, setDocuments] = useState<Record<string, LegalDocument>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { showSuccessToast, showErrorToast } = useEnhancedToast();

  // Fetch existing documents
  useEffect(() => {
    const fetchDocuments = async () => {
      setLoading(true);
      try {
        const docs: Record<string, LegalDocument> = {};
        
        for (const docId of Object.keys(DEFAULT_DOCUMENTS)) {
          const docRef = doc(firestore, 'pages', docId);
          const docSnap = await getDoc(docRef);
          
          if (docSnap.exists()) {
            docs[docId] = docSnap.data() as LegalDocument;
          } else {
            // Use default if document doesn't exist
            docs[docId] = {
              id: docId,
              ...DEFAULT_DOCUMENTS[docId as keyof typeof DEFAULT_DOCUMENTS]
            };
          }
        }
        
        setDocuments(docs);
      } catch (error) {
        console.error('Error fetching legal documents:', error);
        showErrorToast('Failed to load legal documents');
        // Set default documents on error
        const docs: Record<string, LegalDocument> = {};
        for (const docId of Object.keys(DEFAULT_DOCUMENTS)) {
          docs[docId] = {
            id: docId,
            ...DEFAULT_DOCUMENTS[docId as keyof typeof DEFAULT_DOCUMENTS]
          };
        }
        setDocuments(docs);
      } finally {
        setLoading(false);
      }
    };

    fetchDocuments();
  }, [showErrorToast]);

  const handleSave = async (docId: string) => {
    setSaving(prev => ({ ...prev, [docId]: true }));
    setErrors(prev => ({ ...prev, [docId]: '' }));
    
    try {
      const document = documents[docId];
      if (!document) return;

      // Validate required fields
      if (!document.title.trim()) {
        throw new Error('Title is required');
      }
      if (!document.content.trim()) {
        throw new Error('Content is required');
      }
      if (!document.version.trim()) {
        throw new Error('Version is required');
      }

      // Increment version and update timestamp
      const updatedDoc = {
        ...document,
        lastUpdatedAt: serverTimestamp(),
        version: document.version // Keep existing version, admin should manually increment
      };

      await setDoc(doc(firestore, 'pages', docId), updatedDoc);
      
      showSuccessToast(
        `${document.title} updated successfully`,
        `Version ${document.version} has been saved and is now live on the website.`
      );
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to save document';
      setErrors(prev => ({ ...prev, [docId]: errorMessage }));
      showErrorToast(errorMessage);
    } finally {
      setSaving(prev => ({ ...prev, [docId]: false }));
    }
  };

  const handleFieldChange = (docId: string, field: keyof LegalDocument, value: string) => {
    setDocuments(prev => ({
      ...prev,
      [docId]: {
        ...prev[docId],
        [field]: value
      }
    }));
  };

  const handleResetToDefault = (docId: string) => {
    if (confirm(`Are you sure you want to reset ${DEFAULT_DOCUMENTS[docId as keyof typeof DEFAULT_DOCUMENTS].title} to default content? This will overwrite your current changes.`)) {
      setDocuments(prev => ({
        ...prev,
        [docId]: {
          id: docId,
          ...DEFAULT_DOCUMENTS[docId as keyof typeof DEFAULT_DOCUMENTS]
        }
      }));
      showSuccessToast('Document reset to default content');
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManagePermissions">
    <div className="container mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2 flex items-center gap-2">
          <Scale className="h-8 w-8" />
          Legal Documents Management
        </h1>
        <p className="text-muted-foreground">
          Manage your organization's legal documents including Terms and Conditions and Privacy Policy.
          Changes made here will be immediately reflected on the public website.
        </p>
      </div>

      <div className="grid gap-8">
        {Object.entries(documents).map(([docId, document]) => (
          <Card key={docId} className="border-primary/20">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  {document.title}
                  <Badge variant="outline" className="ml-2">
                    v{document.version}
                  </Badge>
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleResetToDefault(docId)}
                    disabled={saving[docId]}
                  >
                    Reset to Default
                  </Button>
                  <Button
                    onClick={() => handleSave(docId)}
                    disabled={saving[docId]}
                    className="flex items-center gap-2"
                  >
                    {saving[docId] ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4" />
                        Save Changes
                      </>
                    )}
                  </Button>
                </div>
              </div>
              {document.lastUpdatedAt && (
                <p className="text-sm text-muted-foreground mt-1">
                  Last updated: {new Date(document.lastUpdatedAt?.toDate?.() || document.lastUpdatedAt).toLocaleString()}
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-6">
              {errors[docId] && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{errors[docId]}</AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor={`${docId}-title`}>Document Title</Label>
                  <Input
                    id={`${docId}-title`}
                    value={document.title}
                    onChange={(e) => handleFieldChange(docId, 'title', e.target.value)}
                    placeholder="Enter document title"
                  />
                </div>
                <div>
                  <Label htmlFor={`${docId}-version`}>Version Number</Label>
                  <Input
                    id={`${docId}-version`}
                    value={document.version}
                    onChange={(e) => handleFieldChange(docId, 'version', e.target.value)}
                    placeholder="e.g., 1.0, 2.1"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor={`${docId}-meta`}>Meta Description (SEO)</Label>
                <Input
                  id={`${docId}-meta`}
                  value={document.meta_description || ''}
                  onChange={(e) => handleFieldChange(docId, 'meta_description', e.target.value)}
                  placeholder="Brief description for search engines"
                />
              </div>

              <div>
                <Label htmlFor={`${docId}-content`}>Document Content (HTML)</Label>
                <Textarea
                  id={`${docId}-content`}
                  value={document.content}
                  onChange={(e) => handleFieldChange(docId, 'content', e.target.value)}
                  placeholder="Enter HTML content for the document"
                  rows={20}
                  className="font-mono text-sm"
                />
                <p className="text-sm text-muted-foreground mt-1">
                  You can use HTML tags like &lt;h2&gt;, &lt;p&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;strong&gt;, &lt;em&gt; for formatting.
                </p>
              </div>

              <div className="bg-muted/50 p-4 rounded-lg">
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  Document Preview
                </h4>
                <div className="prose prose-sm max-w-none">
                  <div 
                    dangerouslySetInnerHTML={{ 
                      __html: document.content || '<p>No content to preview</p>' 
                    }}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t">
                <div className="text-sm text-muted-foreground">
                  <p>This document will be publicly accessible at:</p>
                  <code className="bg-muted px-2 py-1 rounded">
                    /{docId.replace('-', '-and-')}
                  </code>
                </div>
                <Button
                  variant="outline"
                  onClick={() => window.open(`/${docId.replace('-', '-and-')}`, '_blank')}
                >
                  View Live Page
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
    </AuthorizationGate>
  );
}