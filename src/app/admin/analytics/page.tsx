'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
// Uses persistent layout at app/admin/layout.tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, LineChart, Users, Eye, Rocket } from 'lucide-react';
import { useFirestore } from '@/firebase';
import { collection, query, orderBy, getDocs, doc, getDoc, getCountFromServer, limit } from 'firebase/firestore';
import {
  ResponsiveContainer,
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart as RechartsBarChart,
  Bar
} from 'recharts';

interface PageVisitData {
  path: string;
  visits: number;
  lastVisit: any;
}

export default function AdminAnalyticsPage() {
  const { user, role, isLoading } = useUser();
  const firestore = useFirestore();
  const [pageVisits, setPageVisits] = useState<PageVisitData[]>([]);
  const [totalVisits, setTotalVisits] = useState<number>(0);
  const [totalUsers, setTotalUsers] = useState<number>(0);
  const [projectsCount, setProjectsCount] = useState<number>(0);
  const [recentEvents, setRecentEvents] = useState<Array<{ type: string; label: string | null; path: string | null; targetId: string | null; timestamp: any; timeOnPageMs?: number | null; scrollDepth?: number | null }>>([]);
  const [topClicked, setTopClicked] = useState<Array<{ label: string; count: number }>>([]);
  const [clicksByDay, setClicksByDay] = useState<Array<{ date: string; count: number }>>([]);
  const [avgTimeOnPageMs, setAvgTimeOnPageMs] = useState<number>(0);
  const [avgScrollDepth, setAvgScrollDepth] = useState<number>(0);

  useEffect(() => {
    const fetchMetrics = async () => {
      if (!user) return;
      // Page visits: read top pages and total from a dedicated doc
      const visitsQuery = query(collection(firestore, 'pageVisits'), orderBy('visits', 'desc'));
      const visitsSnapshot = await getDocs(visitsQuery);
      const visitsData: PageVisitData[] = [];

      visitsSnapshot.forEach((d) => {
        const data = d.data() as PageVisitData;
        // Exclude the site-wide counter from per-page list
        if (d.id !== 'site_total_visits') {
          visitsData.push({ ...data, path: d.id.replace(/_/g, '/') });
        }
      });
      setPageVisits(visitsData);

      // Total page views from the dedicated counter doc
      try {
        const totalDoc = await getDoc(doc(firestore, 'pageVisits', 'site_total_visits'));
        setTotalVisits(totalDoc.exists() ? (totalDoc.data()?.visits ?? 0) : 0);
      } catch {
        setTotalVisits(0);
      }

      // Total users via count aggregation
      try {
        const usersAgg = await getCountFromServer(collection(firestore, 'users'));
        setTotalUsers(usersAgg.data().count || 0);
      } catch {
        setTotalUsers(0);
      }

      // Projects created (live count)
      try {
        const projectsAgg = await getCountFromServer(collection(firestore, 'projects'));
        setProjectsCount(projectsAgg.data().count || 0);
      } catch {
        setProjectsCount(0);
      }

      // Recent analytics events (last 200) for admin diagnostics
      try {
        const eventsQuery = query(collection(firestore, 'analyticsEvents'), orderBy('timestamp', 'desc'), limit(200));
        const eventsSnapshot = await getDocs(eventsQuery);
        const events = eventsSnapshot.docs.map(d => {
          const data = d.data() as any;
          return {
            type: data.type ?? 'unknown',
            label: data.label ?? null,
            path: data.path ?? null,
            targetId: data.targetId ?? null,
            timestamp: data.timestamp ?? null,
            timeOnPageMs: data.timeOnPageMs ?? data.durationMs ?? null,
            scrollDepth: data.scrollDepth ?? null,
          };
        });
        setRecentEvents(events);

        // Aggregate top clicked labels/targets
        const labelCounts: Record<string, number> = {};
        for (const e of events) {
          if (e.type !== 'click') continue;
          const key = (e.label || e.targetId || 'unknown');
          labelCounts[key] = (labelCounts[key] || 0) + 1;
        }
        const top = Object.entries(labelCounts)
          .map(([label, count]) => ({ label, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5);
        setTopClicked(top);

        // Clicks trend: bucket last 7 days
        const buckets: Record<string, number> = {};
        const now = new Date();
        for (let i = 0; i < 7; i++) {
          const d = new Date(now);
          d.setDate(now.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          buckets[key] = 0;
        }
        for (const e of events) {
          if (e.type !== 'click' || !e.timestamp?.toDate) continue;
          const d = e.timestamp.toDate();
          const key = d.toISOString().slice(0, 10);
          if (key in buckets) buckets[key] += 1;
        }
        const trend = Object.entries(buckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count }));
        setClicksByDay(trend);

        // Time on page average
        const times: number[] = events.filter(e => e.type === 'time_on_page' && typeof e.timeOnPageMs === 'number').map(e => e.timeOnPageMs as number);
        const avgTime = times.length ? Math.round(times.reduce((s, v) => s + v, 0) / times.length) : 0;
        setAvgTimeOnPageMs(avgTime);

        // Scroll depth average
        const depths: number[] = events.filter(e => e.type === 'scroll_depth' && typeof e.scrollDepth === 'number').map(e => e.scrollDepth as number);
        const avgDepth = depths.length ? Math.round(depths.reduce((s, v) => s + v, 0) / depths.length) : 0;
        setAvgScrollDepth(avgDepth);
      } catch {
        setRecentEvents([]);
        setTopClicked([]);
        setClicksByDay([]);
        setAvgTimeOnPageMs(0);
        setAvgScrollDepth(0);
      }
    };

    fetchMetrics();
  }, [firestore]);

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p>Loading analytics...</p>
      </div>
    );
  }

  if (!user || !role) {
    return null;
  }

  const top5Pages = pageVisits.filter(visit => visit.path !== 'home').slice(0, 5);

  return (
    <AuthorizationGate permission="canViewAnalytics">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-glow mb-2">Site Analytics</h1>
        <p className="text-muted-foreground">Monitor user engagement and content performance</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Total Users Card */}
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalUsers}</div>
            <p className="text-xs text-muted-foreground">Registered users</p>
          </CardContent>
        </Card>

        {/* Page Views Card */}
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Page Views</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalVisits}</div>
            <p className="text-xs text-muted-foreground">Total page views across the site</p>
          </CardContent>
        </Card>

        {/* Projects Created Card */}
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Projects Created</CardTitle>
            <Rocket className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{projectsCount}</div>
            <p className="text-xs text-muted-foreground">Live count from Firestore</p>
          </CardContent>
        </Card>

        {/* Top 5 Page Visits Chart */}
        <Card className="col-span-1 md:col-span-2 lg:col-span-3 bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>Top 5 Page Visits</CardTitle>
            <CardDescription>Most visited pages on the site.</CardDescription>
          </CardHeader>
          <CardContent>
            {pageVisits.length > 0 ? (
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsBarChart data={top5Pages}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="path" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="visits" fill="#8884d8" />
                  </RechartsBarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                <BarChart className="h-16 w-16" />
                <p className="ml-2">No page visit data available.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* User Sign-ups Chart (Placeholder for future implementation) */}
        <Card className="col-span-1 md:col-span-2 lg:col-span-3 bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>User Sign-ups</CardTitle>
            <CardDescription>Overview of new user registrations over time.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] flex items-center justify-center text-muted-foreground">
              <LineChart className="h-16 w-16" />
              <p className="ml-2">Chart data coming soon...</p>
            </div>
          </CardContent>
        </Card>

        {/* Top Content Chart (Placeholder for future implementation) */}
        <Card className="col-span-1 md:col-span-2 lg:col-span-3 bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>Top Viewed Content</CardTitle>
            <CardDescription>Most popular blog posts and resources.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] flex items-center justify-center text-muted-foreground">
              <BarChart className="h-16 w-16" />
              <p className="ml-2">Chart data coming soon...</p>
            </div>
          </CardContent>
        </Card>

        {/* Top Clicked Elements */}
        <Card className="col-span-1 md:col-span-2 lg:col-span-3 bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>Top Clicked Elements</CardTitle>
            <CardDescription>Most frequently clicked labels in recent events.</CardDescription>
          </CardHeader>
          <CardContent>
            {topClicked.length === 0 ? (
              <p className="text-xs text-muted-foreground">No click data yet.</p>
            ) : (
              <ul className="text-sm grid grid-cols-1 md:grid-cols-2 gap-2">
                {topClicked.map((item) => (
                  <li key={item.label} className="flex justify-between">
                    <span className="truncate max-w-[70%]">{item.label}</span>
                    <span className="text-muted-foreground">{item.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Clicks Trend (Last 7 days) */}
        <Card className="col-span-1 md:col-span-2 lg:col-span-3 bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>Clicks Trend</CardTitle>
            <CardDescription>Last 7 days of click activity.</CardDescription>
          </CardHeader>
          <CardContent>
            {clicksByDay.length === 0 ? (
              <p className="text-xs text-muted-foreground">No click trend data yet.</p>
            ) : (
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsLineChart data={clicksByDay}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="count" stroke="#82ca9d" />
                  </RechartsLineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Engagement Summary */}
        <Card className="col-span-1 md:col-span-2 lg:col-span-3 bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>Engagement Summary</CardTitle>
            <CardDescription>Average time on page and scroll depth.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-xl font-bold">{Math.round(avgTimeOnPageMs / 1000)}s</div>
                <p className="text-xs text-muted-foreground">Avg time on page</p>
              </div>
              <div>
                <div className="text-xl font-bold">{avgScrollDepth}%</div>
                <p className="text-xs text-muted-foreground">Avg scroll depth</p>
              </div>
              <div>
                <div className="text-xl font-bold">{recentEvents.filter(e => e.type === 'click').length}</div>
                <p className="text-xs text-muted-foreground">Recent clicks sampled</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent Events (sample of latest 10) */}
        <Card className="col-span-1 md:col-span-2 lg:col-span-3 bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>Recent Events</CardTitle>
            <CardDescription>Latest interactions for diagnostics (showing 10).</CardDescription>
          </CardHeader>
          <CardContent>
            {recentEvents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No recent clicks to display.</p>
            ) : (
              <div className="space-y-2 text-xs">
                {recentEvents.slice(0, 10).map((e, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span className="truncate max-w-[65%]">[{e.type}] {e.label || e.targetId || 'unknown'}</span>
                    <span className="text-muted-foreground truncate max-w-[35%]">{e.path || '/'}</span>
                  </div>
                ))}
                <p className="text-muted-foreground mt-2">Showing 10 of {recentEvents.length} recent events.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
}
