'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import StarryBackground from '@/components/starry-background';
import Footer from '@/components/layout/footer';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useDoc, useFirestore, useUser } from '@/firebase';
import { doc, serverTimestamp } from 'firebase/firestore';
;
import Link from 'next/link';
import { useToast } from '@/hooks/use-toast';
import { updateDoc } from '@/lib/client/firestore-wrapper';

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center"><StarryBackground /><p>Loading registration...</p></div>}>
      <RegisterContent />
    </Suspense>
  );
}

function RegisterContent() {
  const params = useSearchParams();
  const eventId = params.get('eventId');
  const firestore = useFirestore();
  const { user } = useUser();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [paymentRef, setPaymentRef] = useState<string>('');
  const [whatsappInput, setWhatsappInput] = useState<string>('');
  const [submittingPayment, setSubmittingPayment] = useState(false);

  const eventDocRef = useMemo(() => {
    if (!eventId) return null;
    return doc(firestore, 'events', eventId);
  }, [firestore, eventId]);

  const { data: event } = useDoc(eventDocRef);
  const registrationDocRef = useMemo(() => {
    if (!eventId || !user) return null;
    return doc(firestore, 'events', eventId, 'registrations', user.uid);
  }, [firestore, eventId, user]);
  const { data: registration } = useDoc(registrationDocRef);

  // Fetch global enforcement config
  const configRef = useMemo(() => doc(firestore, 'warningConfig', 'global'), [firestore]);
  const { data: config } = useDoc(configRef);

  const capacity = typeof (event as any)?.capacity === 'number' ? (event as any).capacity : undefined;
  const attendeeIds = Array.isArray((event as any)?.attendeeIds) ? (event as any).attendeeIds : [];
  const isFull = capacity !== undefined ? attendeeIds.length >= capacity : false;
  const isPublished = !!event && ((event as any).status === 'published' || (event as any).published === true);
  const isOpen = !!event && (((event as any).registrationOpen ?? true) === true);
  const isRegistered = !!user && attendeeIds.includes(user.uid);

  // 🛑 ENFORCEMENT CHECK: Block if user is blacklisted
  const enforcementEnabled = config?.enforcementEnabled ?? true;
  const isBlacklisted = user?.isBlacklisted === true && enforcementEnabled;

  const paymentDetails = (event as any)?.paymentDetails;
  const isPaidEvent = !!paymentDetails && paymentDetails.isPaid === true;
  const paymentStatus = (registration as any)?.paymentStatus as ('unpaid' | 'pending' | 'verified' | 'refunded') | undefined;
  const currentWhatsapp: string | undefined = (registration as any)?.whatsappE164;

  const canRegister = !!event && !!user && isPublished && isOpen && !isFull && !isRegistered && !isBlacklisted;

  const normalizeWhatsapp = (raw: string): string | null => {
    if (!raw) return null;
    let s = raw.trim();
    // Remove spaces, dashes, parentheses
    s = s.replace(/[^+\d]/g, '');
    if (s.startsWith('+')) {
      // Already E.164-like; ensure digit count 8-15
      const digits = s.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) return s;
      return null;
    }
    // Assume Pakistan local number; convert 0xxxxxxxxxx -> +92xxxxxxxxxx
    if (s.startsWith('0')) {
      const digits = s.replace(/\D/g, '').replace(/^0/, '');
      const e164 = `+92${digits}`;
      if (digits.length >= 8 && digits.length <= 12) return e164; // typical PK local lengths
      return null;
    }
    // If plain digits without +, treat as international without leading + (add +)
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    return null;
  };

  const handleConfirmSeat = async () => {
    if (!eventId || !user) return;
    setLoading(true);
    try {
      const whatsappE164 = normalizeWhatsapp(whatsappInput || '');
      const token = await user.getIdToken();
      const response = await fetch('/registerForEvent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ data: { eventId, whatsappE164, paymentMethod: paymentDetails?.method || null } }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData?.error?.message || 'Registration request failed');
      }
      toast({ title: 'Registered', description: 'Your seat is confirmed!' });
    } catch (err: any) {
      console.error('Registration error', err);
      const msg = typeof err?.message === 'string' ? err.message : 'Please try again.';
      toast({ title: 'Registration failed', description: msg, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitPaymentRef = async () => {
    if (!registrationDocRef || !user) return;
    if (!paymentRef || paymentRef.trim().length < 3) {
      toast({ title: 'Payment reference required', description: 'Please enter a valid reference or transaction ID.' });
      return;
    }
    const whatsappE164 = normalizeWhatsapp(whatsappInput || currentWhatsapp || '');
    setSubmittingPayment(true);
    try {
      await updateDoc(registrationDocRef, {
        paymentRef: paymentRef.trim(),
        paymentMethod: paymentDetails?.method || null,
        paymentStatus: 'pending',
        whatsappE164: whatsappE164,
        updatedAt: serverTimestamp(),
      });
      toast({ title: 'Payment submitted', description: 'We will verify and confirm shortly.' });
    } catch (err: any) {
      console.error('Payment submit error', err);
      toast({ title: 'Submit failed', description: err?.message || 'Please try again.', variant: 'destructive' });
    } finally {
      setSubmittingPayment(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
          <CardHeader>
            <CardTitle>Register for {event?.title || 'Event'}</CardTitle>
            <CardDescription>
              Confirm your seat if registration is open and you’re signed in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!eventId && (
              <p className="text-muted-foreground">Missing <code>?eventId=</code> query. Please navigate from an event page.</p>
            )}
            {eventId && !event && (
              <p className="text-muted-foreground">We couldn’t load that event. It may not exist or you may not have access.</p>
            )}
            {!!event && (
              <div className="space-y-2">
                {!user && (
                  <p className="text-muted-foreground">Please sign in to register.
                    <Button asChild className="ml-2" size="sm">
                      <Link href="/auth/login">Log In</Link>
                    </Button>
                  </p>
                )}
                {user && isRegistered && (
                  <p className="text-primary">You’re already registered for this event.</p>
                )}
                {user && !isPublished && (
                  <p className="text-muted-foreground">This event isn’t published yet.</p>
                )}
                {user && isPublished && !isOpen && (
                  <p className="text-muted-foreground">Registration is currently closed.</p>
                )}
                {user && isPublished && isOpen && isFull && (
                  <p className="text-muted-foreground">The event is full.</p>
                )}
                {user && isBlacklisted && (
                  <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-center">
                    <p className="text-destructive font-bold">Account Restricted</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Your account is currently blacklisted due to multiple warnings. 
                      Registration for events is restricted while this status is active.
                    </p>
                  </div>
                )}
                {canRegister && (
                  <Button onClick={handleConfirmSeat} disabled={loading}>
                    {loading ? 'Confirming...' : 'Confirm Seat'}
                  </Button>
                )}
                {/* Payment details display - redirect to store checkout */}
                {isPaidEvent && (
                  <div className="mt-6 p-6 border border-primary/20 rounded-lg bg-card text-center">
                    <h3 className="text-xl font-bold mb-2">Ticket Required</h3>
                    <p className="text-muted-foreground mb-4">
                      This event requires a paid ticket. Please proceed to the checkout to secure your spot.
                    </p>
                    {!!user && isRegistered ? (
                      <div>
                        <p className="text-sm font-medium mb-4">
                          Status: <span className="text-primary capitalize">{paymentStatus || 'confirmed'}</span>
                        </p>
                        <Button asChild variant="outline">
                          <Link href="/user/profile?tab=tickets">View My Tickets</Link>
                        </Button>
                      </div>
                    ) : (
                      <Button asChild size="lg" className="w-full md:w-auto">
                        <Link href={`/checkout?eventId=${eventId}&type=product${event.linkedStoreProductId ? `&productId=${event.linkedStoreProductId}` : ''}`}>
                          Proceed to Checkout
                        </Link>
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-3">
              {event && (
                <Button asChild variant="secondary">
                  <Link href={`/events/${event.slug || eventId}`}>Back to Event</Link>
                </Button>
              )}
              <Button asChild>
                <Link href="/events">Browse Events</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
