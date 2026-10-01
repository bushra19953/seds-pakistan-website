"use client";

import { useState, useEffect } from 'react';
import { useFirestore } from '@/firebase';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';

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

export default function TestOrganizationsPage() {
  const firestore = useFirestore();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string>('');

  useEffect(() => {
    const fetchOrganizations = async () => {
      try {
        setDebugInfo('Starting Firestore connection test...');
        
        if (!firestore) {
          setError('Firestore not available');
          setLoading(false);
          return;
        }

        setDebugInfo('Firestore instance available. Querying organizations...');
        
        const organizationsCol = collection(firestore, 'organizations');
        const q = query(organizationsCol, orderBy('displayOrder', 'asc'));
        
        setDebugInfo('Executing query...');
        const snapshot = await getDocs(q);
        
        setDebugInfo(`Query successful. Found ${snapshot.docs.length} documents.`);
        
        const items: Organization[] = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
          createdAt: doc.data().createdAt?.toDate?.(),
          updatedAt: doc.data().updatedAt?.toDate?.(),
        })) as Organization[];
        
        setOrganizations(items);
        setLoading(false);
      } catch (error: any) {
        console.error('Error fetching organizations:', error);
        setError(`Error: ${error.code} - ${error.message}`);
        setLoading(false);
        setDebugInfo(`Error occurred: ${error.message}`);
      }
    };

    fetchOrganizations();
  }, [firestore]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading organizations...</p>
          <div className="mt-4 text-sm text-gray-500 text-left max-w-md">
            <p><strong>Debug Info:</strong></p>
            <pre>{debugInfo}</pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-6xl mx-auto px-4">
        <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Organizations Test Page</h1>
          <div className="bg-blue-50 border border-blue-200 p-4 rounded mb-4">
            <p className="text-blue-800 text-sm">
              <strong>Debug Mode:</strong> This page bypasses authentication to test Firestore connectivity.
            </p>
          </div>
          {error && (
            <div className="bg-red-50 border border-red-200 p-4 rounded mb-4">
              <p className="text-red-800"><strong>Error:</strong> {error}</p>
            </div>
          )}
          <div className="bg-gray-50 border border-gray-200 p-4 rounded mb-4">
            <p className="text-gray-700"><strong>Debug Info:</strong></p>
            <pre className="text-xs mt-2">{debugInfo}</pre>
          </div>
          <p className="text-gray-600">
            Found {organizations.length} organizations in Firestore.
          </p>
        </div>

        {organizations.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 mb-4">
              <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No organizations found</h3>
            <p className="text-gray-500 mb-4">The organizations collection is empty.</p>
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
                          onError={(e) => {
                            e.currentTarget.src = '/placeholder-org.png';
                          }}
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
                        <button className="text-blue-600 hover:text-blue-900">
                          Edit
                        </button>
                        <button className="text-red-600 hover:text-red-900">
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
  );
}