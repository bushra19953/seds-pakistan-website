// ─── PUBLIC QR VERIFICATION PAGE ─────────────────────────────────────────────
// Route: /verify/ticket/[ticketId]
// Purpose: Admin scans QR at event entry door. Shows VALID or REVOKED
// No auth required (public). QR codes point here

import type { Metadata } from 'next';
import Image from 'next/image';
import { getDb } from '@/lib/server/firebase-admin';
import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Props {
    params: Promise<{ ticketId: string }>;
}

// ─── Server-side metadata ─────────────────────────────────────────────────────
export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { ticketId } = await params;
    return {
        title: `Ticket Verification: ${ticketId} | SEDS Pakistan`,
        description: 'Verify the authenticity of a SEDS Pakistan event ticket.',
        robots: 'noindex,nofollow', // Don't index verification pages
    };
}

function safeDate(ts: any): string {
    try {
        if (!ts) return 'TBD';
        const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
        return d.toLocaleDateString('en-PK', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        });
    } catch {
        return 'TBD';
    }
}

function safeIssuedDate(ts: any): string {
    try {
        if (!ts) return '';
        const d = ts._seconds ? new Date(ts._seconds * 1000) : new Date(ts);
        return d.toLocaleDateString('en-PK', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
        return '';
    }
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default async function TicketVerificationPage({ params }: { params: Promise<{ ticketId: string }> }) {
    const { ticketId } = await params;

    let ticket: Record<string, any> | null = null;
    let fetchError = '';

    try {
        const db = getDb();
        if (!db) throw new Error('Database unavailable');

        const snap = await db.collection('eventTickets').doc(ticketId).get();
        if (!snap.exists) {
            fetchError = 'Ticket not found. This may be an invalid or counterfeit ticket.';
        } else {
            ticket = snap.data() as Record<string, any>;
        }
    } catch (err: any) {
        fetchError = 'Unable to verify ticket at this time. Please try again.';
        console.error('[verify/ticket] Error:', err);
    }

    const isValid = ticket && ticket.status === 'valid';
    const isRevoked = ticket && ticket.status === 'revoked';

    return (
        <div className="container mx-auto flex min-h-screen flex-col items-center justify-center px-4 py-10 font-body">
            {/* SEDS Branding */}
            <div className="mb-8 text-center">
                <div className="relative mx-auto mb-3 h-14 w-14">
                    <Image
                        src="/assets/logo.png"
                        alt="SEDS Pakistan logo"
                        fill
                        sizes="56px"
                        className="object-contain"
                    />
                </div>
                <p className="text-sm text-muted-foreground">SEDS Pakistan | Ticket Verification</p>
            </div>

            {/* Main Card */}
            <Card
                className={cn(
                    'w-full max-w-md border-2 bg-card/80 text-center shadow-lg backdrop-blur-md',
                    isValid ? 'border-green-500/70' : isRevoked ? 'border-red-500/70' : 'border-border',
                )}
            >
                <CardContent className="p-8">
                    {/* Status Icon */}
                    {!fetchError && isValid && (
                        <CheckCircle className="mx-auto mb-4 h-16 w-16 text-green-500" aria-hidden="true" />
                    )}
                    {!fetchError && isRevoked && (
                        <XCircle className="mx-auto mb-4 h-16 w-16 text-red-400" aria-hidden="true" />
                    )}
                    {fetchError && (
                        <AlertTriangle className="mx-auto mb-4 h-16 w-16 text-amber-500" aria-hidden="true" />
                    )}

                    {/* Status Label */}
                    <h1
                        className={cn(
                            'mb-2 font-heading text-5xl tracking-wide',
                            isValid ? 'text-green-500' : isRevoked ? 'text-red-400' : 'text-amber-500',
                        )}
                    >
                        {fetchError ? 'NOT FOUND' : isValid ? 'VALID' : 'REVOKED'}
                    </h1>

                    <p className="mb-6 text-sm text-muted-foreground">
                        {fetchError || (isValid ? 'This ticket is authentic and has not been revoked.' : 'This ticket has been revoked and cannot be used for entry.')}
                    </p>

                    {/* Ticket Details */}
                    {ticket && (
                        <div className="rounded-lg border border-border bg-muted/40 p-4 text-left">
                            <dl className="space-y-2">
                                <Row label="Ticket #" value={`#${ticket.ticketNumber?.toString().padStart(3, '0')}`} mono />
                                <Row label="Attendee" value={ticket.displayName} />
                                <Row label="Event" value={ticket.eventTitle} />
                                <Row label="Date" value={safeDate(ticket.eventDate)} />
                                <Row label="Venue" value={ticket.eventVenue || 'TBD'} />
                                <Row label="Issued" value={safeIssuedDate(ticket.issuedAt)} />
                                <Row label="Ticket ID" value={ticket.ticketId} mono small />
                            </dl>
                        </div>
                    )}

                    {/* Footer */}
                    <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
                        Verified by SEDS Pakistan ticketing system.<br />
                        If this shows VALID, allow entry. If REVOKED, deny entry.<br />
                        Report issues to the event organizer.
                    </p>
                </CardContent>
            </Card>

            {/* Timestamp */}
            <p className="mt-4 text-center text-xs text-muted-foreground">
                Checked at {new Date().toLocaleTimeString('en-PK')} on {new Date().toLocaleDateString('en-PK')}
            </p>
        </div>
    );
}

// ─── Helper row component ─────────────────────────────────────────────────────
function Row({ label, value, mono = false, small = false }: { label: string; value: string; mono?: boolean; small?: boolean }) {
    return (
        <div className="flex items-start justify-between gap-2">
            <dt className="whitespace-nowrap text-xs text-muted-foreground">{label}</dt>
            <dd
                className={cn(
                    'break-all text-right font-semibold text-foreground',
                    small ? 'text-xs' : 'text-sm',
                    mono && 'font-code',
                )}
            >
                {value || '—'}
            </dd>
        </div>
    );
}
