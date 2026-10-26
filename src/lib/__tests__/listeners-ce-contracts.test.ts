/**
 * listeners-ce — source-pin contract suite (the program's
 * source-scan evidence style; behavior suites for the client helper
 * and the chat-state route live beside them).
 *
 * Pins, per listener:
 *  - A21/A22/B10 convert ONLY behind 'live-authority' and ONLY via
 *    the token-verified roles seam route + the shared polling hook;
 *    the Firestore listeners remain for the OFF path.
 *  - A23 is NOT converted: authority-refresh.ts is untouched by this
 *    workstream and keeps its onSnapshot signal (flip-gate item).
 *  - B17/A19/A20/A18 convert ONLY behind 'live-chat' via the
 *    chat-state route + shared hook; X4's heartbeat write is intact.
 *  - No browser realtime anywhere: no postgres_changes, no direct
 *    Supabase import in any converted client file.
 *  - Class D deletions: the four dead onSnapshot imports and the
 *    dead useSafeFirestoreDocuments export stay deleted.
 */
import * as fs from 'fs';
import * as path from 'path';

const readSrc = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');

const CLIENT_FILES = [
  'firebase/user-provider.tsx',
  'hooks/use-role.ts',
  'components/admin/roles/role-registry.tsx',
  'components/workflow/enhanced-workflow-chat.tsx',
  'components/profile/workflow-visualizer.tsx',
  'lib/listeners-ce-client.ts',
];

describe('surface flags', () => {
  it('client-supa-flags exports both CE surfaces with their exact tokens', () => {
    const src = readSrc('lib/client-supa-flags.ts');
    expect(src).toContain("export const LIVE_AUTHORITY_SURFACE = 'live-authority';");
    expect(src).toContain("export const LIVE_CHAT_SURFACE = 'live-chat';");
  });
});

describe('Class E authority conversions (atomic behind live-authority)', () => {
  it('A21 UserProvider: poll and listener share one extracted snapshot handler', () => {
    const src = readSrc('firebase/user-provider.tsx');
    expect(src).toContain('isClientSupaSurfaceOn(LIVE_AUTHORITY_SURFACE)');
    expect(src).toContain('const applyRoleDocSnapshot = async');
    // The OFF listener applies the same handler the ON poll applies.
    expect(src).toContain('await applyRoleDocSnapshot(docSnap.exists()');
    expect(src).toContain('await applyRoleDocSnapshot(res.exists, res.data)');
    expect(src).toContain('fetchAuthorityRoleDoc(authUser.uid)');
    expect(src).toContain('usePollingRefresh(');
    expect(src).toContain('MIN_POLL_INTERVAL_MS');
    // OFF listener retained.
    expect(src).toMatch(/unsubscribeRole = onSnapshot\(roleDocRef/);
  });

  it('A22 useRole: cache short-circuit precedes the flag branch (preserved nuance)', () => {
    const src = readSrc('hooks/use-role.ts');
    expect(src).toContain('isClientSupaSurfaceOn(LIVE_AUTHORITY_SURFACE)');
    expect(src).toContain('fetchAuthorityRoleDoc(userId)');
    const cacheIdx = src.indexOf('if (roleCache.has(userId))');
    const flagIdx = src.indexOf('if (authorityPolling)');
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(cacheIdx);
    // OFF listener retained.
    expect(src).toMatch(/unsubscribe = onSnapshot\(/);
  });

  it('B10 role-registry: definitions poll the seam route; OFF keeps listen:true', () => {
    const src = readSrc('components/admin/roles/role-registry.tsx');
    expect(src).toContain('isClientSupaSurfaceOn(LIVE_AUTHORITY_SURFACE)');
    expect(src).toContain('fetchRoleDefinitionsList()');
    expect(src).toContain('useCollection(authorityPolling ? null : roleDefinitionsCollectionRef, { listen: true })');
  });

  it('A23 is NOT converted: authority-refresh keeps its Firestore signal untouched', () => {
    const src = readSrc('lib/authority-refresh.ts');
    expect(src).toMatch(/onSnapshot\(refreshRef/);
    expect(src).not.toContain('LIVE_AUTHORITY_SURFACE');
    expect(src).not.toContain('LIVE_CHAT_SURFACE');
    expect(src).not.toContain('usePollingRefresh');
    // Its <30 s staleness guard — the reason polling can never serve it.
    expect(src).toContain('now - requestedAt < 30000');
  });
});

describe('Class C chat conversions (behind live-chat)', () => {
  it('enhanced-workflow-chat: all three listeners gated, heartbeat write intact', () => {
    const src = readSrc('components/workflow/enhanced-workflow-chat.tsx');
    expect(src).toContain('isClientSupaSurfaceOn(LIVE_CHAT_SURFACE)');
    expect(src).toContain('fetchChatState(workflowId, stableParticipants)');
    expect(src).toContain('usePollingRefresh(');
    // Typing + presence listener effects both stand down when ON.
    expect(src.match(/if \(chatPolling\) return;/g)).toHaveLength(2);
    // Messages hook receives no query when ON.
    expect(src).toContain('useCollection(chatPolling ? null : messagesQuery');
    // X4 heartbeat write untouched.
    expect(src).toContain('setInterval(updateOnline, 30000)');
  });

  it('A18 visualizer: presence converts under the same flag; tasks/messages stay', () => {
    const src = readSrc('components/profile/workflow-visualizer.tsx');
    expect(src).toContain('isClientSupaSurfaceOn(LIVE_CHAT_SURFACE)');
    expect(src).toContain('fetchChatState(workflowId, [])');
    expect(src).toContain('useCollection(wfQueryAll as any, { listen: realtime })');
    expect(src).toContain('useCollection(msgsQuery as any, { listen: realtime })');
  });

  it('chat-state route: token-verified, uid-bound membership, no client identity param', () => {
    const src = readSrc('app/api/workflows/chat-state/route.ts');
    expect(src).toContain('verifyAuthentication(req)');
    expect(src).toContain('auth.user.userId');
    expect(src).toContain("'participantIds', 'array-contains', uid");
    expect(src).toContain("useSupa('workflows')");
  });
});

describe('no browser realtime, no direct browser->Supabase reads', () => {
  it.each(CLIENT_FILES)('%s has no postgres_changes and no Supabase client import', (rel) => {
    const src = readSrc(rel);
    expect(src).not.toContain('postgres_changes');
    expect(src).not.toContain('@supabase/supabase-js');
    expect(src).not.toContain("from '@/lib/supa'");
  });
});

describe('Class D dead code stays deleted', () => {
  it.each([
    'components/community/leaderboard.tsx',
    'components/notifications/notification-center.tsx',
    'components/profile/assigned-tasks.tsx',
    'hooks/use-role-permissions.ts',
  ])('%s carries no onSnapshot token at all', (rel) => {
    expect(readSrc(rel)).not.toContain('onSnapshot');
  });

  it('useSafeFirestoreDocuments export is gone, its siblings remain', () => {
    const src = readSrc('hooks/use-safe-firestore-subscription.ts');
    expect(src).not.toContain('useSafeFirestoreDocuments');
    expect(src).toContain('export function useSafeFirestoreSubscription');
    expect(src).toContain('export function useSafeFirestoreDoc');
    expect(src).toContain('export function useSafeUserSubscription');
  });
});
