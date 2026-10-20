"use client";

/**
 * MaskedContact (spec section 5: Privacy Shielding).
 *
 * Renders a phone / WhatsApp / email value masked by default. Viewers whose
 * role resolves via canUnmaskContacts() (chairs, presidents, superadmin)
 * get an "Unmask contact" eye toggle; every reveal writes an audit entry to
 * the `audit_logs` collection (action 'contact_unmask', visible under
 * /admin/audit-logs) with the actor, the target user and the field kind.
 */

import { useCallback, useState } from 'react';
import { Eye, EyeOff, Copy, Check } from 'lucide-react';
import { useFirestore, useUser } from '@/firebase';
import { maskEmail, maskPhone, canUnmaskContacts } from '@/lib/privacy';
import { logAuditEntry } from '@/lib/audit-logging';

type MaskedContactProps = {
  value?: string | null;
  type: 'email' | 'phone';
  /** UID of the member whose contact is shown; used as the audit target. */
  targetUid?: string | null;
  className?: string;
  /** When false the eye toggle is hidden entirely (pure mask). */
  allowUnmask?: boolean;
};

export function MaskedContact({
  value,
  type,
  targetUid,
  className,
  allowUnmask = true,
}: MaskedContactProps) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const firestore = useFirestore();
  const { user, role } = useUser();

  const masked = type === 'email' ? maskEmail(value) : maskPhone(value);
  const unmaskAllowed = allowUnmask && canUnmaskContacts(role || null);
  const shown = revealed ? value || '—' : masked;

  const handleToggle = useCallback(async () => {
    // Log the audit entry only on reveal, not on re-masking.
    if (!revealed && firestore && user && targetUid) {
      await logAuditEntry(
        firestore,
        'contact_unmask',
        user.uid,
        targetUid,
        {
          contactField: type,
          revealedAt: new Date().toISOString(),
        },
        { isPreview: false },
      );
    }
    setRevealed((v) => !v);
  }, [revealed, firestore, user, targetUid, type]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable; no-op.
    }
  }, [shown]);

  return (
    <div className={`flex items-center gap-1.5 group w-fit max-w-full ${className || ''}`}>
      <span
        className={`truncate ${type === 'phone' ? 'font-mono text-xs text-green-400' : 'text-muted-foreground'}`}
        title={revealed ? value || undefined : undefined}
      >
        {shown}
      </span>
      {unmaskAllowed && (
        <button
          type="button"
          onClick={handleToggle}
          aria-label={revealed ? 'Mask contact' : 'Unmask contact'}
          title={
            revealed
              ? 'Mask contact again'
              : 'Unmask contact (logged to the audit log)'
          }
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
        >
          {revealed ? (
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy contact"
        title={revealed ? 'Copy contact' : 'Copy masked contact'}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
    </div>
  );
}

export default MaskedContact;
