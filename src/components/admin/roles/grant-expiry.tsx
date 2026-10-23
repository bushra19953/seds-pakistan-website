/**
 * Grant expiry - shared display module for custom-role grants
 * (Custom Roles Fix Program, item expiry-ui).
 *
 * One derivation, every surface: users list role cell, Authority
 * Inspector header, hierarchy canvas detail panel, hierarchy clusters
 * overview. The state is derived at render from the grant's expiresAt
 * (read-time derivation is the mechanism of record, contracts 2.2 /
 * governors effectiveStatus pattern): a grant whose date has passed
 * but whose sweep has not run yet renders 'expired', never 'active'.
 *
 * Thresholds mirror the expiry sweep's alert stages (T-30 / T-7,
 * contracts 5.2) so what the UI warns about is what the sweep warns
 * about. All rendering is static and token-styled (ui-review U1/U2/U7).
 */

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn, formatDate } from '@/lib/utils';

export type GrantExpiryState = 'none' | 'set' | 'expiring-30' | 'expiring-7' | 'expired';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Custom-role slug partition test. Mirrors `isCustomRoleSlug` in
 * src/lib/custom-roles.ts (data-model item, contracts 4.2): a string
 * starting with `custom_` and a non-empty remainder. Kept local so
 * this item compiles on the base tree; the semantics are identical
 * and the two must never drift.
 */
export const CUSTOM_ROLE_KEY_PREFIX = 'custom_';

export function isCustomRoleKey(key: string | null | undefined): key is string {
  return (
    typeof key === 'string' &&
    key.startsWith(CUSTOM_ROLE_KEY_PREFIX) &&
    key.length > CUSTOM_ROLE_KEY_PREFIX.length
  );
}

export function expiryState(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): GrantExpiryState {
  if (!expiresAt) return 'none';
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return 'none';
  const diff = end - now.getTime();
  if (diff <= 0) return 'expired';
  if (diff <= 7 * DAY_MS) return 'expiring-7';
  if (diff <= 30 * DAY_MS) return 'expiring-30';
  return 'set';
}

function wholeDaysUntil(expiresAt: string, now: Date): number {
  const diff = new Date(expiresAt).getTime() - now.getTime();
  return Math.max(1, Math.ceil(diff / DAY_MS));
}

export function GrantExpiryBadge({
  expiresAt,
  now,
  className,
}: {
  expiresAt: string | null | undefined;
  /** Test seam: the instant to derive state against. Defaults to now. */
  now?: Date;
  className?: string;
}) {
  const at = now ?? new Date();
  const state = expiryState(expiresAt, at);
  if (state === 'none' || !expiresAt) return null;
  const dateLabel = formatDate(expiresAt);
  if (state === 'expired') {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        Expired {dateLabel}
      </Badge>
    );
  }
  if (state === 'set') {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        Expires {dateLabel}
      </Badge>
    );
  }
  const days = wholeDaysUntil(expiresAt, at);
  return (
    <Badge
      variant="outline"
      className={cn(state === 'expiring-7' ? 'text-destructive-text' : 'text-primary-text', className)}
    >
      Expires in {days}d · {dateLabel}
    </Badge>
  );
}

/**
 * The assign-form expiry control: an exact copy of the task form's
 * datetime pattern (ui-review U4) - Label htmlFor + Input
 * type="datetime-local" in a grid, value held as a datetime-local
 * string end to end; conversion to an ISO instant happens only at
 * submit. Helper copy is factual only and names no alert recipients
 * (contracts 5.2 recipients are Founder + holder; the UI promises
 * nothing about alerts).
 */
export function ExpiryDateField({
  id,
  value,
  onChange,
  disabled,
  defaultHint,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Optional extra factual line, e.g. the definition default this
   * value was prefilled from. Rendered above the standard helper. */
  defaultHint?: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Grant expiry (optional)</Label>
      <Input
        id={id}
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      {defaultHint ? (
        <p className="text-xs text-muted-foreground">{defaultHint}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        The grant ends automatically on this date and the holder returns to their
        previous role. Leave empty for no expiry.
      </p>
    </div>
  );
}
