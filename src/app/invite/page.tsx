'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUser, useFirestore } from '@/firebase';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { validateInvite, claimInvite } from '@/lib/invite-system';
import { assignRole } from '@/lib/role-management';
import { logAuditEntry } from '@/lib/audit-logging';
import { useToast } from '@/hooks/use-toast';
import Link from 'next/link';
import AdminLayout from '@/components/layout/admin-layout';
import { useEffect, useState } from 'react';

function InvitePageClient() {
  const { user, isLoading } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const { toast } = useToast();
  const firestore = useFirestore();
  const [inviteData, setInviteData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    const fetchInviteData = async () => {
      if (!token) {
        setLoading(false);
        toast({
          variant: "destructive",
          title: "Invalid Invite",
          description: "This invite link is invalid or has expired.",
        });
        return;
      }
      try {
        const invite = await validateInvite(firestore, token);
        if (invite) {
          setInviteData(invite);
        } else {
          toast({
            variant: "destructive",
            title: "Invalid Invite",
            description: "This invite link is invalid or has expired.",
          });
        }
      } catch (error) {
        console.error("Error fetching invite:", error);
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to validate invite link.",
        });
      } finally {
        setLoading(false);
      }
    };

    fetchInviteData();
  }, [token, toast, firestore]);

  const handleClaimInvite = async () => {
    if (!user || !inviteData || !token) return;
    
    setClaiming(true);
    
    try {
      // Claim the invite
      const claimed = await claimInvite(firestore, token, user.uid);
      
      if (claimed) {
        // Assign the role to the user
        const roleAssigned = await assignRole(
          firestore,
          user.uid,
          inviteData.role,
          inviteData.createdBy,
          'Assigned via invite'
        );
        
        if (roleAssigned) {
          // Log the audit entry
          await logAuditEntry(
            firestore,
            'accept_invite',
            user.uid,
            token,
            {
              role: inviteData.role,
            }
          );
          
          toast({
            title: "Invite Accepted",
            description: "You have successfully accepted the invite and your role has been assigned.",
          });
          
          // Redirect to profile page
          router.push('/user/profile');
        } else {
          toast({
            variant: "destructive",
            title: "Error",
            description: "Failed to assign role. Please contact support.",
          });
        }
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to claim invite. It may have already been used or expired.",
        });
      }
    } catch (error) {
      console.error("Error claiming invite:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to claim invite.",
      });
    } finally {
      setClaiming(false);
    }
  };

  if (isLoading || loading) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center px-4">
        <StarryBackground />
        <p>Validating invite...</p>
      </div>
    );
  }

  if (!inviteData) {
    return (
      <AdminLayout title="Invalid Invite" description="This invite link is invalid or has expired.">
        <StarryBackground />
        <main className="flex-1 container mx-auto py-8 px-4">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
            <CardContent className="py-12 text-center">
              <h2 className="text-2xl font-bold mb-4">Invalid Invite</h2>
              <p className="text-muted-foreground mb-6">This invite link is invalid or has expired.</p>
              <Button asChild>
                <Link href="/">Return Home</Link>
              </Button>
            </CardContent>
          </Card>
        </main>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Accept Invitation" description="You've been invited to join SEDS Pakistan">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
          <CardHeader>
            <CardTitle>Accept Invitation</CardTitle>
            <CardDescription>You&apos;ve been invited to join SEDS Pakistan</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <h3 className="text-lg font-medium">Invitation Details</h3>
              <div className="bg-muted p-4 rounded-lg">
                <p><strong>Role:</strong> {inviteData.role}</p>
                <p><strong>Expires:</strong> {new Date(inviteData.expiresAt).toLocaleDateString()}</p>
              </div>
            </div>

            {!user ? (
              <div className="space-y-4">
                <p className="text-center">
                  Please sign in to accept this invitation:
                </p>
                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                  <Button asChild>
                    <Link href="/auth/login">Sign In</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/signup">Create Account</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-center">
                  You are currently signed in as <strong>{user.displayName || user.email}</strong>
                </p>
                <Button 
                  onClick={handleClaimInvite} 
                  disabled={claiming}
                  className="w-full"
                >
                  {claiming ? 'Accepting Invite...' : 'Accept Invite'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </AdminLayout>
  );
}


export default function InvitePage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <InvitePageClient />
    </Suspense>
  );
}
