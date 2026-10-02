"use client";

import { useState, useEffect } from 'react';
// Uses persistent layout at app/admin/layout.tsx
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';
import { getFirestore, collection, query, where, orderBy, getDocs, getDoc, doc, serverTimestamp, Query, DocumentData } from 'firebase/firestore';
;
import { getFirebaseApp } from '@/firebase/provider';
import { handleFirestoreError, FirestoreErrorContext, getUserFriendlyErrorMessage } from '@/firebase/error-handler';
import { logAuditEntry } from '@/lib/audit-logging';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loader2, Eye, Check, X, UserPlus, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TableSkeleton } from '@/components/ui/loading-states';
import ApplicationList, { type ApplicationListItem } from '@/components/admin/applications/application-list';
import InductionFormEditor from '@/components/admin/applications/induction-form-editor';
import { updateDoc, deleteDoc, setDoc } from '@/lib/client/firestore-wrapper';


interface Application {
  uid: string;
  email: string;
  fullName: string;
  university: string;
  department: string;
  studyYear: string;
  // Hotfix: skills and interestAreas can arrive as either arrays or strings
  // We accept both types here to match real Firestore data and avoid runtime errors
  skills?: string[] | string;
  interestAreas?: string[] | string;
  availability?: string;
  resume_url?: string;
  portfolioLink?: string;
  githubLink?: string;
  status: 'pending' | 'under_review' | 'shortlisted' | 'rejected' | 'on_hold';
  created_at: any; // Firebase Timestamp
  updated_at: any; // Firebase Timestamp
  pre_score?: number;
  [key: string]: any; // Allow arbitrary fields from dynamic induction form (e.g., Mobile Number)
}

// Defensive formatter: gracefully render list-like fields that may be arrays or strings
// - If array: join with commas
// - If string: trim; if contains commas, split and normalize, otherwise show as single value
// - Fallback: 'N/A' when empty/invalid (keeps UI consistent)
function formatListField(field: unknown): string {
  if (Array.isArray(field)) {
    return field.filter(Boolean).join(', ');
  }
  if (typeof field === 'string') {
    const trimmed = field.trim();
    if (!trimmed) return 'N/A';
    const parts = trimmed.includes(',')
      ? trimmed.split(',').map((s) => s.trim()).filter(Boolean)
      : [trimmed];
    return parts.length ? parts.join(', ') : 'N/A';
  }
  return 'N/A';
}

export default function AdminApplicationsPage() {
  const { user, role } = useUser();
  const { toast } = useToast();

  const [applications, setApplications] = useState<Application[]>([]);
  const [loadingApplications, setLoadingApplications] = useState(true);
  const [selectedApplication, setSelectedApplication] = useState<Application | null>(null);
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<Application['status'] | 'all'>('pending');
  const [sortBy, setSortBy] = useState<'created_at' | 'pre_score'>('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const [formConfig, setFormConfig] = useState<any[]>([]);

  useEffect(() => {
    const fetchConfig = async () => {
      const db = getFirestore(getFirebaseApp());
      const snap = await getDoc(doc(db, 'settings', 'induction_form'));
      if (snap.exists() && snap.data().fields) {
        setFormConfig(snap.data().fields);
      }
    };
    fetchConfig();
  }, []);

  const renderApplicantResponses = (app: Application) => {
    // Sort config by order
    const sortedConfig = [...formConfig].sort((a, b) => (a.order || 0) - (b.order || 0));

    // Create a set of keys we displayed via config to handle any "orphaned" or old data later
    const displayedKeys = new Set();

    const elements = sortedConfig.map(field => {
      const value = (app as any)[field.name];
      if (value === undefined || value === null) return null;
      displayedKeys.add(field.name);

      const formattedValue = formatListField(value);

      if (typeof value === 'string' && value.startsWith('http')) {
        return (
          <div key={field.id} className="bg-slate-950 p-3 rounded border border-slate-800/50">
            <strong className="capitalize text-slate-400 block mb-1 text-sm">{field.label}</strong>
            <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 hover:underline font-mono text-sm break-all">
              {value}
            </a>
          </div>
        );
      }

      return (
        <div key={field.id} className="bg-slate-950 p-3 rounded border border-slate-800/50">
          <strong className="capitalize text-slate-400 block mb-1 text-sm">{field.label}</strong>
          <span className="text-slate-200">{formattedValue}</span>
        </div>
      );
    });

    // Also display any data that is in the application but NOT in the current form config (legacy fields)
    const omitKeys = ['uid', 'status', 'created_at', 'updated_at', 'last_saved_at', 'resume_url', 'pre_score', 'portfolioLink', 'githubLink'];
    const legacyElements = Object.entries(app)
      .filter(([key]) => !displayedKeys.has(key) && !omitKeys.includes(key))
      .map(([key, value]) => {
        const formattedValue = formatListField(value);
        const displayKey = key.replace(/([A-Z])/g, ' $1').trim();
        return (
          <div key={key} className="bg-slate-950/50 p-3 rounded border border-slate-800/30 border-dashed">
            <strong className="capitalize text-slate-500 block mb-1 text-xs">{displayKey} (Legacy)</strong>
            <span className="text-slate-400 text-sm">{formattedValue}</span>
          </div>
        );
      });

    return [...elements, ...legacyElements];
  };

  // Data fetching for the list is handled inside the ApplicationList component now.

  const fetchApplications = async () => {
    setLoadingApplications(true);
    const db = getFirestore(getFirebaseApp());
    const applicationsRef = collection(db, 'applications');
    let q: Query<DocumentData> = applicationsRef;

    if (filterStatus !== 'all') {
      q = query(applicationsRef, where('status', '==', filterStatus));
    }

    q = query(q, orderBy(sortBy, sortOrder));

    try {
      const querySnapshot = await getDocs(q);

      const fetchedApplications: Application[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data() as Application;
        fetchedApplications.push({
          ...data,
          uid: doc.id
        });
      });
      setApplications(fetchedApplications);
    } catch (error) {
      console.error('❌ AdminApplicationsPage - Error fetching applications:', error);
      const errorContext: FirestoreErrorContext = {
        operation: 'list',
        collection: 'applications',
        additionalContext: { status: filterStatus }
      };
      const handledError = handleFirestoreError(error, { context: errorContext });
      toast({
        variant: "destructive",
        title: "Error",
        description: getUserFriendlyErrorMessage(handledError),
      });
    } finally {
      setLoadingApplications(false);
    }
  };

  const updateApplicationStatus = async (applicationId: string, status: string, reason?: string) => {
    try {
      const db = getFirestore(getFirebaseApp());

      // Update application status
      await updateDoc(doc(db, 'applications', applicationId), {
        status: status,
        reviewed_at: serverTimestamp(),
        reviewed_by: user?.uid,
        rejection_reason: reason || null
      });

      // Log audit entry
      await logAuditEntry(db, 'application_status_updated', user!.uid, applicationId, {
        new_status: status,
        rejection_reason: reason
      });

      // List updates in real-time via ApplicationList; no manual refresh needed

      toast({
        title: 'Success',
        description: `Application ${status}`,
      });
    } catch (error) {
      console.error('❌ AdminApplicationsPage - Error updating application status:', error);
      toast({
        title: 'Error',
        description: 'Failed to update application status',
        variant: 'destructive',
      });
      throw error;
    }
  };

  const handleShortlist = async (app: Application) => {
    const db = getFirestore(getFirebaseApp());
    try {
      // 1. Update application status to shortlisted
      await updateApplicationStatus(app.uid, 'shortlisted');

      // 2. Create invite document
      const inviteId = doc(collection(db, 'invites')).id; // Generate a new UUID
      const inviteLink = `${typeof window !== 'undefined' ? window.location.origin : ''}/signup?invite=${inviteId}`;

      await setDoc(doc(db, 'invites', inviteId), {
        email: app.email,
        role: 'member',
        createdBy: user?.uid,
        createdAt: serverTimestamp(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Invite valid for 7 days
        usedBy: null,
        usedAt: null,
      });

      // 3. Log audit entry for invite creation
      await logAuditEntry(db, 'invite_created', user?.uid || '', inviteId, {
        invited_email: app.email,
        role: 'member',
        application_uid: app.uid
      });

      // 4. Provide invite link to admin
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(inviteLink);
      }
      toast({
        title: "Application Shortlisted & Invite Created!",
        description: `An invite link for ${app.email} has been created and copied to your clipboard.`,
        duration: 10000,
      });
    } catch (error) {
      console.error('❌ AdminApplicationsPage - Error shortlisting application:', error);
      const errorContext: FirestoreErrorContext = {
        operation: 'create',
        collection: 'users',
        documentId: app.email,
        additionalContext: { applicationId: app.uid }
      };

      const handledError = handleFirestoreError(error, { context: errorContext });

      toast({
        title: 'Error',
        description: getUserFriendlyErrorMessage(handledError),
        variant: 'destructive',
      });
      throw error;
    }
  };

  const handleReject = async (app: Application) => {
    const adminNote = typeof window !== 'undefined' ? prompt("Reason for rejection (optional):") : null;

    if (adminNote !== null) {
      await updateApplicationStatus(app.uid, 'rejected', adminNote || undefined);
    }
  };

  const handleDelete = async (app: Application) => {
    if (!window.confirm(`Are you sure you want to completely delete the application for ${app.fullName}? They will be able to apply again from scratch.`)) {
      return;
    }

    try {
      const db = getFirestore(getFirebaseApp());
      await deleteDoc(doc(db, 'applications', app.uid));

      await logAuditEntry(db, 'application_deleted', user!.uid, app.uid, {
        applicant_email: app.email,
        applicant_name: app.fullName
      });

      toast({
        title: 'Application Purged',
        description: 'The application has been deleted. The user is now free to apply again.',
      });

      setSelectedApplication(null);
      setSelectedApplicationId(null);
    } catch (error) {
      console.error('❌ AdminApplicationsPage - Error deleting app:', error);
      toast({
        title: 'Deletion Failed',
        description: 'Unable to delete the application document.',
        variant: 'destructive',
      });
    }
  };


  return (
    <AuthorizationGate permission="canManageApplications">
      <>
        <div className="mb-4 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
          <div>
            <h1 className="text-4xl font-bold text-glow mb-2">Induction Applications</h1>
            <p className="text-muted-foreground">Review and manage all incoming applications</p>
          </div>
          <InductionFormEditor />
        </div>
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Application List Pane */}
          <ApplicationList
            selectedApplicationId={selectedApplicationId}
            onSelectApplication={(app: ApplicationListItem) => {
              setSelectedApplicationId(app.uid);
              setSelectedApplication(app as unknown as Application);
            }}
          />

          {/* Application Detail Pane */}
          <Card className="w-full lg:w-1/3 bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
            <CardHeader>
              <CardTitle>Application Details</CardTitle>
              <CardDescription>{selectedApplication?.fullName || "Select an application to view details"}</CardDescription>
            </CardHeader>
            <CardContent>
              {selectedApplication ? (
                <div className="space-y-4">
                  <div className="flex flex-col gap-2 bg-slate-900/50 p-4 rounded-lg border border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-300">Status:</span>
                      <Badge variant="secondary" className="uppercase tracking-wide px-3">{selectedApplication.status}</Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-300">Applied On:</span>
                      <span className="text-emerald-400 font-mono text-sm">{selectedApplication.created_at?.toDate().toLocaleString() || 'N/A'}</span>
                    </div>
                  </div>

                  <div className="border-t border-slate-800 pt-6 mt-6 grid grid-cols-1 gap-4">
                    <h3 className="font-semibold text-lg text-primary mb-2">Applicant Responses</h3>
                    {selectedApplication && renderApplicantResponses(selectedApplication)}








                  </div>

                  {selectedApplication.resume_url && (
                    <div>
                      <h3 className="font-semibold mt-4">Resume:</h3>
                      <Button asChild variant="outline" size="sm" className="mt-2">
                        <a href={selectedApplication.resume_url} target="_blank" rel="noopener noreferrer">View Resume (PDF)</a>
                      </Button>
                    </div>
                  )}

                  <div className="flex gap-2 mt-4 pt-4 border-t border-slate-800">
                    <Button onClick={() => handleShortlist(selectedApplication)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                      <Check className="h-4 w-4 mr-2" /> Shortlist
                    </Button>
                    <Button onClick={() => handleReject(selectedApplication)} variant="secondary" className="bg-slate-800 hover:bg-slate-700 text-white">
                      <X className="h-4 w-4 mr-2" /> Reject
                    </Button>
                    <div className="flex-1" />
                    <Button onClick={() => handleDelete(selectedApplication)} variant="destructive" className="bg-red-900/50 hover:bg-red-900 text-red-200 border border-red-800 hover:text-white">
                      <Trash2 className="h-4 w-4 mr-2" /> Delete App
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground">Select an application from the list to view its full details and take action.</p>
              )}
            </CardContent>
          </Card>
        </div >
      </>
    </AuthorizationGate >
  );
}
