"use client";

import { useState, useEffect } from 'react';
import { useUser } from '@/firebase';
import { hasPermission } from '@/config/permissions';
import { useRouter } from 'next/navigation';
import { useFirestore } from '@/firebase';
import { collection, doc, getDocs, query, orderBy } from 'firebase/firestore';
import { addDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';

;

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
  const firestore = useFirestore();
  
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingOrganization, setEditingOrganization] = useState<Organization | null>(null);
  const [showToast, setShowToast] = useState<{message: string, type: 'success' | 'error'} | null>(null);

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
      if (role !== 'superadmin' && !hasPermission(role, 'canManageOrganizations')) {
        router.push('/profile');
      }
    } else if (!userLoading && !user) {
      router.push('/auth/login');
    }
  }, [user, role, userLoading, router]);

  const showToastMessage = (message: string, type: 'success' | 'error' = 'success') => {
    setShowToast({ message, type });
    setTimeout(() => setShowToast(null), 3000);
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
      showToastMessage('Failed to fetch organizations', 'error');
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
      showToastMessage('Organization deleted successfully');
      fetchOrganizations();
    } catch (error) {
      console.error('Error deleting organization:', error);
      showToastMessage('Failed to delete organization', 'error');
    }
  };

  const handleSaveOrganization = async () => {
    try {
      if (editingOrganization) {
        await updateDoc(doc(firestore, 'organizations', editingOrganization.id!), {
          ...formData,
          updatedAt: new Date(),
        });
        showToastMessage('Organization updated successfully');
      } else {
        await addDoc(collection(firestore, 'organizations'), {
          ...formData,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        showToastMessage('Organization created successfully');
      }
      
      setIsDialogOpen(false);
      fetchOrganizations();
    } catch (error) {
      console.error('Error saving organization:', error);
      showToastMessage('Failed to save organization', 'error');
    }
  };

  if (userLoading || !user || !role) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (role !== 'superadmin' && !hasPermission(role, 'canManageOrganizations')) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-gray-600">Access denied</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      {/* Toast Notification */}
      {showToast && (
        <div className={`fixed top-4 right-4 p-4 rounded-md shadow-lg z-50 ${
          showToast.type === 'error' ? 'bg-red-100 text-red-800 border border-red-300' : 'bg-green-100 text-green-800 border border-green-300'
        }`}>
          {showToast.message}
        </div>
      )}

      <div className="max-w-6xl mx-auto px-4">
        <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">Organizations Management</h1>
              <p className="text-gray-600">
                Manage national chapters, institutional partners, and sponsors for the homepage credibility marquee.
              </p>
            </div>
            <button 
              onClick={handleCreateOrganization}
              className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 flex items-center gap-2"
            >
              <span>Add Organization</span>
            </button>
          </div>
        </div>

        {/* Organizations Table */}
        <div className="bg-white rounded-lg shadow-sm border">
          <div className="px-6 py-4 border-b">
            <h2 className="text-lg font-semibold text-gray-900">Organizations</h2>
            <p className="text-sm text-gray-600">Manage the organizations displayed in the credibility marquee section.</p>
          </div>
          <div className="p-6">
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex space-x-4">
                    <div className="h-4 bg-gray-200 rounded w-16"></div>
                    <div className="h-4 bg-gray-200 rounded w-32"></div>
                    <div className="h-4 bg-gray-200 rounded w-24"></div>
                    <div className="h-4 bg-gray-200 rounded w-16"></div>
                    <div className="h-4 bg-gray-200 rounded w-16"></div>
                    <div className="h-4 bg-gray-200 rounded w-16"></div>
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
                <button 
                  onClick={handleCreateOrganization}
                  className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
                >
                  Create the first organization
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Logo</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Homepage</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {organizations.map((org) => (
                      <tr key={org.id}>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {org.logoUrl ? (
                            <img 
                              src={org.logoUrl} 
                              alt={org.name}
                              className="w-10 h-10 object-contain rounded border"
                            />
                          ) : (
                            <div className="w-10 h-10 bg-gray-200 rounded border flex items-center justify-center">
                              <span className="text-gray-400 text-xs">No Logo</span>
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{org.name}</td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-xs">
                            {org.type}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          {org.showOnHomepageMarquee ? (
                            <span className="text-green-600 font-medium">✅ Shown</span>
                          ) : (
                            <span className="text-gray-400">❌ Hidden</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{org.displayOrder}</td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {org.isActive ? (
                            <span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs">Active</span>
                          ) : (
                            <span className="px-2 py-1 bg-red-100 text-red-800 rounded-full text-xs">Inactive</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          <div className="flex space-x-2">
                            <button 
                              onClick={() => handleEditOrganization(org)}
                              className="text-blue-600 hover:text-blue-900"
                            >
                              Edit
                            </button>
                            <button 
                              onClick={() => handleDeleteOrganization(org.id!)}
                              className="text-red-600 hover:text-red-900"
                            >
                              Delete
                            </button>
                            {org.websiteUrl && (
                              <a 
                                href={org.websiteUrl} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-gray-600 hover:text-gray-900"
                              >
                                Link
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create/Edit Modal */}
      {isDialogOpen && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {editingOrganization ? 'Edit Organization' : 'Add New Organization'}
              </h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="Organization name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData(prev => ({ ...prev, type: e.target.value as Organization['type'] }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="National Chapter">National Chapter</option>
                    <option value="University">University</option>
                    <option value="Institutional Partner">Institutional Partner</option>
                    <option value="Sponsor">Sponsor</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Logo URL</label>
                  <input
                    type="url"
                    value={formData.logoUrl}
                    onChange={(e) => setFormData(prev => ({ ...prev, logoUrl: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="https://example.com/logo.png"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
                  <input
                    type="url"
                    value={formData.websiteUrl}
                    onChange={(e) => setFormData(prev => ({ ...prev, websiteUrl: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="https://example.org"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Display Order</label>
                  <input
                    type="number"
                    value={formData.displayOrder}
                    onChange={(e) => setFormData(prev => ({ ...prev, displayOrder: parseInt(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>

                <div className="space-y-2">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.showOnHomepageMarquee}
                      onChange={(e) => setFormData(prev => ({ ...prev, showOnHomepageMarquee: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm">Show on Homepage Marquee</span>
                  </label>

                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.isActive}
                      onChange={(e) => setFormData(prev => ({ ...prev, isActive: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm">Active (visible to users)</span>
                  </label>

                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.isGlobal}
                      onChange={(e) => setFormData(prev => ({ ...prev, isGlobal: e.target.checked }))}
                      className="mr-2"
                    />
                    <span className="text-sm">Global Organization</span>
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description (Optional)</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    rows={3}
                    placeholder="Brief description..."
                  />
                </div>
              </div>

              <div className="flex justify-end space-x-2 mt-6">
                <button
                  onClick={() => setIsDialogOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveOrganization}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
                >
                  {editingOrganization ? 'Update' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}