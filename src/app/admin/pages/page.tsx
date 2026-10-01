'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
// Changed import: alias a valid lucide icon to `Timeline`.
// Reason: `Timeline` is not exported by `lucide-react` in some versions, // which makes it `undefined` at render time and triggers React's
// “Element type is invalid... got: undefined” error.
import { Edit, Save, FileText, Eye, Sparkles, LayoutGrid, Clock as Timeline } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
// Starry background provided by persistent admin layout
// Removed old AdminLayout wrapper; app/admin/layout.tsx handles layout
import { firestore } from '@/firebase';
import { doc, getDoc, serverTimestamp } from 'firebase/firestore';
;
import ResponsiveTable from '@/components/ui/responsive-table';
import { setDoc } from '@/lib/client/firestore-wrapper';

interface PageContent {
  title: string;
  content: string;
  meta_description: string;
  updated_at?: any;
  updated_by?: string;
  // Donate page structured payment fields
  bankName?: string;
  accountTitle?: string;
  iban?: string;
  jazzcashNumber?: string;
  easypaisaNumber?: string;
  raastId?: string;
}

const availablePages = [
  { id: 'about', name: 'About Page', description: 'About us and organization information' },
  { id: 'home', name: 'Home Page', description: 'Landing page content' },
  { id: 'contact', name: 'Contact Page', description: 'Contact information and form' },
  { id: 'terms-and-conditions', name: 'Terms & Conditions', description: 'Legal terms and conditions for using the service' },
  { id: 'donate', name: 'Donate Page', description: 'Content for supporting SEDS Pakistan (Bank details, etc.)' },
  { id: 'register-chapter', name: 'Register Chapter', description: 'Information and requirements for new chapters' },
];

export default function AdminPagesPage() {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const [selectedPage, setSelectedPage] = useState<string>('');
  const [pageContent, setPageContent] = useState<PageContent>({
    title: '',
    content: '',
    meta_description: '',
  });
  const [originalContent, setOriginalContent] = useState<PageContent>({
    title: '',
    content: '',
    meta_description: '',
  });
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [hasChanges, setHasChanges] = useState(false);

  // Handle loading state
  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading page content editor...</p>
      </div>
    );
  }

  const loadPageContent = async (pageId: string) => {
    if (!pageId) return;

    setIsLoadingContent(true);
    setError('');
    setSuccess('');

    try {
      const docRef = doc(firestore, 'pages', pageId);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        const data = docSnap.data() as PageContent;
        setPageContent(data);
        setOriginalContent(data);
      } else {
        // Initialize with default content for new pages
        const defaultContent: PageContent = {
          title: availablePages.find(p => p.id === pageId)?.name || '',
          content: '',
          meta_description: availablePages.find(p => p.id === pageId)?.description || '',
        };
        setPageContent(defaultContent);
        setOriginalContent(defaultContent);
      }
      setHasChanges(false);
    } catch (err) {
      setError('Failed to load page content. Please try again.');
      console.error('Error loading page content:', err);
    } finally {
      setIsLoadingContent(false);
    }
  };

  const handleSave = async () => {
    if (!selectedPage) return;

    setIsSaving(true);
    setError('');
    setSuccess('');

    try {
      const docRef = doc(firestore, 'pages', selectedPage);
      const payload = {
        ...pageContent,
        updated_at: serverTimestamp(),
        updated_by: user?.uid,
      };
      await setDoc(docRef, payload, { merge: true });

      setOriginalContent(pageContent);
      setHasChanges(false);
      setSuccess('Page content saved successfully!');
    } catch (err) {
      setError('Failed to save page content. Please try again.');
      console.error('Error saving page content:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePageChange = (pageId: string) => {
    setSelectedPage(pageId);
    loadPageContent(pageId);
  };

  const handleContentChange = (field: keyof PageContent, value: string) => {
    setPageContent(prev => ({ ...prev, [field]: value }));

    // Check if content has changed
    const hasContentChanged = JSON.stringify({ ...pageContent, [field]: value }) !== JSON.stringify(originalContent);
    setHasChanges(hasContentChanged);
  };

  // Guided template insertion helpers (focused on About page)
  const insertAtEnd = (html: string) => {
    const nextContent = `${pageContent.content}\n\n${html}`.trim();
    handleContentChange('content', nextContent);
  };

  const handleInsertHero = () => {
    insertAtEnd(`
<section class="mb-8">
  <h2 class="text-3xl font-bold mb-3">Who We Are</h2>
  <p class="text-lg">We are a student-led organization advancing space education and projects in Pakistan.</p>
  <p class="text-muted-foreground">Add a short mission sentence here, in plain language.</p>
</section>
`);
  };

  const handleInsertTwoColumnInfographics = () => {
    insertAtEnd(`
<section class="mb-8">
  <h2 class="text-2xl font-semibold mb-4">Highlights</h2>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
    <div class="bg-muted p-6 rounded-lg">
      <h3 class="text-xl font-medium mb-2">Infographic A</h3>
      <p>Replace this with your first highlight or infographic description.</p>
    </div>
    <div class="bg-muted p-6 rounded-lg">
      <h3 class="text-xl font-medium mb-2">Infographic B</h3>
      <p>Replace this with your second highlight or infographic description.</p>
    </div>
  </div>
</section>
`);
  };

  const handleInsertSmartTimeline = () => {
    // Role history timeline embed placeholder detected by About page and replaced with a rich component
    insertAtEnd(`<section class="mb-8"><h2 class="text-2xl font-semibold mb-4">Leadership Timeline</h2><div data-embed="role-history-timeline"></div></section>`);
  };

  const handleInsertProjectTimeline = () => {
    insertAtEnd(`<section class="mb-8"><h2 class="text-2xl font-semibold mb-4">Our Journey</h2><div data-embed="timeline"></div></section>`);
  };

  return (
    <AuthorizationGate permission="canManagePages">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-glow mb-2">Page Content Management</h1>
        <p className="text-muted-foreground">Edit static page content</p>
      </div>
      <div className="space-y-6">
        {/* Page Selection */}
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>Select Page to Edit</CardTitle>
            <CardDescription>Choose which static page you want to edit</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveTable
              table={
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {availablePages.map((page) => (
                      <TableRow key={page.id}>
                        <TableCell className="font-medium">{page.name}</TableCell>
                        <TableCell className="text-muted-foreground">{page.description}</TableCell>
                        <TableCell>
                          <Button
                            variant={selectedPage === page.id ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => handlePageChange(page.id)}
                          >
                            Select
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              }
              cards={
                <div className="grid grid-cols-1 gap-4">
                  {availablePages.map((page) => (
                    <Button
                      key={page.id}
                      variant={selectedPage === page.id ? 'default' : 'outline'}
                      onClick={() => handlePageChange(page.id)}
                      className="justify-start text-left h-auto py-3"
                    >
                      <div>
                        <div className="font-medium">{page.name}</div>
                        <div className="text-xs text-muted-foreground">{page.description}</div>
                      </div>
                    </Button>
                  ))}
                </div>
              }
            />
          </CardContent>
        </Card>

        {/* Content Editor */}
        {selectedPage && (
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Editing: {availablePages.find(p => p.id === selectedPage)?.name}</CardTitle>
                  <CardDescription>Update the content for this page</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                  >
                    <Link href={selectedPage === 'home' ? '/' : `/${selectedPage}`} target="_blank">
                      <Eye className="h-4 w-4 mr-1" />
                      View Page
                    </Link>
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={isSaving || !hasChanges || isLoadingContent}
                    size="sm"
                  >
                    {isSaving ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4 mr-1" />
                        Save Changes
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {success && (
                <Alert>
                  <AlertDescription>{success}</AlertDescription>
                </Alert>
              )}

              {isLoadingContent ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                </div>
              ) : (
                <>
                  {selectedPage === 'contact' ? (
                    <div className="p-4 border rounded-lg bg-card/60">
                      <div className="mb-2 font-medium">Contact Page uses structured content managed in a dedicated editor.</div>
                      <p className="text-sm text-muted-foreground mb-4">Use the Contact editor to add email, links, and descriptions. The public page reads directly from Firestore and is not hard-coded.</p>
                      <div className="flex gap-2">
                        <Button type="button" asChild>
                          <Link href="/admin/pages/contact" target="_blank">
                            Go to Contact Editor
                          </Link>
                        </Button>
                        <Button type="button" variant="outline" asChild>
                          <Link href="/contact" target="_blank">
                            View Public Page
                          </Link>
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="page-title">Page Title</Label>
                        <Input
                          id="page-title"
                          value={pageContent.title}
                          onChange={(e) => handleContentChange('title', e.target.value)}
                          placeholder="Enter page title"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="meta-description">Meta Description</Label>
                        <Textarea
                          id="meta-description"
                          value={pageContent.meta_description}
                          onChange={(e) => handleContentChange('meta_description', e.target.value)}
                          placeholder="Enter meta description for SEO"
                          rows={2}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="page-content">Page Content</Label>
                        <Textarea
                          id="page-content"
                          value={pageContent.content}
                          onChange={(e) => handleContentChange('content', e.target.value)}
                          placeholder="Enter page content (HTML supported)"
                          rows={15}
                          className="font-mono text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                          You can use HTML tags for formatting. For complex layouts, use appropriate HTML structure.
                        </p>
                        {selectedPage === 'about' && (
                          <div className="mt-4 p-4 border rounded-lg bg-card/60">
                            <div className="flex items-center gap-2 mb-3">
                              <Sparkles className="h-4 w-4 text-primary" />
                              <span className="font-medium">Quick Templates (no HTML knowledge needed)</span>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                              <Button type="button" variant="outline" onClick={handleInsertHero} className="justify-start">
                                <Sparkles className="h-4 w-4 mr-2" /> Add Intro Section
                              </Button>
                              <Button type="button" variant="outline" onClick={handleInsertTwoColumnInfographics} className="justify-start">
                                <LayoutGrid className="h-4 w-4 mr-2" /> Add Two-Column Highlights
                              </Button>
                              <Button type="button" variant="outline" onClick={handleInsertSmartTimeline} className="justify-start">
                                <Timeline className="h-4 w-4 mr-2" /> Insert Smart Leadership Timeline
                              </Button>
                              <Button type="button" variant="outline" onClick={handleInsertProjectTimeline} className="justify-start">
                                <Timeline className="h-4 w-4 mr-2" /> Insert Project/Activity Timeline
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground mt-3">
                              These buttons insert ready-made blocks. You can edit the text directly above. The &quot;Smart Leadership Timeline&quot; shows current and past positions from the Positions admin.
                            </p>
                          </div>
                        )}

                        {selectedPage === 'donate' && (
                          <div className="mt-4 p-4 border rounded-lg bg-card/60 space-y-4">
                            <div className="flex items-center gap-2 mb-1">
                              <FileText className="h-4 w-4 text-primary" />
                              <span className="font-medium">Structured Payment Details</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Fill in the fields below to enable copy-to-clipboard payment cards on the Donate page. Leave fields blank to hide them.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <Label htmlFor="bankName">Bank Name</Label>
                                <Input id="bankName" value={pageContent.bankName || ''} onChange={(e) => handleContentChange('bankName' as any, e.target.value)} placeholder="e.g. Meezan Bank" />
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor="accountTitle">Account Title</Label>
                                <Input id="accountTitle" value={pageContent.accountTitle || ''} onChange={(e) => handleContentChange('accountTitle' as any, e.target.value)} placeholder="e.g. SEDS Pakistan" />
                              </div>
                              <div className="space-y-1 md:col-span-2">
                                <Label htmlFor="iban">IBAN</Label>
                                <Input id="iban" value={pageContent.iban || ''} onChange={(e) => handleContentChange('iban' as any, e.target.value)} placeholder="e.g. PK36MEZN0001234567890001" className="font-mono" />
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor="jazzcash">JazzCash Number</Label>
                                <Input id="jazzcash" value={pageContent.jazzcashNumber || ''} onChange={(e) => handleContentChange('jazzcashNumber' as any, e.target.value)} placeholder="03XX-XXXXXXX" />
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor="easypaisa">EasyPaisa Number</Label>
                                <Input id="easypaisa" value={pageContent.easypaisaNumber || ''} onChange={(e) => handleContentChange('easypaisaNumber' as any, e.target.value)} placeholder="03XX-XXXXXXX" />
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor="raast">Raast ID</Label>
                                <Input id="raast" value={pageContent.raastId || ''} onChange={(e) => handleContentChange('raastId' as any, e.target.value)} placeholder="phone number or CNIC" />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AuthorizationGate>
  );
}
