// ─── PUBLIC QR VERIFICATION PAGE ─────────────────────────────────────────────
// Route: /verify/ticket/[ticketId]
// Purpose: Admin scans QR at event entry door — shows VALID or REVOKED
// No auth required (public) — QR codes point here

import type { Metadata } from 'next';
import { getDb } from '@/lib/server/firebase-admin';
import { CheckCircle, XCircle, Shield } from 'lucide-react';

interface Props {
    params: Promise<{ ticketId: string }>;
}

// ─── Server-side metadata ─────────────────────────────────────────────────────
export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { ticketId } = await params;
    return {
        title: `Ticket Verification — ${ticketId} | SEDS Pakistan`,
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
        <div
            style={{
                minHeight: '100vh',
                background: isValid ? '#0a1628' : isRevoked ? '#1a0808' : '#0f172a',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '24px',
                fontFamily: "'Segoe UI', Arial, sans-serif",
            }}
        >
            {/* SEDS Branding */}
            <div style={{ marginBottom: 32, textAlign: 'center' }}>
                <div style={{
                    width: 56, height: 56, borderRadius: '50%',
                    background: '#4f46e5', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', margin: '0 auto 12px',
                    fontSize: 24, fontWeight: 900, color: '#fff',
                }}>S</div>
                <p style={{ color: '#94a3b8', fontSize: 13, margin: 0 }}>SEDS Pakistan — Ticket Verification</p>
            </div>

            {/* Main Card */}
            <div style={{
                background: '#1e293b',
                border: `2px solid ${isValid ? '#22c55e' : isRevoked ? '#ef4444' : '#475569'}`,
                borderRadius: 20,
                padding: '36px 32px',
                maxWidth: 420,
                width: '100%',
                textAlign: 'center',
                boxShadow: `0 0 40px ${isValid ? 'rgba(34,197,94,0.15)' : isRevoked ? 'rgba(239,68,68,0.15)' : 'rgba(0,0,0,0.3)'}`,
            }}>

                {/* Status Icon */}
                {!fetchError && isValid && (
                    <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
                )}
                {!fetchError && isRevoked && (
                    <div style={{ fontSize: 64, marginBottom: 16 }}>❌</div>
                )}
                {fetchError && (
                    <div style={{ fontSize: 64, marginBottom: 16 }}>⚠️</div>
                )}

                {/* Status Label */}
                <h1 style={{
                    fontSize: 32,
                    fontWeight: 900,
                    color: isValid ? '#22c55e' : isRevoked ? '#ef4444' : '#f59e0b',
                    margin: '0 0 8px',
                    letterSpacing: '-0.5px',
                }}>
                    {fetchError ? 'NOT FOUND' : isValid ? 'VALID' : 'REVOKED'}
                </h1>

                <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 24 }}>
                    {fetchError || (isValid ? 'This ticket is authentic and has not been revoked.' : 'This ticket has been revoked and cannot be used for entry.')}
                </p>

                {/* Ticket Details */}
                {ticket && (
                    <div style={{
                        background: '#0f172a',
                        borderRadius: 12,
                        padding: '16px 20px',
                        textAlign: 'left',
                        gap: '8px',
                    }}>
                        <Row label="Ticket #" value={`#${ticket.ticketNumber?.toString().padStart(3, '0')}`} mono />
                        <Row label="Attendee" value={ticket.displayName} />
                        <Row label="Event" value={ticket.eventTitle} />
                        <Row label="Date" value={safeDate(ticket.eventDate)} />
                        <Row label="Venue" value={ticket.eventVenue || 'TBD'} />
                        <Row label="Issued" value={safeIssuedDate(ticket.issuedAt)} />
                        <Row label="Ticket ID" value={ticket.ticketId} mono small />
                    </div>
                )}

                {/* Footer */}
                <p style={{
                    color: '#475569',
                    fontSize: 11,
                    marginTop: 20,
                    lineHeight: 1.6,
                }}>
                    Verified by SEDS Pakistan ticketing system.<br />
                    If this shows VALID, allow entry. If REVOKED, deny entry.<br />
                    Report issues to the event organizer.
                </p>
            </div>

            {/* Timestamp */}
            <p style={{ color: '#334155', fontSize: 11, marginTop: 16 }}>
                Checked at {new Date().toLocaleTimeString('en-PK')} on {new Date().toLocaleDateString('en-PK')}
            </p>
        </div>
    );
}

// ─── Helper row component ─────────────────────────────────────────────────────
function Row({ label, value, mono = false, small = false }: { label: string; value: string; mono?: boolean; small?: boolean }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 8 }}>
            <span style={{ color: '#64748b', fontSize: 12, whiteSpace: 'nowrap' }}>{label}</span>
            <span style={{
                color: '#e2e8f0',
                fontSize: small ? 11 : 13,
                fontFamily: mono ? 'monospace' : 'inherit',
                fontWeight: 600,
                textAlign: 'right',
                wordBreak: 'break-all',
            }}>{value || '—'}</span>
        </div>
    );
}
