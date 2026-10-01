"use client";

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getRoleDisplayName } from '@/lib/roles';
import { cn, formatDate } from '@/lib/utils';
import { Users, Calendar, UserCheck, Clock } from 'lucide-react';

interface Position {
  id: string;
  role: string;
  userId: string;
  startDate: Date;
  endDate: Date | null;
  appointedBy: string;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: {
    roleDisplayName: string;
    userDisplayName: string;
    appointedByDisplayName: string;
  };
}

interface PositionGroup {
  role: string;
  displayName: string;
  positions: Position[];
  currentHolder?: Position;
}

export default function RoleHistoryTimelineSection() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  // Fetch positions from our new API
  useEffect(() => {
    const fetchPositions = async () => {
      try {
        setLoading(true);
        setError('');
        
        const res = await fetch('/api/positions?limit=200');
        
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to fetch leadership history');
        }

        const data = await res.json();
        setPositions(data.positions || []);
      } catch (err: any) {
        console.error('Error fetching leadership history:', err);
        setError(err.message || 'Failed to load leadership history');
      } finally {
        setLoading(false);
      }
    };

    fetchPositions();
  }, []);

  // Group positions by role using the existing hierarchy logic
  const positionGroups: PositionGroup[] = positions.reduce((acc, position) => {
    if (!acc.find(g => g.role === position.role)) {
      acc.push({
        role: position.role,
        displayName: getRoleDisplayName(position.role as any) || position.role,
        positions: [],
        currentHolder: undefined
      });
    }
    
    const group = acc.find(g => g.role === position.role)!;
    group.positions.push(position);
    
    // Track current holder (no end date)
    if (!position.endDate) {
      group.currentHolder = position;
    }
    
    return acc;
  }, [] as PositionGroup[]);

  // Sort positions within each group by start date (newest first)
  positionGroups.forEach(group => {
    group.positions.sort((a, b) => 
      new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
    );
  });

  // Sort groups by hierarchy (presidents first, etc.)
  const roleHierarchy = {
    'president_national': 1,
    'president_chapter': 2,
    'vice_president': 3,
    'general_secretary': 4,
    'projects_director': 5,
    'marketing_head': 6,
    'hr_director': 7,
    'treasurer': 8,
    'advisor': 9,
    'chair_projects': 10,
    'chair_marketing': 11,
    'chair_outreach': 12,
    'chair_design': 13,
    'chair_alumni': 14,
    'chair_events': 15,
    'chair_recruitment': 16,
    'chair_ethics': 17,
    'chair_sponsorship': 18,
  };

  positionGroups.sort((a, b) => {
    const aPriority = roleHierarchy[a.role as keyof typeof roleHierarchy] || 999;
    const bPriority = roleHierarchy[b.role as keyof typeof roleHierarchy] || 999;
    return aPriority - bPriority;
  });

  return (
    <section id="role-history-timeline" className="py-16">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-2 rounded-full text-sm font-medium mb-4">
            <Users className="h-4 w-4" />
            Leadership Excellence
          </div>
          <h2 className="text-3xl md:text-4xl font-bold mb-4">Current Leadership</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground">
            Meet the dedicated individuals currently steering SEDS Pakistan toward aerospace excellence and student development.
          </p>
        </div>

        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1,2,3,4,5,6].map(i => (
              <Card key={i} className="bg-card/60 animate-pulse border-border">
                <CardHeader>
                  <div className="flex items-center gap-3 mb-2">
                    <div className="h-10 w-10 bg-muted rounded-full" />
                    <div className="h-4 w-32 bg-muted rounded" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 w-40 bg-muted/80 rounded" />
                    <div className="h-3 w-36 bg-muted/80 rounded" />
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        )}

        {error && (
          <div className="text-center py-8">
            <div className="text-destructive mb-4 flex items-center justify-center gap-2">
              <Clock className="h-4 w-4" />
              {error}
            </div>
            <p className="text-sm text-muted-foreground">
              Leadership positions will be displayed here once they are recorded by administrators.
            </p>
          </div>
        )}

        {!loading && !error && positionGroups.length === 0 && (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-6 bg-primary/10 rounded-full flex items-center justify-center">
              <Users className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Leadership Information Coming Soon</h3>
            <p className="text-muted-foreground max-w-md mx-auto">
              Current leadership positions will be displayed here once they are added by administrators. 
              This ensures our organizational information stays accurate and up-to-date.
            </p>
          </div>
        )}

        {!loading && !error && positionGroups.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {positionGroups.map((group) => {
              const current = group.currentHolder;
              const hasHistory = group.positions.length > 1;
              
              return (
                <Card key={group.role} className="bg-card/80 border-border hover:shadow-md transition-shadow">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <span>{group.displayName}</span>
                      {current && (
                        <Badge className="bg-green-100 text-green-800 border-green-200 ml-auto">
                          <UserCheck className="h-3 w-3 mr-1" />
                          Current
                        </Badge>
                      )}
                    </CardTitle>
                    
                    {current ? (
                      <CardDescription className="space-y-2">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
                            <span className="text-sm font-medium text-primary">
                              {(current.metadata?.userDisplayName || current.userId)
                                .split(' ')
                                .map(n => n[0])
                                .join('')
                                .toUpperCase()
                              }
                            </span>
                          </div>
                          <div className="flex-1">
                            <div className="font-medium">
                              {current.metadata?.userDisplayName || current.userId}
                            </div>
                            <div className="flex items-center gap-1 text-sm text-muted-foreground">
                              <Calendar className="h-3 w-3" />
                              <span>
                                {formatDate(new Date(current.startDate))} — Present
                              </span>
                            </div>
                          </div>
                        </div>
                        
                        {hasHistory && (
                          <div className="pt-2 border-t border-border">
                            <div className="text-xs text-muted-foreground mb-1">
                              Previous holders ({group.positions.length - 1})
                            </div>
                            <div className="space-y-1">
                              {group.positions
                                .filter(p => p.id !== current.id)
                                .slice(0, 2)
                                .map((prev) => (
                                  <div key={prev.id} className="text-xs text-muted-foreground">
                                    {prev.metadata?.userDisplayName || prev.userId} 
                                    <span className="ml-1">
                                      ({formatDate(new Date(prev.startDate))} 
                                      {prev.endDate ? ` — ${formatDate(new Date(prev.endDate))}` : ''})
                                    </span>
                                  </div>
                                ))}
                              {group.positions.length > 3 && (
                                <div className="text-xs text-muted-foreground italic">
                                  +{group.positions.length - 3} more...
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </CardDescription>
                    ) : (
                      <CardDescription>
                        <div className="text-center py-4">
                          <div className="text-sm text-muted-foreground mb-2">
                            No current holder
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {group.positions.length > 0 
                              ? `Previous: ${group.positions.length} holder${group.positions.length > 1 ? 's' : ''}`
                              : 'No historical data'
                            }
                          </div>
                        </div>
                      </CardDescription>
                    )}
                  </CardHeader>
                  
                  {current?.notes && (
                    <CardContent className="pt-0">
                      <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
                        <strong>Note:</strong> {current.notes}
                      </div>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {positionGroups.length > 0 && (
          <div className="text-center mt-12">
            <p className="text-sm text-muted-foreground mb-4">
              Want to see the complete leadership history?
            </p>
            <a 
              href="/leadership-history" 
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
            >
              <Clock className="h-4 w-4" />
              View Complete Timeline
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
