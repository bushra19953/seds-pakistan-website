'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useFirestore, useUser } from '@/firebase';
import { fetchOwnContact } from '@/lib/client/user-contact';
import { serverWrite } from '@/lib/client/server-write';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { WaitlistSource } from '@/types/store-catalogue';

interface WaitlistFormProps {
  source: WaitlistSource;
  productId?: string | null;
  initialRequestedText?: string;
  searchQuery?: string | null;
  heading?: string;
}

/**
 * The one "I want this" form (PLAN-gd Section 7.4). Posts to
 * POST /api/store/waitlist through serverWrite, which stamps the
 * signed-in buyer's uid from their token; the form never sends one.
 */
export function WaitlistForm({
  source,
  productId = null,
  initialRequestedText = '',
  searchQuery = null,
  heading,
}: WaitlistFormProps) {
  const { user } = useUser();
  const firestore = useFirestore();
  const [requestedText, setRequestedText] = useState(initialRequestedText);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [nameError, setNameError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [formError, setFormError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const confirmationRef = useRef<HTMLHeadingElement>(null);
  const touched = useRef({ name: false, phone: false, email: false });

  // Prefill from the signed-in buyer's own records, only into fields
  // they have not typed in. Any failure is silent.
  useEffect(() => {
    if (!user) return;
    if (user.displayName && !touched.current.name) {
      setContactName((current) => current || (user.displayName as string));
    }
    if (user.email && !touched.current.email) {
      setContactEmail((current) => current || (user.email as string));
    }
    if (!firestore) return;
    let cancelled = false;
    fetchOwnContact(firestore, user.uid)
      .then((contact) => {
        if (cancelled || !contact) return;
        const phone = contact.whatsapp || contact.phone || contact.phoneNumber || contact.contactNumber || '';
        if (phone && !touched.current.phone) {
          setContactPhone((current) => current || phone);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, firestore]);

  useEffect(() => {
    if (sent) confirmationRef.current?.focus();
  }, [sent]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    const nameMissing = !contactName.trim();
    const phoneMissing = !contactPhone.trim();
    setNameError(nameMissing ? 'Please enter your name.' : '');
    setPhoneError(phoneMissing ? 'Please enter your WhatsApp number.' : '');
    if (nameMissing || phoneMissing) return;

    setSending(true);
    try {
      await serverWrite('/api/store/waitlist', 'POST', {
        contactName: contactName.trim(),
        contactPhone: contactPhone.trim(),
        contactEmail: contactEmail.trim() || undefined,
        productId: productId ?? undefined,
        requestedText: requestedText.trim() || undefined,
        searchQuery: searchQuery ?? undefined,
        source,
      });
      setSent(true);
    } catch (e: any) {
      setFormError(e?.message || 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div role="status" className="rounded-lg border p-4">
        <h3 ref={confirmationRef} tabIndex={-1} className="font-semibold">
          Request noted
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Thanks. We have written down what you are looking for. We will contact you on
          WhatsApp if it becomes available.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {heading && <h3 className="font-semibold">{heading}</h3>}
      <div className="space-y-2">
        <Label htmlFor="waitlist-requested-text">What are you looking for?</Label>
        <Textarea
          id="waitlist-requested-text"
          value={requestedText}
          onChange={(e) => setRequestedText(e.target.value)}
          rows={2}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="waitlist-name">Your name</Label>
        <Input
          id="waitlist-name"
          autoComplete="name"
          required
          value={contactName}
          aria-describedby={nameError ? 'waitlist-name-error' : undefined}
          onChange={(e) => {
            touched.current.name = true;
            setContactName(e.target.value);
          }}
        />
        {nameError && (
          <p id="waitlist-name-error" role="alert" className="text-sm text-destructive">
            {nameError}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="waitlist-phone">WhatsApp number</Label>
        <Input
          id="waitlist-phone"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          required
          value={contactPhone}
          aria-describedby={phoneError ? 'waitlist-phone-error' : undefined}
          onChange={(e) => {
            touched.current.phone = true;
            setContactPhone(e.target.value);
          }}
        />
        {phoneError && (
          <p id="waitlist-phone-error" role="alert" className="text-sm text-destructive">
            {phoneError}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="waitlist-email">Email (optional)</Label>
        <Input
          id="waitlist-email"
          type="email"
          autoComplete="email"
          value={contactEmail}
          onChange={(e) => {
            touched.current.email = true;
            setContactEmail(e.target.value);
          }}
        />
      </div>
      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <Button type="submit" disabled={sending} className="min-h-[44px]">
        {sending ? 'Sending' : 'Send request'}
      </Button>
    </form>
  );
}
