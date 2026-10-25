'use client';

export function isClientSupaSurfaceOn(
  surface: string,
  raw: string | undefined = process.env.NEXT_PUBLIC_SUPA_SURFACES,
): boolean {
  if (!raw) return false;
  const wanted = surface.trim().toLowerCase();
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}

export function useClientSupaSurface(surface: string): boolean {
  return isClientSupaSurfaceOn(surface);
}
