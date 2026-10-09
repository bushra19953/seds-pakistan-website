"use client";

import Image from "next/image";

import React, { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, GripVertical, Building2, Image as ImageIcon, ExternalLink
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Tabs, TabsContent, TabsList, TabsTrigger, } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import ImageUploader from '@/components/admin/image-uploader';
import { useToast } from '@/hooks/use-toast';
import { useUser } from '@/firebase/auth/use-user';
import { hasPermission } from '@/config/permissions';
import { useRouter } from 'next/navigation';
import { useFirestore } from '@/firebase';
import { collection, doc, getDocs, query, orderBy } from 'firebase/firestore';
import { addDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

;

interface Organization {
  id?: string;
  name: string;
  logoUrl: string;
  websiteUrl: string;
  type: 'National Chapter' | 'International Chapter' | 'Institutional Partner' | 'Sponsor' | 'University';
  showOnHomepageMarquee: boolean;
  displayOrder: number;
  isActive: boolean;
  isGlobal: boolean;
  description: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const ORGANIZATION_TYPES = [
  'National Chapter',
  'International Chapter',
  'Institutional Partner',
  'University',
  'Sponsor'
] as const;

export default function AdminOrganizationsPage() {
  const { user, role, isLoading: userLoading, error: userError } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();
  
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrganizations, setSelectedOrganizations] = useState<Set<string>>(new Set());
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingOrganization, setEditingOrganization] = useState<Organization | null>(null);
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>(ORGANIZATION_TYPES[0]);

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

  // Drag and drop handlers
  const handleDragStart = (id: string) => {
    setDraggedItem(id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, targetId: string, type: string) => {
    e.preventDefault();
    if (!draggedItem || draggedItem === targetId) return;

    const typeOrgs = organizations.filter(org => org.type === type);
    const draggedIndex = typeOrgs.findIndex(org => org.id === draggedItem);
    const targetIndex = typeOrgs.findIndex(org => org.id === targetId);
    
    // Update display order only within the same type
    const updatedOrgs = [...organizations];
    typeOrgs.forEach((org, index) => {
      const orgIndex = updatedOrgs.findIndex(o => o.id === org.id);
      if (index === draggedIndex) {
        updatedOrgs[orgIndex] = { ...org, displayOrder: targetIndex };
      } else if (index === targetIndex) {
        updatedOrgs[orgIndex] = { ...org, displayOrder: draggedIndex };
      } else {
        updatedOrgs[orgIndex] = { ...org, displayOrder: index };
      }
    });
    
    setOrganizations(updatedOrgs);
    setDraggedItem(null);
    
    try {
      // Update display order in database
      const updatePromises = typeOrgs.map(org =>
        updateDoc(doc(firestore, 'organizations', org.id!), {
          displayOrder: org.id === draggedItem ? targetIndex : 
                       org.id === targetId ? draggedIndex : 
                       organizations.findIndex(o => o.id === org.id)
        })
      );
      await Promise.all(updatePromises);
      toast({
        title: "Success",
        description: "Organization order updated successfully.",
      });
    } catch (error) {
      console.error('Error updating organization order:', error);
      toast({
        title: "Error",
        description: "Failed to update organization order.",
        variant: "destructive",
      });
    }
  };

  const fetchOrganizations = async () => {
    try {
      setLoading(true);
      
      if (!firestore) {
        throw new Error('Firestore service unavailable');
      }

      const organizationsCol = collection(firestore, 'organizations');
      // Use simple order by displayOrder only to avoid composite index issues
      const q = query(organizationsCol, orderBy('displayOrder'));
      
      const snapshot = await getDocs(q);
      const items: Organization[] = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.(),
        updatedAt: doc.data().updatedAt?.toDate?.(),
      })) as Organization[];
      
      // Sort by type and display order in memory since the query is simpler
      items.sort((a, b) => {
        const typeComparison = a.type.localeCompare(b.type);
        if (typeComparison !== 0) return typeComparison;
        return a.displayOrder - b.displayOrder;
      });
      
      setOrganizations(items);
    } catch (error: any) {
      console.error('Error fetching organizations:', error);
      const errorMessage = error.code === 'permission-denied'
        ? 'Access denied. Please check your permissions.'
        : `Failed to fetch organizations: ${error.message}`;
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
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
    const typeOrgs = organizations.filter(org => org.type === activeTab);
    const isChapter = activeTab === 'National Chapter' || activeTab === 'International Chapter';
    setFormData({
      name: '',
      logoUrl: '',
      websiteUrl: '',
      type: activeTab as Organization['type'],
      showOnHomepageMarquee: false,
      displayOrder: typeOrgs.length,
      isActive: true,
      isGlobal: !isChapter || activeTab === 'International Chapter', // Chapters use type to determine global
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

  const handleDeleteOrganization = async (id: string, name: string) => {
    try {
      await deleteDoc(doc(firestore, 'organizations', id));
      toast({
        title: "Success",
        description: `${name} deleted successfully.`,
      });
      fetchOrganizations();
    } catch (error) {
      console.error('Error deleting organization:', error);
      toast({
        title: "Error",
        description: "Failed to delete organization.",
        variant: "destructive",
      });
    }
  };

  const handleSaveOrganization = async () => {
    try {
      if (editingOrganization) {
        await updateDoc(doc(firestore, 'organizations', editingOrganization.id!), {
          ...formData,
          updatedAt: new Date(),
        });
        toast({
          title: "Success",
          description: `${formData.name} updated successfully.`,
        });
      } else {
        await addDoc(collection(firestore, 'organizations'), {
          ...formData,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        toast({
          title: "Success",
          description: `${formData.name} created successfully.`,
        });
      }
      
      setIsDialogOpen(false);
      fetchOrganizations();
    } catch (error: any) {
      console.error('Error saving organization:', error);
      const errorMessage = error.code === 'permission-denied'
        ? 'Permission denied. You may not have access to modify organizations.'
        : `Failed to save organization: ${error.message}`;
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  const handleToggleVisibility = async (org: Organization, checked: boolean) => {
    try {
      await updateDoc(doc(firestore, 'organizations', org.id!), {
        showOnHomepageMarquee: checked,
        updatedAt: new Date(),
      });
      
      toast({
        title: "Success",
        description: `${org.name} ${checked ? 'now visible' : 'hidden'} on homepage.`,
      });
      fetchOrganizations();
    } catch (error) {
      console.error('Error updating visibility:', error);
      toast({
        title: "Error",
        description: "Failed to update visibility.",
        variant: "destructive",
      });
    }
  };

  const getOrganizationsByType = (type: string) => {
    return organizations
      .filter(org => org.type === type)
      .sort((a, b) => a.displayOrder - b.displayOrder);
  };

  const LogoPreview = ({ org }: { org: Organization }) => {
    const [showPlaceholder, setShowPlaceholder] = useState(false);
    
    if (org.logoUrl && !showPlaceholder) {
      return (
        <div className="relative">
          <Image 
            src={org.logoUrl} 
            alt={org.name}
            width={48} height={48}
            className="w-12 h-12 object-contain rounded-md border"
            onError={() => setShowPlaceholder(true)}
          />
        </div>
      );
    }
    return (
      <div className="w-12 h-12 bg-muted rounded-md border flex items-center justify-center">
        <ImageIcon className="h-6 w-6 text-muted-foreground" />
      </div>
    );
  };

  const OrganizationTable = ({ type }: { type: string }) => {
    const typeOrgs = getOrganizationsByType(type);
    
    if (typeOrgs.length === 0) {
      return (
        <div className="text-center py-12">
          <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No {type.toLowerCase()}s found</h3>
          <p className="text-muted-foreground mb-4">Get started by adding your first {type.toLowerCase()}.</p>
          <Button onClick={handleCreateOrganization}>
            <Plus className="h-4 w-4 mr-2" />
            Add New {type}
          </Button>
        </div>
      );
    }

    return (
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Logo</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Website</TableHead>
              <TableHead className="text-center">Display Order</TableHead>
              <TableHead className="text-center">Visible on Homepage</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {typeOrgs.map((org) => (
              <TableRow 
                key={org.id}
                draggable
                onDragStart={() => handleDragStart(org.id!)}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, org.id!, type)}
                className="cursor-move hover:bg-muted/50"
              >
                <TableCell>
                  <LogoPreview org={org} />
                </TableCell>
                <TableCell className="font-medium">{org.name}</TableCell>
                <TableCell>
                  {org.websiteUrl ? (
                    <Button variant="ghost" size="sm" asChild>
                      <a 
                        href={org.websiteUrl} 
                        target="_blank" 
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Visit
                      </a>
                    </Button>
                  ) : (
                    <span className="text-muted-foreground text-sm">No website</span>
                  )}
                </TableCell>
                <TableCell className="text-center">
                  <div className="flex items-center justify-center space-x-2">
                    <GripVertical className="h-4 w-4 text-muted-foreground" />
                    <span className="font-mono">{org.displayOrder}</span>
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <Switch
                    checked={org.showOnHomepageMarquee}
                    onCheckedChange={(checked) => handleToggleVisibility(org, checked)}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEditOrganization(org)}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteOrganization(org.id!, org.name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  };

  if (userLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (userError) {
    return (
      <div className="flex items-center justify-center py-12">
        <Card className="max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-destructive mb-4">Authentication Error</p>
            <Button onClick={() => window.location.reload()} variant="outline">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageChapters">
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button onClick={handleCreateOrganization}>
            <Plus className="h-4 w-4 mr-2" />
            Add Organization
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Organization Management</CardTitle>
            <CardDescription>
              Manage different types of organizations in separate, organized sections.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              </div>
            ) : (
              <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <TabsList className="grid w-full grid-cols-5">
                  {ORGANIZATION_TYPES.map((type) => (
                    <TabsTrigger key={type} value={type} className="flex items-center gap-1 px-2 text-xs">
                      <span className="truncate">{type}</span>
                      <Badge variant="secondary" className="ml-1 shrink-0">
                        {getOrganizationsByType(type).length}
                      </Badge>
                    </TabsTrigger>
                  ))}
                </TabsList>
                
                {ORGANIZATION_TYPES.map((type) => (
                  <TabsContent key={type} value={type} className="mt-6">
                    <OrganizationTable type={type} />
                  </TabsContent>
                ))}
              </Tabs>
            )}
          </CardContent>
        </Card>

        {/* Create/Edit Dialog */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>
                {editingOrganization ? 'Edit Organization' : 'Add New Organization'}
              </DialogTitle>
              <DialogDescription>
                {editingOrganization ? 'Update organization details.' : `Add a new ${formData.type.toLowerCase()} to the credibility marquee.`}
              </DialogDescription>
            </DialogHeader>
            
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="name" className="text-right">
                  Name
                </Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="col-span-3"
                  placeholder="Organization name"
                />
              </div>

              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="type" className="text-right">
                  Type <span className="text-red-500">*</span>
                </Label>
                <select
                  id="type"
                  value={formData.type}
                  onChange={(e) => {
                    const newType = e.target.value as Organization['type'];
                    setFormData(prev => ({
                      ...prev,
                      type: newType,
                      isGlobal: newType !== 'National Chapter' // Auto-set global flag
                    }));
                  }}
                  className="col-span-3 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {ORGANIZATION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type === 'National Chapter' ? 'National Chapter (Pakistan)' :
                       type === 'International Chapter' ? 'International Chapter (Global)' :
                       type}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="logoUrl" className="text-right">
                  Logo URL
                </Label>
                <div className="col-span-3 space-y-2">
                  <ImageUploader
                    onUploadComplete={(url) => setFormData(prev => ({ ...prev, logoUrl: url }))}
                  />
                  <Input
                    id="logoUrl"
                    value={formData.logoUrl}
                    onChange={(e) => setFormData(prev => ({ ...prev, logoUrl: e.target.value }))}
                    placeholder="https://example.com/logo.png"
                  />
                </div>
              </div>

              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="websiteUrl" className="text-right">
                  Website
                </Label>
                <Input
                  id="websiteUrl"
                  value={formData.websiteUrl}
                  onChange={(e) => setFormData(prev => ({ ...prev, websiteUrl: e.target.value }))}
                  className="col-span-3"
                  placeholder="https://example.org"
                />
              </div>

              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right">
                  Options
                </Label>
                <div className="col-span-3 space-y-3">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="showOnHomepageMarquee"
                      checked={formData.showOnHomepageMarquee}
                      onCheckedChange={(checked) =>
                        setFormData(prev => ({ ...prev, showOnHomepageMarquee: checked as boolean }))
                      }
                    />
                    <Label htmlFor="showOnHomepageMarquee" className="text-sm font-normal">
                      Visible on Homepage
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="isActive"
                      checked={formData.isActive}
                      onCheckedChange={(checked) =>
                        setFormData(prev => ({ ...prev, isActive: checked as boolean }))
                      }
                    />
                    <Label htmlFor="isActive" className="text-sm font-normal">
                      Active
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="isGlobal"
                      checked={formData.isGlobal}
                      onCheckedChange={(checked) =>
                        setFormData(prev => ({ ...prev, isGlobal: checked as boolean }))
                      }
                      disabled={formData.type === 'National Chapter'}
                    />
                    <Label htmlFor="isGlobal" className="text-sm font-normal">
                      {formData.type === 'National Chapter' ? 'Local Organization (Pakistan)' : 'International Organization'}
                    </Label>
                  </div>

                  <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
                    {formData.type === 'National Chapter' && (
                      <p>📍 Pakistani SEDS chapter - appears under &quot;Our National Chapters&quot;</p>
                    )}
                    {formData.type === 'International Chapter' && (
                      <p>🌍 International SEDS chapter (SEDS USA, SEDS UK, etc.) - appears under &quot;Our Partners & Sponsors&quot;</p>
                    )}
                    {formData.type === 'Institutional Partner' && (
                      <p>🏢 International partner - appears under &quot;Our Partners & Sponsors&quot;</p>
                    )}
                    {formData.type === 'University' && (
                      <p>🎓 International university - appears under &quot;Our Partners & Sponsors&quot;</p>
                    )}
                    {formData.type === 'Sponsor' && (
                      <p>{formData.isGlobal ? '🌍 International sponsor - appears under "Our Partners & Sponsors"' : '📍 Local sponsor - appears under "Our Local Supporters"'}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="description" className="text-right">
                  Description
                </Label>
                <textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  className="col-span-3 flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  placeholder="Brief description..."
                  rows={3}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveOrganization}
                disabled={!formData.name.trim()}
              >
                {editingOrganization ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AuthorizationGate>
  );
}