"use client";

import { useState, useEffect } from 'react';
import { useUser, useFirestore } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';
import { useRouter } from 'next/navigation';
import { collection, doc, getDocs, query, orderBy } from 'firebase/firestore';
;
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, Edit, Trash2, Save, X, Image as ImageIcon, ExternalLink } from 'lucide-react';
import { addDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';


interface Organization {
  id?: string;
  name: string;
  logoUrl: string;
  websiteUrl: string;
  type: 'National Chapter' | 'Institutional Partner' | 'Sponsor' | 'University';
  showOnHomepageMarquee: boolean;
  displayOrder: number;
  isActive: boolean;
  isGlobal: boolean;
  description: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export default function AdminOrganizationsPage() {
  const { user, isLoading: userLoading } = useUser();
  const { isAuthorized: canManageOrgs, isLoading: authLoading } = useAuthorization('canManageOrganizations');
  const router = useRouter();
  const firestore = useFirestore();
  
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingOrganization, setEditingOrganization] = useState<Organization | null>(null);
  const [toast, setToast] = useState<{title: string, description: string, variant?: 'default' | 'destructive'} | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    logoUrl: '',
    websiteUrl: '',
    type: 'National Chapter' as Organization['type'],
    showOnHomepageMarquee: false,
    displayOrder: 0,
    isActive: true,
    isGlobal: true,
    description: '',
  });

  const showToast = (title: string, description: string, variant?: 'default' | 'destructive') => {
    setToast({ title, description, variant });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchOrganizations = async () => {
    try {
      setLoading(true);
      const organizationsCol = collection(firestore, 'organizations');
      const q = query(organizationsCol, orderBy('displayOrder', 'asc'));
      
      const snapshot = await getDocs(q);
      const items: Organization[] = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate(),
        updatedAt: doc.data().updatedAt?.toDate(),
      })) as Organization[];
      
      setOrganizations(items);
    } catch (error) {
      console.error('Error fetching organizations:', error);
      showToast('Error', 'Failed to fetch organizations.', 'destructive');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && canManageOrgs) {
      fetchOrganizations();
    }
  }, [user, canManageOrgs]);

  const handleCreateOrganization = () => {
    setEditingOrganization(null);
    setFormData({
      name: '',
      logoUrl: '',
      websiteUrl: '',
      type: 'National Chapter',
      showOnHomepageMarquee: false,
      displayOrder: organizations.length,
      isActive: true,
      isGlobal: true,
      description: '',
    });
    setIsDialogOpen(true);
  };

  const handleEditOrganization = (org: Organization) => {
    setEditingOrganization(org);
    setFormData({
      name: org.name,
      logoUrl: org.logoUrl,
      websiteUrl: org.websiteUrl,
      type: org.type,
      showOnHomepageMarquee: org.showOnHomepageMarquee,
      displayOrder: org.displayOrder,
      isActive: org.isActive,
      isGlobal: org.isGlobal !== undefined ? org.isGlobal : true,
      description: org.description,
    });
    setIsDialogOpen(true);
  };

  const handleDeleteOrganization = async (id: string) => {
    if (!confirm("Are you sure you want to delete this organization?")) return;

    try {
      await deleteDoc(doc(firestore, 'organizations', id));
      showToast('Organization Deleted', 'The organization has been successfully deleted.');
      fetchOrganizations();
    } catch (error) {
      console.error('Error deleting organization:', error);
      showToast('Error', 'Failed to delete organization.', 'destructive');
    }
  };

  const handleSaveOrganization = async () => {
    try {
      if (editingOrganization) {
        await updateDoc(doc(firestore, 'organizations', editingOrganization.id!), {
          ...formData,
          updatedAt: new Date(),
        });
        showToast('Organization Updated', 'The organization has been successfully updated.');
      } else {
        await addDoc(collection(firestore, 'organizations'), {
          ...formData,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        showToast('Organization Created', 'The organization has been successfully created.');
      }
      
      setIsDialogOpen(false);
      fetchOrganizations();
    } catch (error) {
      console.error('Error saving organization:', error);
      showToast('Error', 'Failed to save organization.', 'destructive');
    }
  };

  if (userLoading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading admin dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageOrganizations">
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
        {/* Toast Notification */}
        {toast && (
          <div className={`fixed top-4 right-4 p-4 rounded-lg shadow-lg z-50 ${
            toast.variant === 'destructive' ? 'bg-red-100 text-red-800 border border-red-200' : 'bg-green-100 text-green-800 border border-green-200'
          }`}>
            <h4 className="font-semibold">{toast.title}</h4>
            <p className="text-sm">{toast.description}</p>
          </div>
        )}

        <div className="container mx-auto px-4 py-8">
          <div className="mb-8">
            <div className="bg-white rounded-lg shadow-md p-6 mb-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-4xl font-bold text-gray-900 mb-2">Organizations Management</h1>
                  <p className="text-gray-600">
                    Manage national chapters, institutional partners, and sponsors for the homepage credibility marquee.
                  </p>
                </div>
                <Button 
                  onClick={handleCreateOrganization}
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Organization
                </Button>
              </div>
            </div>
          </div>

          {/* Organizations Table */}
          <Card className="bg-white rounded-lg shadow-md">
            <CardHeader className="border-b">
              <CardTitle className="text-xl">Organizations</CardTitle>
              <CardDescription>
                Manage the organizations displayed in the credibility marquee section.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6">
              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex space-x-2">
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                  ))}
                </div>
              ) : organizations.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-gray-400 mb-4">
                    <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No organizations found</h3>
                  <p className="text-gray-500 mb-4">Get started by adding your first organization.</p>
                  <Button 
                    onClick={handleCreateOrganization}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    Create the first organization
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Logo</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Homepage</TableHead>
                        <TableHead>Order</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {organizations.map((org) => (
                        <TableRow key={org.id}>
                          <TableCell>
                            {org.logoUrl ? (
                              <img 
                                src={org.logoUrl} 
                                alt={org.name}
                                className="w-10 h-10 object-contain rounded border"
                              />
                            ) : (
                              <div className="w-10 h-10 bg-gray-200 rounded border flex items-center justify-center">
                                <ImageIcon className="h-4 w-4 text-gray-400" />
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="font-medium">{org.name}</TableCell>
                          <TableCell>
                            <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-xs">
                              {org.type}
                            </span>
                          </TableCell>
                          <TableCell>
                            {org.showOnHomepageMarquee ? (
                              <span className="text-green-600 font-medium">✅ Shown</span>
                            ) : (
                              <span className="text-gray-400">❌ Hidden</span>
                            )}
                          </TableCell>
                          <TableCell>{org.displayOrder}</TableCell>
                          <TableCell>
                            {org.isActive ? (
                              <span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs">
                                Active
                              </span>
                            ) : (
                              <span className="px-2 py-1 bg-red-100 text-red-800 rounded-full text-xs">
                                Inactive
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button 
                                variant="outline" 
                                size="sm"
                                onClick={() => handleEditOrganization(org)}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button 
                                variant="destructive" 
                                size="sm"
                                onClick={() => handleDeleteOrganization(org.id!)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                              {org.websiteUrl && (
                                <Button variant="ghost" size="sm" asChild>
                                  <a href={org.websiteUrl} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="h-4 w-4" />
                                  </a>
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Create/Edit Dialog */}
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>
                  {editingOrganization ? 'Edit Organization' : 'Add New Organization'}
                </DialogTitle>
                <DialogDescription>
                  {editingOrganization 
                    ? 'Make changes to the organization details.' 
                    : 'Add a new organization to the database.'
                  }
                </DialogDescription>
              </DialogHeader>
              
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Organization Name</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="e.g., SEDS Germany"
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="type">Type</Label>
                    <Select
                      value={formData.type}
                      onValueChange={(value: Organization['type']) => setFormData(prev => ({ ...prev, type: value }))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="National Chapter">National Chapter</SelectItem>
                        <SelectItem value="University">University</SelectItem>
                        <SelectItem value="Institutional Partner">Institutional Partner</SelectItem>
                        <SelectItem value="Sponsor">Sponsor</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="logoUrl">Logo URL</Label>
                  <Input
                    id="logoUrl"
                    value={formData.logoUrl}
                    onChange={(e) => setFormData(prev => ({ ...prev, logoUrl: e.target.value }))}
                    placeholder="https://example.com/logo.png"
                  />
                  <p className="text-xs text-gray-500">
                    Provide a direct URL to the organization&apos;s logo image.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="websiteUrl">Website URL</Label>
                  <Input
                    id="websiteUrl"
                    value={formData.websiteUrl}
                    onChange={(e) => setFormData(prev => ({ ...prev, websiteUrl: e.target.value }))}
                    placeholder="https://example.org"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="displayOrder">Display Order</Label>
                    <Input
                      id="displayOrder"
                      type="number"
                      value={formData.displayOrder}
                      onChange={(e) => setFormData(prev => ({ ...prev, displayOrder: parseInt(e.target.value) || 0 }))}
                      placeholder="0"
                    />
                  </div>
                  
                  <div className="flex items-center space-x-2 pt-6">
                    <Checkbox
                      id="showOnHomepageMarquee"
                      checked={formData.showOnHomepageMarquee}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, showOnHomepageMarquee: !!checked }))}
                    />
                    <Label htmlFor="showOnHomepageMarquee" className="text-sm">
                      Show on Homepage Marquee
                    </Label>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="isActive"
                      checked={formData.isActive}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, isActive: !!checked }))}
                    />
                    <Label htmlFor="isActive" className="text-sm">
                      Active (visible to users)
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="isGlobal"
                      checked={formData.isGlobal}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, isGlobal: !!checked }))}
                    />
                    <Label htmlFor="isGlobal" className="text-sm">
                      Global Organization
                    </Label>
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <p className="text-xs text-blue-700">
                    <strong>Note:</strong> Uncheck &quot;Global Organization&quot; for local SEDS Pakistan sponsors.
                    This will display them in the &quot;Our Local Supporters&quot; section instead of &quot;Global Partners & Sponsors&quot;.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="Brief description of the organization..."
                    rows={3}
                  />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
                <Button onClick={handleSaveOrganization}>
                  <Save className="h-4 w-4 mr-2" />
                  {editingOrganization ? 'Update Organization' : 'Create Organization'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </AuthorizationGate>
  );
}