'use client';

import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { LayoutDashboard, CheckCircle2, Target, TrendingUp } from 'lucide-react';
import { Capability } from '../types';

export function MatrixMetricsRow({ skills }: { skills: Capability[] }) {
  const metrics = useMemo(() => {
    const total = skills.length;
    const active = skills.filter((s) => s.status === 'active').length;
    const featured = skills.filter((s) => s.isFeatured).length;
    const mostAssigned = [...skills].sort((a, b) => (b.assignedUserCount || 0) - (a.assignedUserCount || 0))[0];
    
    return { total, active, featured, mostAssigned };
  }, [skills]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <MetricCard 
        title="Total Capabilities" 
        value={metrics.total} 
        icon={<LayoutDashboard className="h-5 w-5 text-blue-500" />} 
      />
      <MetricCard 
        title="Active & Deployable" 
        value={metrics.active} 
        icon={<CheckCircle2 className="h-5 w-5 text-green-500" />} 
        trend={`${metrics.total > 0 ? Math.round((metrics.active / metrics.total) * 100) : 0}% of total`} 
      />
      <MetricCard 
        title="Featured Skills" 
        value={metrics.featured} 
        icon={<Target className="h-5 w-5 text-amber-500" />} 
      />
      <Card className="bg-gradient-to-br from-primary/10 to-transparent border-primary/20 shadow-sm overflow-hidden relative">
        <div className="absolute right-[-10px] top-[-10px] opacity-10"><TrendingUp className="h-24 w-24" /></div>
        <CardContent className="p-4 relative z-10">
          <p className="text-xs font-bold uppercase text-primary/80 tracking-wider mb-1">Highest Adoption</p>
          <div className="text-2xl font-black text-primary truncate">{metrics.mostAssigned?.name || 'N/A'}</div>
          <p className="text-sm font-medium mt-1 text-muted-foreground">{metrics.mostAssigned?.assignedUserCount || 0} Personnel Assigned</p>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ title, value, icon, trend }: { title: string; value: string | number; icon: React.ReactNode; trend?: string }) {
  return (
    <Card className="border-border/50 shadow-sm">
      <CardContent className="p-5">
        <div className="flex justify-between items-start">
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase text-muted-foreground tracking-wider">{title}</p>
            <p className="text-3xl font-black tracking-tight">{value}</p>
          </div>
          <div className="p-2 bg-muted/50 rounded-lg">{icon}</div>
        </div>
        {trend && <p className="text-xs font-medium text-muted-foreground mt-3">{trend}</p>}
      </CardContent>
    </Card>
  );
}
