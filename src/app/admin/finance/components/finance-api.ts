'use client';

/**
 * Shared client helper for the finance workspace: attaches the signed-in
 * user's ID token and unwraps the finance API error contract
 * ({ error, code?, existingId? }).
 */
export interface FinanceUser {
  uid: string;
  getIdToken: () => Promise<string>;
}

export async function financeFetch<T = Record<string, unknown>>(
  user: FinanceUser,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = await user.getIdToken();
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data;
}

export function pkr(n: number | null | undefined): string {
  if (n == null) return 'PKR 0';
  return `PKR ${n.toLocaleString('en-PK')}`;
}
