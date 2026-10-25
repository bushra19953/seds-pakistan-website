/**
 * client-supa-flags: the canonical NEXT_PUBLIC_SUPA_SURFACES parsing
 * for client surfaces (semantics set by the notifications seam
 * precedent). Pins: unset/empty = OFF, comma list, case-insensitive,
 * whitespace tolerated, exact surface-name match.
 */

import {
  isClientSupaSurfaceOn,
  LIVE_ADMIN_SURFACE,
} from '@/lib/client-supa-flags';

describe('isClientSupaSurfaceOn', () => {
  it('is OFF when the flag is unset or empty', () => {
    expect(isClientSupaSurfaceOn('live-admin', undefined)).toBe(false);
    expect(isClientSupaSurfaceOn('live-admin', '')).toBe(false);
    expect(isClientSupaSurfaceOn('live-admin', '   ')).toBe(false);
  });

  it('is ON when the surface is listed', () => {
    expect(isClientSupaSurfaceOn('live-admin', 'live-admin')).toBe(true);
    expect(isClientSupaSurfaceOn('live-admin', 'notifications,live-admin')).toBe(true);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(isClientSupaSurfaceOn('live-admin', ' Live-Admin ')).toBe(true);
    expect(isClientSupaSurfaceOn('LIVE-ADMIN', 'live-admin')).toBe(true);
  });

  it('does not match other surfaces or partial names', () => {
    expect(isClientSupaSurfaceOn('live-admin', 'notifications')).toBe(false);
    expect(isClientSupaSurfaceOn('live-admin', 'live')).toBe(false);
    expect(isClientSupaSurfaceOn('live-admin', 'live-admin-extra')).toBe(false);
  });

  it('exposes the live-admin surface name the listeners cluster gates on', () => {
    expect(LIVE_ADMIN_SURFACE).toBe('live-admin');
    expect(isClientSupaSurfaceOn(LIVE_ADMIN_SURFACE, 'live-admin')).toBe(true);
  });

  it('defaults to reading NEXT_PUBLIC_SUPA_SURFACES from the env', () => {
    const prev = process.env.NEXT_PUBLIC_SUPA_SURFACES;
    try {
      delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
      expect(isClientSupaSurfaceOn('live-admin')).toBe(false);
      process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
      expect(isClientSupaSurfaceOn('live-admin')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
      else process.env.NEXT_PUBLIC_SUPA_SURFACES = prev;
    }
  });
});
