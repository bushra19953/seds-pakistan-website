"use client";

/**
 * Client helper for the elections + AGM API. Every call carries the
 * signed-in user's ID token; all governed logic stays server-side.
 */

export async function electionsApi<T = unknown>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!user) throw new Error("Not signed in.");
  const token = await user.getIdToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
    const err = new Error(message) as Error & { code?: string; status?: number };
    err.code = typeof data.code === "string" ? data.code : undefined;
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/** Format any timestamp shape the API returns (millis, ISO, Firestore JSON). */
export function fmtDate(value: unknown): string {
  if (value === null || value === undefined) return "-";
  let millis: number | null = null;
  if (typeof value === "number") millis = value;
  else if (typeof value === "string") millis = Date.parse(value);
  else if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.toMillis === "function") millis = (v.toMillis as () => number)();
    else if (typeof v.seconds === "number") millis = v.seconds * 1000;
    else if (typeof v._seconds === "number") millis = v._seconds * 1000;
  }
  if (millis === null || Number.isNaN(millis)) return "-";
  return new Date(millis).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
