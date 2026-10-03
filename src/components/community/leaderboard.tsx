"use client";

import Image from "next/image";

import React, { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, query, orderBy, where, limit, startAfter, doc, getDoc, increment, runTransaction, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { useFirestore, useUser } from '@/firebase';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Trophy, Medal, Award, ChevronLeft, ChevronRight, ThumbsUp, ThumbsDown, Crown, Palmtree } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import type { Badge as BadgeType } from '@/types/badge';
import { getRoleDisplayName } from '@/lib/roles';
import { firebaseConfig } from '@/firebase/config';

// Helper to format rank icon
const getRankIcon = (rank: number) => {
  if (rank === 1) return <Trophy className="h-6 w-6 text-yellow-500" />;
  if (rank === 2) return <Medal className="h-6 w-6 text-gray-400" />;
  if (rank === 3) return <Award className="h-6 w-6 text-amber-600" />;
  return <span className="text-sm text-muted-foreground">#{rank}</span>;
};

// Helper to create proxy URL for profile pictures to avoid CORS
const getProxyImageUrl = (originalUrl: string | undefined) => {
  if (!originalUrl) return undefined;

  // Only proxy Google profile images and other external images
  const googleDomains = [
    'lh3.googleusercontent.com',
    'lh4.googleusercontent.com',
    'lh5.googleusercontent.com',
    'lh6.googleusercontent.com',
    'googleusercontent.com',
    'firebasestorage.googleapis.com'
  ];

  // Google profile images and Firebase Storage URLs work directly — no proxy needed
  return originalUrl;
};

// 🏁 DENORMALIZATION: Role fetching functions removed - roles are now included in user data

interface LeaderboardUser {
  id: string;
  displayName: string;
  email: string;
  photoURL?: string;
  points: number;
  totalHoursWorked?: number; // Hours contributed
  chapterId?: string;
  tasksAssignedCount?: number;
  tasksCompletedOnTimeCount?: number;
  university?: string;
  upvotes?: number;
  downvotes?: number;
  badges?: string[];
  displayRole?: string | null; // 🏁 DENORMALIZED: Direct access to role, no separate query needed
  isOnVacation?: boolean; // Vacation mode status for visual indicator
}

type BadgeDef = BadgeType;

/**
 * Leaderboard (Reusable Component)
 *
 * Self-contained interactive leaderboard with two tabs:
 * - Overall: Top users by points with pagination
 * - By University: Filter by chapter and show rankings
 *
 * Note: This component intentionally excludes page-level wrappers
 * like StarryBackground and Footer to allow flexible placement.
 */
export default function Leaderboard() {
  const firestore = useFirestore();
  const { user: currentUser } = useUser();

  // HIGH-PERFORMANCE: Client-side caching to eliminate re-fetching
  const [overallUsers, setOverallUsers] = useState<LeaderboardUser[]>([]);
  const [presidentUser, setPresidentUser] = useState<LeaderboardUser | null>(null);
  const [chapterUsers, setChapterUsers] = useState<LeaderboardUser[]>([]);
  const [loadingOverall, setLoadingOverall] = useState<boolean>(true);
  const [loadingChapter, setLoadingChapter] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [chapters, setChapters] = useState<Array<{ id: string; name: string; isActive?: boolean }>>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<string>('');
  // Settings: which roles should be shown by superadmin selection
  const [visibleRoles, setVisibleRoles] = useState<string[]>(['president_national']);
  // Settings: allow superadmin to pin a specific President UID
  const [settingsPresidentUid, setSettingsPresidentUid] = useState<string | null>(null);
  // 🏁 REMOVED: userRolesMap - no longer needed with denormalized displayRole
  const [badgeDefsMap, setBadgeDefsMap] = useState<Record<string, BadgeDef>>({});
  const [userVotes, setUserVotes] = useState<Record<string, 'up' | 'down' | null>>({});
  const [votingStates, setVotingStates] = useState<Record<string, { up: boolean; down: boolean }>>({});
  // Enhanced sorting: points, hours, upvotes, or tasks assigned
  const [sortBy, setSortBy] = useState<'points' | 'hours' | 'upvotes' | 'tasks'>('points');

  // ULTRA-FAST: Enhanced caching for maximum performance
  const [cache, setCache] = useState<{
    roles: Record<string, string | null>;
    badges: Record<string, BadgeDef>;
    users: LeaderboardUser[]; // Cache full user data
    lastFetch: number;
  }>({
    roles: {},
    badges: {},
    users: [],
    lastFetch: 0
  });

  const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

  // Role fetching — denormalized, no Firestore query needed
  const getCachedRoles = async (userIds: string[]): Promise<Record<string, string | null>> => {
    const now = Date.now();
    if (now - cache.lastFetch < CACHE_DURATION && Object.keys(cache.roles).length > 0) {
      const cachedRoles: Record<string, string | null> = {};
      userIds.forEach(userId => { cachedRoles[userId] = cache.roles[userId] || null; });
      return cachedRoles;
    }
    return {};
  };

  // CACHED: Badge definitions with intelligent caching
  const getCachedBadgeDefs = async (): Promise<Record<string, BadgeDef>> => {
    const now = Date.now();

    // Return cached data if still valid
    if (now - cache.lastFetch < CACHE_DURATION && Object.keys(cache.badges).length > 0) {
      return cache.badges;
    }

    // Fetch new data if cache is stale
    try {
      const snap = await getDocs(collection(firestore, 'badges'));
      const map: Record<string, BadgeDef> = {};
      snap.forEach((d) => {
        const data = d.data() as any;
        const slug = data.slug || d.id;
        map[slug] = { slug, name: data.name || slug, imageUrl: data.imageUrl || undefined } as BadgeDef;
      });

      setCache(prev => ({
        ...prev,
        badges: map,
        lastFetch: now
      }));

      return map;
    } catch (e) {
      console.warn('Failed to load badge definitions', e);
      return {};
    }
  };

  const chapterNameMap = useMemo(() => Object.fromEntries(chapters.map(c => [c.id, c.name])), [chapters]);

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'U';
    return name.split(' ').map((n) => n[0]).join('');
  };

  // Enhanced voting functions with robust error handling
  const handleVote = async (targetUserId: string, voteType: 'up' | 'down') => {
    // Basic validations
    if (!currentUser) return;
    if (votingStates[targetUserId]?.[voteType]) return;
    if (userVotes[targetUserId] === voteType) return;

    const targetUser = overallUsers.find(u => u.id === targetUserId) || chapterUsers.find(u => u.id === targetUserId);
    if (!targetUser || targetUser.id === currentUser.uid) return;

    // Start voting process
    setVotingStates(prev => ({
      ...prev,
      [targetUserId]: { ...prev[targetUserId], [voteType]: true }
    }));

    const voterUid = currentUser.uid;
    const targetRef = doc(firestore, 'users', targetUserId);
    const voteRef = doc(firestore, 'users', targetUserId, 'votes', voterUid);

    try {
      // Use transaction for atomic operations
      await runTransaction(firestore, async (tx) => {
        const existing = await tx.get(voteRef);
        if (existing.exists()) {
          throw new Error('ALREADY_VOTED');
        }

        // Create vote document and update user in single atomic operation
        tx.set(voteRef, {
          type: voteType,
          voterUid,
          createdAt: serverTimestamp(),
          targetUserName: targetUser.displayName
        });
        tx.update(targetRef, { [voteType === 'up' ? 'upvotes' : 'downvotes']: increment(1) });
      });

      // Update local state on success
      setUserVotes(prev => ({ ...prev, [targetUserId]: voteType }));

      // Optimistic UI updates
      if (voteType === 'up') {
        setOverallUsers(prev => prev.map(u => u.id === targetUserId ? { ...u, upvotes: (u.upvotes || 0) + 1 } : u));
        setChapterUsers(prev => prev.map(u => u.id === targetUserId ? { ...u, upvotes: (u.upvotes || 0) + 1 } : u));
      } else {
        setOverallUsers(prev => prev.map(u => u.id === targetUserId ? { ...u, downvotes: (u.downvotes || 0) + 1 } : u));
        setChapterUsers(prev => prev.map(u => u.id === targetUserId ? { ...u, downvotes: (u.downvotes || 0) + 1 } : u));
      }

    } catch (error: any) {
      const errorMessage = String(error);

      if (errorMessage.includes('ALREADY_VOTED')) {
        // Update local state to reflect the existing vote
        setUserVotes(prev => ({ ...prev, [targetUserId]: 'up' })); // Assume up if exists
      } else if (errorMessage.includes('permission-denied') || errorMessage.includes('insufficient permissions')) {
        console.error('Vote failed - permission denied', error);
        alert('Permission denied. Please check your login status and try again.');
      } else {
        console.error(`Vote failed - ${voteType}vote error:`, error);
        alert(`Failed to submit ${voteType}vote. Please try again.`);
      }
    } finally {
      // Always reset voting state
      setVotingStates(prev => ({
        ...prev,
        [targetUserId]: { ...prev[targetUserId], [voteType]: false }
      }));
    }
  };

  // OPTIMIZATION: Removed eager vote pre-loading to eliminate N+1 queries.
  // Votes are now checked inline when user clicks vote button.
  // This reduces initial page load by 10+ Firestore reads.

  // Vote updates handled by API cache invalidation — no real-time listeners needed
  useEffect(() => { }, [overallUsers, chapterUsers]);

  // EFFICIENT PAGINATION: 10 users per page with fast loading
  const PAGE_SIZE = 10;
  const [overallPage, setOverallPage] = useState<number>(1);
  const [overallLastDoc, setOverallLastDoc] = useState<any>(null);
  const [overallAnchors, setOverallAnchors] = useState<any[]>([]); // stores firstDoc of each loaded page for prev navigation

  // 🏆 SERVER-SIDE AGGREGATION: API cache for maximum performance
  const [apiCache, setApiCache] = useState<Record<string, {
    data: any;
    timestamp: number;
    page: number;
    chapterId?: string;
  }>>({});

  const API_CACHE_DURATION = 30 * 1000; // 30 seconds cache
  const getCachedApiData = (page: number, chapterId?: string) => {
    const cacheKey = `${page}-${chapterId || 'overall'}`;
    const cached = apiCache[cacheKey];
    if (cached && Date.now() - cached.timestamp < API_CACHE_DURATION) {
      return cached.data;
    }
    return null;
  };

  const setCachedApiData = (page: number, data: any, chapterId?: string) => {
    const cacheKey = `${page}-${chapterId || 'overall'}`;
    setApiCache(prev => ({
      ...prev,
      [cacheKey]: {
        data,
        timestamp: Date.now(),
        page,
        chapterId,
      }
    }));
  };

  // AGGREGATED API: Replace expensive real-time listeners with single API call
  const fetchAggregatedLeaderboard = async (page: number = 1, chapterId?: string) => {
    const cachedData = getCachedApiData(page, chapterId);
    if (cachedData) return cachedData;

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: PAGE_SIZE.toString(),
        ...(chapterId && { chapterId })
      });

      const response = await fetch(`/api/leaderboard-aggregate?${params}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        next: { revalidate: 30 },
      });

      if (!response.ok) throw new Error(`API request failed: ${response.status}`);

      const data = await response.json();
      setCachedApiData(page, data, chapterId);
      return data;
    } catch (error) {
      console.error('Failed to fetch aggregated leaderboard data:', error);
      throw error;
    }
  };

  // PARALLEL INIT: Fetch chapters, president, badge defs, and settings in a single Promise.all
  // to avoid 4 sequential waterfall round-trips on mount.
  useEffect(() => {
    const initLeaderboard = async () => {
      try {
        const [chaptersSnap, settingsDoc, badgeMap] = await Promise.all([
          getDocs(query(collection(firestore, 'chapters'), where('isActive', '==', true))),
          getDoc(doc(firestore, 'settings', 'leaderboard')),
          getCachedBadgeDefs(),
        ]);

        // Chapters
        const list = chaptersSnap.docs.map(d => ({
          id: d.id,
          name: (d.data() as any).name || 'Unnamed',
          isActive: (d.data() as any).isActive,
        }));
        setChapters(list);

        // Badge definitions
        setBadgeDefsMap(badgeMap);

        // Leaderboard settings
        let resolvedPresidentUid: string | null = null;
        if (settingsDoc.exists()) {
          const data = settingsDoc.data() as any;
          const roles = Array.isArray(data.visibleRoles)
            ? data.visibleRoles.filter((r: any) => typeof r === 'string')
            : null;
          if (roles && roles.length > 0) setVisibleRoles(roles);

          const pinned = [
            'presidentUid', 'featuredPresidentUid', 'presidentId',
            'featuredPresidentId', 'topPresidentUid', 'topPresidentId',
          ].map((k) => (typeof (data?.[k]) === 'string' ? String(data[k]) : null)).find(Boolean);
          resolvedPresidentUid = pinned || null;
          setSettingsPresidentUid(resolvedPresidentUid);
        }

        // President (can now use the resolved UID without a second render cycle)
        const targetUid = resolvedPresidentUid ||
          process.env.NEXT_PUBLIC_FIREBASE_FOUNDER_UID ||
          'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
        const userDocSnap = await getDoc(doc(firestore, 'users', targetUid));
        if (userDocSnap.exists()) {
          const u = userDocSnap.data() as any;
          setPresidentUser({
            id: targetUid,
            displayName: u.displayName || u.name || u.email || 'President',
            email: u.email || '',
            photoURL: u.photoURL || undefined,
            points: typeof u.points === 'number' ? u.points : 0,
            displayRole: u.displayRole || 'president_national',
            chapterId: u.chapterId || undefined,
            tasksAssignedCount: u.tasksAssignedCount || 0,
            tasksCompletedOnTimeCount: u.tasksCompletedOnTimeCount || 0,
            university: u.university || undefined,
            upvotes: typeof u.upvotes === 'number' ? u.upvotes : 0,
            downvotes: typeof u.downvotes === 'number' ? u.downvotes : 0,
            badges: Array.isArray(u.badges) ? u.badges.slice(0, 5) : [],
          });
        } else {
          setPresidentUser(null);
        }
      } catch (e) {
        console.warn('Failed to initialise leaderboard metadata', e);
      }
    };
    initLeaderboard();
  }, [firestore]);

  // Load overall leaderboard via aggregated API
  useEffect(() => {
    const loadOverallUsers = async () => {
      setLoadingOverall(true);
      setError('');
      try {
        const data = await fetchAggregatedLeaderboard(1);
        if (!data.users || data.users.length === 0) {
          setOverallUsers([]);
          setLoadingOverall(false);
          return;
        }
        const rows: LeaderboardUser[] = data.users.map((u: any) => ({
          id: u.id,
          displayName: u.displayName || 'Anonymous',
          email: u.email || '',
          photoURL: u.photoURL || undefined,
          points: Number(u.points || 0),
          totalHoursWorked: Number(u.totalHoursWorked || 0),
          displayRole: u.role || u.displayRole || null,
          chapterId: u.chapterId || undefined,
          tasksAssignedCount: Number(u.tasksAssignedCount || 0),
          tasksCompletedOnTimeCount: Number(u.tasksCompletedOnTimeCount || 0),
          university: u.university || undefined,
          upvotes: Number(u.upvotes || 0),
          downvotes: Number(u.downvotes || 0),
          badges: Array.isArray(u.badges) ? u.badges.slice(0, 5) : [],
          isOnVacation: u.isOnVacation || false,
          ...(u.chapter ? { chapter: u.chapter } : {}),
        }));
        setOverallUsers(rows);
        const hasMoreData = data.pagination?.hasNext;
        setOverallLastDoc(hasMoreData ? { id: 'api-cursor' } : null);
        setOverallAnchors([]);
        setOverallPage(1);
      } catch (error: any) {
        console.error('Failed to load leaderboard:', error.message);
        setError(`Failed to load leaderboard data: ${error.message}`);
      } finally {
        setLoadingOverall(false);
      }
    };
    loadOverallUsers();
  }, [firestore]);

  // Next page handler
  const handleNextOverallPage = async () => {
    const nextPage = overallPage + 1;
    try {
      setLoadingOverall(true);
      const data = await fetchAggregatedLeaderboard(nextPage);
      if (!data.users || data.users.length === 0) { setLoadingOverall(false); return; }
      const rows: LeaderboardUser[] = data.users.map((u: any) => ({
        id: u.id,
        displayName: u.displayName || 'Anonymous',
        email: u.email || '',
        photoURL: u.photoURL || undefined,
        points: Number(u.points || 0),
        totalHoursWorked: Number(u.totalHoursWorked || 0),
        displayRole: u.role || u.displayRole || null,
        chapterId: u.chapterId || undefined,
        tasksAssignedCount: Number(u.tasksAssignedCount || 0),
        tasksCompletedOnTimeCount: Number(u.tasksCompletedOnTimeCount || 0),
        university: u.university || undefined,
        upvotes: Number(u.upvotes || 0),
        downvotes: Number(u.downvotes || 0),
        badges: Array.isArray(u.badges) ? u.badges.slice(0, 5) : [],
        ...(u.chapter ? { chapter: u.chapter } : {}),
      }));
      setOverallUsers(rows);
      setOverallLastDoc(data.pagination?.hasNext ? { id: 'api-cursor' } : null);
      setOverallAnchors((prev) => [...prev, { id: 'api-page-' + overallPage }]);
      setOverallPage(nextPage);
    } catch (e) {
      console.error('Failed to load next page', e);
    } finally {
      setLoadingOverall(false);
    }
  };

  // Previous page handler
  const handlePrevOverallPage = async () => {
    if (overallPage <= 1) return;
    const prevPage = overallPage - 1;
    try {
      setLoadingOverall(true);
      const data = await fetchAggregatedLeaderboard(prevPage);
      const rows: LeaderboardUser[] = data.users.map((u: any) => ({
        id: u.id,
        displayName: u.displayName || 'Anonymous',
        email: u.email || '',
        photoURL: u.photoURL || undefined,
        points: Number(u.points || 0),
        totalHoursWorked: Number(u.totalHoursWorked || 0),
        displayRole: u.role || u.displayRole || null,
        chapterId: u.chapterId || undefined,
        tasksAssignedCount: Number(u.tasksAssignedCount || 0),
        tasksCompletedOnTimeCount: Number(u.tasksCompletedOnTimeCount || 0),
        university: u.university || undefined,
        upvotes: Number(u.upvotes || 0),
        downvotes: Number(u.downvotes || 0),
        badges: Array.isArray(u.badges) ? u.badges.slice(0, 5) : [],
        ...(u.chapter ? { chapter: u.chapter } : {}),
      }));
      setOverallUsers(rows);
      setOverallLastDoc(data.pagination?.hasNext ? { id: 'api-cursor' } : null);
      setOverallAnchors((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
      setOverallPage(prevPage);
    } catch (e) {
      console.error('Failed to load prev page', e);
    } finally {
      setLoadingOverall(false);
    }
  };

  useEffect(() => {
    const fetchByChapter = async () => {
      if (!selectedChapterId) { setChapterUsers([]); return; }
      setLoadingChapter(true);
      setError('');
      try {
        const data = await fetchAggregatedLeaderboard(1, selectedChapterId);
        const rows: LeaderboardUser[] = (data?.users || []).map((u: any) => ({
          id: u.id,
          displayName: u.displayName || 'Anonymous',
          email: u.email || '',
          photoURL: u.photoURL || undefined,
          points: Number(u.points || 0),
          totalHoursWorked: Number(u.totalHoursWorked || 0),
          displayRole: u.role || u.displayRole || null,
          chapterId: u.chapterId || undefined,
          tasksAssignedCount: Number(u.tasksAssignedCount || 0),
          tasksCompletedOnTimeCount: Number(u.tasksCompletedOnTimeCount || 0),
          university: u.university || undefined,
          upvotes: Number(u.upvotes || 0),
          downvotes: Number(u.downvotes || 0),
          badges: Array.isArray(u.badges) ? u.badges.slice(0, 5) : [],
          ...(u.chapter ? { chapter: u.chapter } : {}),
        }));
        setChapterUsers(rows);
      } catch (e: any) {
        setError('Failed to load chapter leaderboard. ' + String(e?.message || e));
      } finally {
        setLoadingChapter(false);
      }
    };
    fetchByChapter();
  }, [firestore, selectedChapterId]);

  const getRankBadge = (rank: number) => {
    if (rank === 1) return 'bg-yellow-500/20 border-yellow-500/50';
    if (rank === 2) return 'bg-gray-400/20 border-gray-400/50';
    if (rank === 3) return 'bg-amber-600/20 border-amber-600/50';
    return 'bg-card/80 border-primary/20';
  };

  return (
    <div className="max-w-6xl mx-auto">
      <Tabs defaultValue="overall">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="overall">Overall</TabsTrigger>
          <TabsTrigger value="chapter">By University</TabsTrigger>
        </TabsList>

        {/* Overall Leaderboard */}
        <TabsContent value="overall">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardHeader className="flex items-center justify-between">
              <div>
                <CardTitle>Top Members</CardTitle>
                <CardDescription className="flex items-center gap-3">
                  <span>Page {overallPage}</span>
                  <span className="text-muted-foreground">•</span>
                  <span className="flex items-center gap-2">
                    Sort by:
                    <Select value={sortBy} onValueChange={(v: 'points' | 'hours' | 'upvotes' | 'tasks') => setSortBy(v)}>
                      <SelectTrigger className="w-28 h-6 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="points">Points</SelectItem>
                        <SelectItem value="hours">Hours</SelectItem>
                        <SelectItem value="upvotes">Upvotes</SelectItem>
                        <SelectItem value="tasks">Tasks</SelectItem>
                      </SelectContent>
                    </Select>
                  </span>
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handlePrevOverallPage} disabled={overallPage === 1 || loadingOverall}>
                  <ChevronLeft className="h-4 w-4" /> Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextOverallPage}
                  disabled={loadingOverall || !overallLastDoc}
                >
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
                <span className="text-xs text-muted-foreground">Page {overallPage}</span>
              </div>
            </CardHeader>
            <CardContent>
              {loadingOverall ? (
                <div className="space-y-2">
                  {[...Array(10)].map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : overallUsers.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">Rank</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Points</TableHead>
                        <TableHead>Hours</TableHead>
                        <TableHead className="hidden md:table-cell">Upvotes</TableHead>
                        <TableHead className="hidden md:table-cell">Downvotes</TableHead>
                        <TableHead className="hidden md:table-cell">Vote</TableHead>
                        <TableHead className="hidden md:table-cell">Badges</TableHead>
                        <TableHead className="hidden md:table-cell">Tasks Assigned</TableHead>
                        <TableHead className="hidden md:table-cell">On-time Completions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {/* Pinned President row at the top with real values */}
                      {presidentUser && (
                        <TableRow key={`president-${presidentUser.id}`} className="border bg-primary/10">
                          <TableCell><Crown className="h-5 w-5 text-yellow-500" /></TableCell>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <Link href={`/profile/unified/${presidentUser.id}`} className="flex items-center gap-3 group">
                                <Avatar className="h-8 w-8">
                                  <AvatarImage src={getProxyImageUrl(presidentUser.photoURL) || undefined} alt={presidentUser.displayName} />
                                  <AvatarFallback>{getInitials(presidentUser.displayName)}</AvatarFallback>
                                </Avatar>
                                <div className="flex flex-col">
                                  <span className="font-medium group-hover:underline">{presidentUser.displayName}</span>
                                  {(() => {
                                    const roleLabel = presidentUser.displayRole ? getRoleDisplayName(presidentUser.displayRole) : 'President';
                                    const chapterLabel = presidentUser.university || chapterNameMap[presidentUser.chapterId || ''] || 'National';
                                    return <span className="text-xs text-muted-foreground">{roleLabel} @ {chapterLabel}</span>;
                                  })()}
                                </div>
                              </Link>
                            </div>
                          </TableCell>
                          <TableCell>{presidentUser.points ?? 0}</TableCell>
                          <TableCell>{presidentUser.totalHoursWorked ?? 0}h</TableCell>
                          <TableCell className="hidden md:table-cell">{presidentUser.upvotes ?? 0}</TableCell>
                          <TableCell className="hidden md:table-cell">{currentUser?.uid === presidentUser.id ? (presidentUser.downvotes ?? 0) : '—'}</TableCell>
                          {/* Voting buttons for President */}
                          <TableCell className="hidden md:table-cell">
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className={`h-6 w-6 p-0 ${userVotes[presidentUser.id] === 'up'
                                  ? 'text-green-600 bg-green-50 hover:bg-green-100'
                                  : 'hover:bg-gray-100'
                                  }`}
                                onClick={() => handleVote(presidentUser.id, 'up')}
                                disabled={
                                  !currentUser ||
                                  currentUser.uid === presidentUser.id ||
                                  votingStates[presidentUser.id]?.up ||
                                  !!userVotes[presidentUser.id]
                                }
                                title={userVotes[presidentUser.id] === 'up' ? 'You upvoted this' : 'Upvote'}
                              >
                                <ThumbsUp className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className={`h-6 w-6 p-0 ${userVotes[presidentUser.id] === 'down'
                                  ? 'text-red-600 bg-red-50 hover:bg-red-100'
                                  : 'hover:bg-gray-100'
                                  }`}
                                onClick={() => handleVote(presidentUser.id, 'down')}
                                disabled={
                                  !currentUser ||
                                  currentUser.uid === presidentUser.id ||
                                  votingStates[presidentUser.id]?.down ||
                                  !!userVotes[presidentUser.id]
                                }
                                title={userVotes[presidentUser.id] === 'down' ? 'You downvoted this' : 'Downvote'}
                              >
                                <ThumbsDown className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {(presidentUser.badges || []).length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {(presidentUser.badges || []).slice(0, 5).map((b) => {
                                  const def = badgeDefsMap[b];
                                  return (
                                    <Badge key={b} variant="secondary" className="flex items-center justify-center p-1">
                                      {def?.imageUrl ? (
                                        <Image src={def.imageUrl} alt={def?.name || b} title={def?.name || b} width={16} height={16} className="h-4 w-4 rounded-sm" />
                                      ) : (
                                        <Award className="h-4 w-4 text-muted-foreground" />
                                      )}
                                    </Badge>
                                  );
                                })}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{presidentUser.tasksAssignedCount ?? 0}</TableCell>
                          <TableCell className="hidden md:table-cell">{presidentUser.tasksCompletedOnTimeCount ?? 0}</TableCell>
                        </TableRow>
                      )}
                      {/* Regular users excluding pinned President and any other Presidents */}
                      {(() => {
                        const afterFirstFilter = overallUsers
                          .filter((u) => !presidentUser || u.id !== presidentUser.id);

                        // Only filter out if they are an ACTUAL president AND not the pinned president
                        const afterSecondFilter = afterFirstFilter
                          .filter((u) => {
                            const role = u.displayRole || null; // 🏁 DENORMALIZED: Direct access to displayRole
                            const isRegularPresident = role === 'president_national' && (!presidentUser || u.id !== presidentUser.id);
                            return !isRegularPresident;
                          });

                        // Sort by selected metric (points, hours, upvotes, or tasks)
                        const sorted = [...afterSecondFilter].sort((a, b) => {
                          switch (sortBy) {
                            case 'hours':
                              return (b.totalHoursWorked || 0) - (a.totalHoursWorked || 0);
                            case 'upvotes':
                              return (b.upvotes || 0) - (a.upvotes || 0);
                            case 'tasks':
                              return (b.tasksAssignedCount || 0) - (a.tasksAssignedCount || 0);
                            case 'points':
                            default:
                              return (b.points || 0) - (a.points || 0);
                          }
                        });

                        return sorted;
                      })()
                        .map((u, idx) => (
                          <TableRow key={u.id} className={`border ${getRankBadge(idx + 1)}`}>
                            <TableCell>{getRankIcon(idx + 1)}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-3">
                                <Link href={`/profile/unified/${u.id}`} className="flex items-center gap-3 group">
                                  <Avatar className="h-8 w-8">
                                    <AvatarImage src={getProxyImageUrl(u.photoURL) || undefined} alt={u.displayName} />
                                    <AvatarFallback>{getInitials(u.displayName)}</AvatarFallback>
                                  </Avatar>
                                  <div className="flex flex-col">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium group-hover:underline">{u.displayName}</span>
                                      {u.isOnVacation && (
                                        <Badge variant="secondary" className="text-[10px] h-5 px-1.5 bg-amber-500/10 text-amber-400 border-amber-500/30">
                                          <Palmtree className="h-3 w-3 mr-0.5" /> On Leave
                                        </Badge>
                                      )}
                                    </div>
                                    {(() => {
                                      const role = u.displayRole || 'member';
                                      const roleLabel = getRoleDisplayName(role);
                                      const chapterLabel = (u as any).chapter?.name || chapterNameMap[u.chapterId || ''] || u.university || 'National';
                                      return <span className="text-xs text-muted-foreground">{roleLabel} @ {chapterLabel}</span>;
                                    })()}
                                  </div>
                                </Link>
                              </div>
                            </TableCell>
                            <TableCell>{u.points}</TableCell>
                            <TableCell>{u.totalHoursWorked || 0}h</TableCell>
                            <TableCell className="hidden md:table-cell">{u.upvotes ?? 0}</TableCell>
                            <TableCell className="hidden md:table-cell">{u.downvotes ?? 0}</TableCell>
                            {/* Voting buttons for regular users */}
                            <TableCell className="hidden md:table-cell">
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className={`h-6 w-6 p-0 ${userVotes[u.id] === 'up'
                                    ? 'text-green-600 bg-green-50 hover:bg-green-100'
                                    : 'hover:bg-gray-100'
                                    }`}
                                  onClick={() => handleVote(u.id, 'up')}
                                  disabled={
                                    !currentUser ||
                                    currentUser.uid === u.id ||
                                    votingStates[u.id]?.up ||
                                    !!userVotes[u.id]
                                  }
                                  title={userVotes[u.id] === 'up' ? 'You upvoted this' : 'Upvote'}
                                >
                                  <ThumbsUp className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className={`h-6 w-6 p-0 ${userVotes[u.id] === 'down'
                                    ? 'text-red-600 bg-red-50 hover:bg-red-100'
                                    : 'hover:bg-gray-100'
                                    }`}
                                  onClick={() => handleVote(u.id, 'down')}
                                  disabled={
                                    !currentUser ||
                                    currentUser.uid === u.id ||
                                    votingStates[u.id]?.down ||
                                    !!userVotes[u.id]
                                  }
                                  title={userVotes[u.id] === 'down' ? 'You downvoted this' : 'Downvote'}
                                >
                                  <ThumbsDown className="h-3 w-3" />
                                </Button>
                              </div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              {(u.badges || []).length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {(u.badges || []).slice(0, 5).map((b) => {
                                    const def = badgeDefsMap[b];
                                    return (
                                      <Badge key={b} variant="secondary" className="flex items-center justify-center p-1">
                                        {def?.imageUrl ? (
                                          <Image src={def.imageUrl} alt={def?.name || b} title={def?.name || b} width={16} height={16} className="h-4 w-4 rounded-sm" />
                                        ) : (
                                          <Award className="h-4 w-4 text-muted-foreground" />
                                        )}
                                      </Badge>
                                    );
                                  })}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden md:table-cell">{u.tasksAssignedCount || 0}</TableCell>
                            <TableCell className="hidden md:table-cell">{u.tasksCompletedOnTimeCount || 0}</TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-10">
                  <p className="text-muted-foreground">No data available</p>
                </div>
              )}
              {error && (
                <p className="mt-4 text-sm text-destructive">{error}</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Chapter Leaderboard */}
        <TabsContent value="chapter">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardHeader className="flex items-center justify-between">
              <div>
                <CardTitle>University Rankings</CardTitle>
                <CardDescription>Filter by chapter to see local rankings</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Select value={selectedChapterId} onValueChange={setSelectedChapterId}>
                  <SelectTrigger className="w-[220px]">
                    <SelectValue placeholder="Select a university" />
                  </SelectTrigger>
                  <SelectContent>
                    {chapters.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {loadingChapter ? (
                <div className="space-y-2">
                  {[...Array(10)].map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : chapterUsers.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">Rank</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Points</TableHead>
                        <TableHead className="hidden md:table-cell">Upvotes</TableHead>
                        <TableHead className="hidden md:table-cell">Downvotes</TableHead>
                        <TableHead className="hidden md:table-cell">Vote</TableHead>
                        <TableHead className="hidden md:table-cell">Badges</TableHead>
                        <TableHead className="hidden md:table-cell">Tasks Assigned</TableHead>
                        <TableHead className="hidden md:table-cell">On-time Completions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {chapterUsers.map((u, idx) => (
                        <TableRow key={u.id} className={`border ${getRankBadge(idx + 1)}`}>
                          <TableCell>{getRankIcon(idx + 1)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <Link href={`/profile/unified/${u.id}`} className="flex items-center gap-3 group">
                                <Avatar className="h-8 w-8">
                                  <AvatarImage src={getProxyImageUrl(u.photoURL) || undefined} alt={u.displayName} />
                                  <AvatarFallback>{getInitials(u.displayName)}</AvatarFallback>
                                </Avatar>
                                <div className="flex flex-col">
                                  <span className="font-medium group-hover:underline">{u.displayName}</span>
                                  {(() => {
                                    const role = u.displayRole || 'member';
                                    const roleLabel = getRoleDisplayName(role);
                                    const chapterLabel = chapterNameMap[u.chapterId || ''] || u.university || '—';
                                    return <span className="text-xs text-muted-foreground">{roleLabel} @{chapterLabel}</span>;
                                  })()}
                                </div>
                              </Link>
                            </div>
                          </TableCell>
                          <TableCell>{u.points}</TableCell>
                          <TableCell className="hidden md:table-cell">{u.upvotes ?? 0}</TableCell>
                          <TableCell className="hidden md:table-cell">{u.downvotes ?? 0}</TableCell>
                          {/* Voting buttons for chapter users */}
                          <TableCell className="hidden md:table-cell">
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className={`h-6 w-6 p-0 ${userVotes[u.id] === 'up'
                                  ? 'text-green-600 bg-green-50 hover:bg-green-100'
                                  : 'hover:bg-gray-100'
                                  }`}
                                onClick={() => handleVote(u.id, 'up')}
                                disabled={
                                  !currentUser ||
                                  currentUser.uid === u.id ||
                                  votingStates[u.id]?.up ||
                                  !!userVotes[u.id]
                                }
                                title={userVotes[u.id] === 'up' ? 'You upvoted this' : 'Upvote'}
                              >
                                <ThumbsUp className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className={`h-6 w-6 p-0 ${userVotes[u.id] === 'down'
                                  ? 'text-red-600 bg-red-50 hover:bg-red-100'
                                  : 'hover:bg-gray-100'
                                  }`}
                                onClick={() => handleVote(u.id, 'down')}
                                disabled={
                                  !currentUser ||
                                  currentUser.uid === u.id ||
                                  votingStates[u.id]?.down ||
                                  !!userVotes[u.id]
                                }
                                title={userVotes[u.id] === 'down' ? 'You downvoted this' : 'Downvote'}
                              >
                                <ThumbsDown className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {(u.badges || []).length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {(u.badges || []).slice(0, 5).map((b) => {
                                  const def = badgeDefsMap[b];
                                  return (
                                    <Badge key={b} variant="secondary" className="flex items-center justify-center p-1">
                                      {def?.imageUrl ? (
                                        <Image src={def.imageUrl} alt={def?.name || b} title={def?.name || b} width={16} height={16} className="h-4 w-4 rounded-sm" />
                                      ) : (
                                        <Award className="h-4 w-4 text-muted-foreground" />
                                      )}
                                    </Badge>
                                  );
                                })}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{u.tasksAssignedCount || 0}</TableCell>
                          <TableCell className="hidden md:table-cell">{u.tasksCompletedOnTimeCount || 0}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-10">
                  <p className="text-muted-foreground text-lg">{selectedChapterId ? 'No users found for this university.' : 'Select a university to see its rankings.'}</p>
                </div>
              )}
              {error && (
                <p className="mt-4 text-sm text-destructive">{error}</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
