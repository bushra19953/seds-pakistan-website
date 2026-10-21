// ADAPTER: meetings-decisions API adapter. All governed writes go through the
// section 4 API routes (ws-a.md). If sibling server services change route shapes,
// swap only this file. No client-direct Firestore writes for governed state.
import type { MotionView, MinutesView, CircularView, VoteChoice } from './meetings-ui';
import { buildSecretBallotCastPayload, buildOpenBallotPayload } from './meetings-ui';
async function call(path: string, init?: RequestInit, token?: string | null): Promise<any> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}
export const meetingsAdapter = {
  listMotions: (meetingId: string, token?: string | null) => call(`/api/governance/meetings/${meetingId}/motions`, undefined, token) as Promise<{ motions: MotionView[] }>,
  createMotion: (meetingId: string, body: { text: string; decisionClassId: string; proposerUid: string; method?: string }, token?: string | null) => call(`/api/governance/meetings/${meetingId}/motions`, { method: 'POST', body: JSON.stringify(body) }, token),
  closeMotion: (motionId: string, token?: string | null) => call(`/api/governance/motions/${motionId}/close`, { method: 'POST', body: '{}' }, token),
  demandSecret: (motionId: string, token?: string | null) => call(`/api/governance/motions/${motionId}/demand-secret`, { method: 'POST', body: '{}' }, token),
  issueSecretToken: (motionId: string, token?: string | null) => call(`/api/governance/motions/${motionId}/vote`, { method: 'POST', body: JSON.stringify({ action: 'issue_token' }) }, token) as Promise<{ token: string }>,
  // Secret cast sends choice + token only; the auth header authenticates the session and the server discards uid before writing (ws-a 4.5).
  castSecretBallot: (motionId: string, secretToken: string, choice: VoteChoice, authToken?: string | null) => call(`/api/governance/motions/${motionId}/vote`, { method: 'POST', body: JSON.stringify(buildSecretBallotCastPayload(secretToken, choice)) }, authToken),
  castOpenBallot: (motionId: string, choice: VoteChoice, opts?: Parameters<typeof buildOpenBallotPayload>[1], token?: string | null) => call(`/api/governance/motions/${motionId}/vote`, { method: 'POST', body: JSON.stringify(buildOpenBallotPayload(choice, opts)) }, token),
  getMinutes: (minutesId: string, token?: string | null) => call(`/api/governance/minutes/${minutesId}`, undefined, token) as Promise<{ minutes: MinutesView }>,
  circulateMinutes: (minutesId: string, token?: string | null) => call(`/api/governance/minutes/${minutesId}/circulate`, { method: 'POST', body: '{}' }, token),
  signMinutes: (minutesId: string, token?: string | null) => call(`/api/governance/minutes/${minutesId}/sign`, { method: 'POST', body: '{}' }, token),
  listCirculars: (token?: string | null) => call(`/api/governance/circular-resolutions`, undefined, token) as Promise<{ resolutions: CircularView[] }>,
  createCircular: (body: { bodyId: string; title: string; text: string; decisionClassId: string; consentId?: string }, token?: string | null) => call(`/api/governance/circular-resolutions`, { method: 'POST', body: JSON.stringify(body) }, token),
  circulateCircular: (id: string, token?: string | null) => call(`/api/governance/circular-resolutions/${id}/circulate`, { method: 'POST', body: '{}' }, token),
  signCircular: (id: string, token?: string | null) => call(`/api/governance/circular-resolutions/${id}/sign`, { method: 'POST', body: JSON.stringify({ statement: 'I approve this resolution' }) }, token),
};
export type MeetingsAdapter = typeof meetingsAdapter;
