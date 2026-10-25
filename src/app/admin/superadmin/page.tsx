'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFirestore } from '@/firebase';
import { collection, query, orderBy, limit, startAfter, getDocs, getCountFromServer, type QueryDocumentSnapshot } from 'firebase/firestore';
import { handleFirestoreError, FirestoreErrorContext, getUserFriendlyErrorMessage } from '@/firebase/error-handler';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { createInvite } from '@/lib/invite-system';
import { assignRole } from '@/lib/role-management';
import { refreshTokenAfterRoleChange } from '@/lib/authority-refresh';
import { USER_ROLES } from '@/lib/roles';
import { CATEGORY_B_ROLE_KEYS } from '@/lib/server/consent-gate-types';
import Link from 'next/link';
import { Eye, Users, FileText, Calendar, BookOpen, Wrench } from 'lucide-react';
import Footer from '@/components/layout/footer';

// Read-burn census F4: audit_logs page size for the Recent Activity list,
// cursor-paginated the same way as the dedicated audit-logs page.
const AUDIT_LOG_PAGE_SIZE = 50;

// Client half of the admin-audit Supa gate for TOTALS ONLY: when
// NEXT_PUBLIC_SUPA_SURFACES includes 'admin-audit', the two totals come
// from /api/admin/audit-logs?mode=totals (fs_users + fs_audit_logs counts).
// The recent-activity LIST below stays on Firestore this wave (merge
// plan C-09) and is not rewired here.
const SUPA_AUDIT_TOTALS_ENABLED = (process.env.NEXT_PUBLIC_SUPA_SURFACES || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .some((s) => s === 'admin-audit' || s === '*');

export default function SuperAdminDashboardPage() {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [creatingInvite, setCreatingInvite] = useState(false);


  // Read-burn census F4: this page previously read the ENTIRE users and
  // audit_logs collections on every mount (U + A: ~4,222 reads central, up
  // to ~15,222). It only displays two totals plus the recent-activity
  // list, so the totals now come from count aggregations (1 read per
  // 1,000 documents counted; the pattern the analytics page already uses)
  // and the list is cursor-paginated exactly like the dedicated
  // audit-logs page (orderBy timestamp desc + limit + startAfter).
  const [totalUsers, setTotalUsers] = useState(0);
  const [auditLogTotal, setAuditLogTotal] = useState(0);
  const [auditLogsData, setAuditLogsData] = useState<any[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(true);
  const [auditLogsLoadingMore, setAuditLogsLoadingMore] = useState(false);
  const [auditLogsCursor, setAuditLogsCursor] = useState<QueryDocumentSnapshot | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const loadAuditLogs = async (loadMore = false) => {
    if (!firestore) return;
    if (loadMore) setAuditLogsLoadingMore(true); else setAuditLogsLoading(true);
    try {
      let logsQuery = query(
        collection(firestore, 'audit_logs'),
        orderBy('timestamp', 'desc'),
        limit(AUDIT_LOG_PAGE_SIZE)
      );
      if (loadMore && auditLogsCursor) {
        logsQuery = query(logsQuery, startAfter(auditLogsCursor));
      }
      const snapshot = await getDocs(logsQuery);
      const page = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      if (!isMounted.current) return;
      setAuditLogsData((prev) => (loadMore ? [...prev, ...page] : page));
      setAuditLogsCursor(snapshot.docs[snapshot.docs.length - 1] ?? null);
    } catch (error) {
      console.error('Error fetching audit logs:', error);
    } finally {
      if (isMounted.current) {
        setAuditLogsLoading(false);
        setAuditLogsLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    if (!firestore) return;
    (async () => {
      // Supa totals branch: any failure falls through to the Firestore
      // count aggregations below, unchanged.
      if (SUPA_AUDIT_TOTALS_ENABLED && user) {
        try {
          const token = await user.getIdToken();
          const res = await fetch('/api/admin/audit-logs?mode=totals', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const data = await res.json();
            if (isMounted.current) {
              setTotalUsers(data.totalUsers || 0);
              setAuditLogTotal(data.totalAuditLogs || 0);
            }
            return;
          }
        } catch {
          // fall through to Firestore counts
        }
      }
      try {
        const usersAgg = await getCountFromServer(collection(firestore, 'users'));
        if (isMounted.current) setTotalUsers(usersAgg.data().count || 0);
      } catch {
        if (isMounted.current) setTotalUsers(0);
      }
      try {
        const logsAgg = await getCountFromServer(collection(firestore, 'audit_logs'));
        if (isMounted.current) setAuditLogTotal(logsAgg.data().count || 0);
      } catch {
        if (isMounted.current) setAuditLogTotal(0);
      }
    })();
    loadAuditLogs();
    // Mount-only fetch: loadAuditLogs reads the cursor state at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firestore]);

  const handleCreateInvite = async () => {
    if (!inviteEmail || !inviteRole) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please fill in all fields.",
      });
      return;
    }

    setCreatingInvite(true);
    try {
      await createInvite(firestore, inviteEmail, inviteRole, user?.uid || '');
      toast({
        title: "Invite Created",
        description: `Invite sent to ${inviteEmail} for role: ${USER_ROLES[inviteRole as keyof typeof USER_ROLES]}`,
      });
      setInviteEmail('');
      setInviteRole('member');
    } catch (error) {
      console.error("Error creating invite:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to create invite.",
      });
    } finally {
      setCreatingInvite(false);
    }
  };


  return (
    <AuthorizationGate permission="canManagePermissions">
      <div className="relative min-h-screen">
        <StarryBackground />
        
        <main className="container mx-auto px-4 py-8 relative z-10">
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Super Admin Dashboard</h1>
            <p className="text-muted-foreground">Advanced administrative controls and system management</p>
          </div>

          {/* Superadmin: Change My Public Role */}
          <SelfRoleCard />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            {/* Create Invite Card */}
            <Card className="bg-card/80 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Create User Invite
                </CardTitle>
                <CardDescription>Send invitation to new users with specific roles</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="invite-email">Email Address</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      placeholder="user@example.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="invite-role">Role</Label>
                    <Select value={inviteRole} onValueChange={setInviteRole}>
                      <SelectTrigger id="invite-role">
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(USER_ROLES)
                          // Phase 2 (spec B.3a.5): Category B offices are
                          // Reserved Matters and cannot be offered by invite.
                          .filter(([key]) => !CATEGORY_B_ROLE_KEYS.includes(key))
                          .map(([key, label]) => (
                            <SelectItem key={key} value={key}>
                              {label}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button 
                    onClick={handleCreateInvite} 
                    disabled={creatingInvite || !inviteEmail}
                    className="w-full"
                  >
                    {creatingInvite ? 'Creating...' : 'Create Invite'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Quick Stats Card */}
            <Card className="bg-card/80 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Eye className="h-5 w-5" />
                  System Overview
                </CardTitle>
                <CardDescription>Quick statistics and system health</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Users:</span>
                    <span className="font-semibold">{totalUsers}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Recent Activity:</span>
                    <span className="font-semibold">{auditLogTotal} logs</span>
                  </div>
                  <div className="flex justify-between">
                      <span className="text-muted-foreground">Your Role:</span>
                      <span className="font-semibold text-red-500">{USER_ROLES[role as keyof typeof USER_ROLES]}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Recent Activity */}
          <Card className="bg-card/80 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Recent Activity
              </CardTitle>
              <CardDescription>Latest system events and user actions</CardDescription>
            </CardHeader>
            <CardContent>
              {auditLogsLoading ? (
                <p>Loading recent activity...</p>
              ) : auditLogsData && auditLogsData.length > 0 ? (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {auditLogsData.slice(0, 10).map((log: any, index: number) => (
                    <div key={index} className="flex justify-between items-center p-2 bg-muted rounded">
                      <div>
                        <span className="font-medium capitalize">{log.action?.replace('_', ' ')}</span>
                        {log.userId && <span className="text-sm text-muted-foreground ml-2">by {log.userId}</span>}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {(() => {
                          try {
                            if (!log.timestamp) return 'Unknown date';
                            const date = log.timestamp.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
                            return format(date, 'MMM d, h:mm a');
                          } catch (error) {
                            return 'Invalid date';
                          }
                        })()}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">No recent activity found.</p>
              )}
            </CardContent>
          </Card>

          {/* Admin Navigation */}
          <div className="mt-8">
            <h2 className="text-xl font-semibold mb-4">Admin Tools</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <Button asChild variant="outline" className="justify-start">
                <Link href="/admin/roles">
                  <Users className="h-4 w-4 mr-2" />
                  User Management
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/admin/projects">
                  <Wrench className="h-4 w-4 mr-2" />
                  Projects
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/admin/blog">
                  <BookOpen className="h-4 w-4 mr-2" />
                  Blogs
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/admin/events">
                  <Calendar className="h-4 w-4 mr-2" />
                  Events
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/admin/resources">
                  <FileText className="h-4 w-4 mr-2" />
                  Resources
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/admin/analytics">
                  <Eye className="h-4 w-4 mr-2" />
                  Analytics
                </Link>
              </Button>
            </div>
          </div>
        </main>

        <Footer />
      </div>
    </AuthorizationGate>
  );
}

function SelfRoleCard() {
  const { user, role } = useUser();
  const firestore = useFirestore();
  const { toast } = useToast();
  const [newRole, setNewRole] = useState<string>('member');
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    if (!user?.uid) return;
    setSaving(true);
    try {
      // Assign self role using existing role-management util
      const ok = await assignRole(firestore, user.uid, newRole as any, user.uid, `Superadmin self-changed public role to ${newRole}`);
      if (ok) {
        toast({ title: 'Public Role Updated', description: `Your public role is now ${USER_ROLES[newRole as keyof typeof USER_ROLES] || newRole.replace(/_/g, ' ')}. Superadmin override remains active.` });
        await refreshTokenAfterRoleChange(user, user.uid);
      } else {
        toast({ variant: 'destructive', title: 'Update failed', description: 'Could not change your public role.' });
      }
    } catch (e) {
      console.error('Self role change error', e);
      toast({ variant: 'destructive', title: 'Error', description: 'An error occurred while updating your role.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bg-card/80 backdrop-blur-sm mb-8">
      <CardHeader>
        <CardTitle>Change My Public Role</CardTitle>
        <CardDescription>As Founder and Patron-in-Chief, you can change how your role appears publicly. Your founder_patron power is permanent.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <div className="w-[220px]">
            <Label htmlFor="self-role">Select Role</Label>
            <Select value={newRole} onValueChange={setNewRole}>
              <SelectTrigger id="self-role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(USER_ROLES).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save My Role'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">Note: Regardless of your public role, your founder_patron role grants you full access at all times.</p>
      </CardContent>
    </Card>
  );
}