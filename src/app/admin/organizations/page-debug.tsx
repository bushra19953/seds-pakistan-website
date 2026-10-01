"use client";

import { useState, useEffect } from 'react';
import { useUser } from '@/firebase';
import { useRouter } from 'next/navigation';
import { useFirestore } from '@/firebase';
import { collection, getDocs } from 'firebase/firestore';

export default function DebugOrganizationsPage() {
  const { user, role, isLoading, error } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  
  const [debugInfo, setDebugInfo] = useState<any>({});

  useEffect(() => {
    setDebugInfo({
      user: user ? { uid: user.uid, email: user.email } : null,
      role: role,
      isLoading: isLoading,
      error: error ? error.message : null,
      timestamp: new Date().toISOString()
    });
  }, [user, role, isLoading, error]);

  const testFirestore = async () => {
    if (!firestore) {
      setDebugInfo((prev: any) => ({ ...prev, firestore: 'Firebase not initialized' }));
      return;
    }
    
    try {
      const organizationsCol = collection(firestore, 'organizations');
      const snapshot = await getDocs(organizationsCol);
      setDebugInfo((prev: any) => ({ 
        ...prev, 
        firestore: `Connected. Found ${snapshot.docs.length} organizations`
      }));
    } catch (error: any) {
      setDebugInfo((prev: any) => ({ 
        ...prev, 
        firestore: `Error: ${error.code} - ${error.message}`
      }));
    }
  };

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/auth/login');
    }
  }, [user, isLoading, router]);

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">Organizations Page - Debug View</h1>
          
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-2">Authentication State</h2>
              <div className="bg-gray-50 p-4 rounded border text-sm">
                <pre>{JSON.stringify(debugInfo, null, 2)}</pre>
              </div>
            </div>

            <div>
              <h2 className="text-lg font-semibold mb-2">Actions</h2>
              <div className="space-x-2">
                <button 
                  onClick={testFirestore}
                  className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                >
                  Test Firestore Connection
                </button>
                <button 
                  onClick={() => window.location.reload()}
                  className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
                >
                  Refresh Page
                </button>
              </div>
            </div>

            <div>
              <h2 className="text-lg font-semibold mb-2">Recommendations</h2>
              <div className="bg-yellow-50 border border-yellow-200 p-4 rounded">
                <p className="text-sm text-yellow-800">
                  <strong>If stuck in loading:</strong>
                </p>
                <ul className="list-disc list-inside mt-2 text-sm text-yellow-700">
                  <li>Check browser console for errors (F12)</li>
                  <li>Ensure you're logged in to the application</li>
                  <li>Verify Firebase project permissions</li>
                  <li>Check network connectivity to firestore.googleapis.com</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">Loading authentication...</p>
            <p className="mt-2 text-sm text-gray-500">
              This usually takes 2-3 seconds. If it continues longer, there may be an issue.
            </p>
          </div>
        ) : !user ? (
          <div className="text-center py-12">
            <p className="text-gray-600">No user logged in. Redirecting to login...</p>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p className="text-red-600">Authentication error: {error.message}</p>
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-green-600">Authentication successful!</p>
            <p className="mt-2 text-gray-600">User: {user.email}</p>
            <p className="text-gray-600">Role: {role || 'No role assigned'}</p>
          </div>
        )}
      </div>
    </div>
  );
}