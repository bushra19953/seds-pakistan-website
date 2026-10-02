"use client";

import { useState, useEffect } from 'react';
import { useUser } from '@/firebase';
import { hasPermission } from '@/config/permissions';
import { useRouter } from 'next/navigation';
import { useFirestore } from '@/firebase';
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
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { addDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';

import { 
  Plus, 
  Edit, 
  Trash2, 
  Save, 
  X,
  Image as ImageIcon,
  ExternalLink
} from 'lucide-react';

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
  const { user, role, isLoading: userLoading } = useUser();
  const router = useRouter();
  const { showToast: toast } = useEnhancedToast();
  const firestore = useFirestore();
  
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingOrganization, setEditingOrganization] = useState<Organization | null>(null);

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

  // Check permissions
  useEffect(() => {
    if (!userLoading && user && role) {
      // Superadmin has access to everything, no redirect needed
      if (role !== 'superadmin' && !hasPermission(role, 'canManageOrganizations')) {
        router.push('/profile');
      }
    } else if (!userLoading && !user) {
      router.push('/auth/login');
    }
  }, [user, role, userLoading, router]);

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
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch organizations.",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && role) {
      fetchOrganizations();
    }
  }, [user, role]);

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
      
      toast({
        title: "Organization Deleted",
        description: "The organization has been successfully deleted.",
      });
      
      fetchOrganizations();
    } catch (error) {
      console.error('Error deleting organization:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete organization.",
      });
    }
  };

  const handleSaveOrganization = async () => {
    try {
      if (editingOrganization) {
        // Update existing organization
        await updateDoc(doc(firestore, 'organizations', editingOrganization.id!), {
          ...formData,
          updatedAt: new Date(),
        });
        
        toast({
          title: "Organization Updated",
          description: "The organization has been successfully updated.",
        });
      } else {
        // Create new organization
        await addDoc(collection(firestore, 'organizations'), {
          ...formData,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        
        toast({
          title: "Organization Created",
          description: "The organization has been successfully created.",
        });
      }
      
      setIsDialogOpen(false);
      fetchOrganizations();
    } catch (error) {
      console.error('Error saving organization:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save organization.",
      });
    }
  };

  if (userLoading || !user || !role) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading admin dashboard...</p>
      </div>
    );
  }

  // Superadmin bypass - show the page for superadmin without permission checks
  if (role !== 'superadmin' && !hasPermission(role, 'canManageOrganizations')) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading admin dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-4 mb-6">
            <h1 className="text-4xl font-bold">Organizations Management</h1>
            <Button onClick={handleCreateOrganization}>
              <Plus className="h-4 w-4 mr-2" />
              Add Organization
            </Button>
          </div>
          <p className="text-muted-foreground">
            Manage national chapters, institutional partners, and sponsors for the homepage credibility marquee.
          </p>
        </div>

        {/* Organizations Table */}
        <Card>
          <CardHeader>
            <CardTitle>Organizations</CardTitle>
            <CardDescription>
              Manage the organizations displayed in the credibility marquee section.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={5} columns={6} />
            ) : organizations.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No organizations found.</p>
                <Button className="mt-4" onClick={handleCreateOrganization}>
                  Create the first organization
                </Button>
              </div>
            ) : (
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
                          <div className="w-10 h-10 bg-muted rounded border flex items-center justify-center">
                            <ImageIcon className="h-4 w-4" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{org.name}</TableCell>
                      <TableCell>{org.type}</TableCell>
                      <TableCell>
                        {org.showOnHomepageMarquee ? (
                          <span className="text-green-600">✅ Shown</span>
                        ) : (
                          <span className="text-muted-foreground">❌ Hidden</span>
                        )}
                      </TableCell>
                      <TableCell>{org.displayOrder}</TableCell>
                      <TableCell>
                        {org.isActive ? (
                          <span className="text-green-600">Active</span>
                        ) : (
                          <span className="text-red-600">Inactive</span>
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
                <p className="text-xs text-muted-foreground">
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

              <div className="bg-muted/30 border border-border/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">
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
  );
}

function TableSkeleton({ rows, columns }: { rows: number; columns: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex space-x-2">
          {Array.from({ length: columns }).map((_, j) => (
            <Skeleton key={j} className="h-4 w-24" />
          ))}
        </div>
      ))}
    </div>
  );
}