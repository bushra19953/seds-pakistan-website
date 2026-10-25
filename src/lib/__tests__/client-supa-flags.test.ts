import { isClientSupaSurfaceOn } from '@/lib/client-supa-flags';

describe('isClientSupaSurfaceOn', () => {
  const original = process.env.NEXT_PUBLIC_SUPA_SURFACES;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
    else process.env.NEXT_PUBLIC_SUPA_SURFACES = original;
  });

  it('is OFF when the raw value is unset', () => {
    expect(isClientSupaSurfaceOn('live-admin', undefined)).toBe(false);
  });

  it('is OFF when the raw value is empty or only whitespace/commas', () => {
    expect(isClientSupaSurfaceOn('live-admin', '')).toBe(false);
    expect(isClientSupaSurfaceOn('live-admin', '  , , ')).toBe(false);
  });

  it('is OFF when only other surfaces are listed', () => {
    expect(isClientSupaSurfaceOn('live-admin', 'notifications,events')).toBe(false);
  });

  it('is ON for an exact match', () => {
    expect(isClientSupaSurfaceOn('live-admin', 'live-admin')).toBe(true);
  });

  it('matches case-insensitively on both sides and tolerates whitespace', () => {
    expect(isClientSupaSurfaceOn('live-admin', ' LIVE-ADMIN ')).toBe(true);
    expect(isClientSupaSurfaceOn('Live-Admin', 'live-admin')).toBe(true);
    expect(isClientSupaSurfaceOn('live-admin', 'notifications, Live-Admin ,blog')).toBe(true);
  });

  it('does not match partial names', () => {
    expect(isClientSupaSurfaceOn('live-admin', 'live-adminx')).toBe(false);
    expect(isClientSupaSurfaceOn('live-admin', 'live')).toBe(false);
    expect(isClientSupaSurfaceOn('live', 'live-admin')).toBe(false);
  });

  it('defaults raw to NEXT_PUBLIC_SUPA_SURFACES from the environment', () => {
    delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
    expect(isClientSupaSurfaceOn('live-admin')).toBe(false);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'live-admin';
    expect(isClientSupaSurfaceOn('live-admin')).toBe(true);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'other';
    expect(isClientSupaSurfaceOn('live-admin')).toBe(false);
  });
});
