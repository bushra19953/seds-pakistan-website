"use client";

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getRoleDisplayName } from '@/lib/roles';
import { format } from 'date-fns';
import { safeFormat } from '@/lib/date-utils';
import { 
  Users, 
  Clock, 
  Calendar,
  UserCheck,
  Trophy,
  Building,
  User,
  ChevronRight,
  ExternalLink,
  MapPin
} from 'lucide-react';
import StarryBackground from '@/components/starry-background';

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

interface HistoricalPosition {
  group: PositionGroup;
  position: Position;
}

export default function LeadershipHistoryPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [activeTab, setActiveTab] = useState('current');

  // Fetch positions (public endpoint)
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

  useEffect(() => {
    fetchPositions();
  }, []);

  // Group positions by role
  const positionGroups: PositionGroup[] = positions.reduce((acc, position) => {
    if (!acc.find(g => g.role === position.role)) {
      acc.push({
        role: position.role,
        displayName: getRoleDisplayName(position.role as any),
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

  // Current leaders only
  const currentLeaders = positionGroups
    .filter(group => group.currentHolder)
    .map(group => ({
      ...group,
      position: group.currentHolder!
    }));

  // Historical timeline
  const historicalPositions: HistoricalPosition[] = positionGroups.flatMap(group => 
    group.positions.map(position => ({
      group: group,
      position: position
    }))
  ).sort((a, b) => 
    new Date(b.position.startDate).getTime() - new Date(a.position.startDate).getTime()
  );

  // Leadership by university/chapter (if we had chapter data)
  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  const PositionCard = ({ group, position, isCurrent = false }: { 
    group: PositionGroup; 
    position: Position; 
    isCurrent?: boolean; 
  }) => {
    const userName = position.metadata?.userDisplayName || position.userId;
    const initials = getInitials(userName);
    
    return (
      <Card className={`${isCurrent ? 'border-green-200 bg-green-50' : 'hover:shadow-md transition-shadow'}`}>
        <CardContent className="p-4">
          <div className="flex items-start gap-4">
            <Avatar className="h-12 w-12">
              <AvatarFallback className="bg-primary text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-semibold text-lg truncate">{userName}</h3>
                {isCurrent && (
                  <Badge className="bg-green-100 text-green-800 border-green-200">
                    <UserCheck className="h-3 w-3 mr-1" />
                    Current
                  </Badge>
                )}
              </div>
              
              <p className="text-muted-foreground mb-2">{group.displayName}</p>
              
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  <span>
                    {safeFormat(position.startDate, 'MMM yyyy')} — 
                    {position.endDate 
                      ? ` ${safeFormat(position.endDate, 'MMM yyyy')}` 
                      : ' Present'
                    }
                  </span>
                </div>
                
                {position.notes && (
                  <div className="flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    <span className="truncate max-w-[200px]">
                      {position.notes}
                    </span>
                  </div>
                )}
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
        <div className="container mx-auto px-4 py-16">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            <p className="mt-4 text-muted-foreground">Loading leadership history...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1">
          <div className="container mx-auto px-4 py-16">
            <Card className="bg-card/80 backdrop-blur-sm border-accent/20 max-w-md mx-auto">
              <CardHeader>
                <CardTitle className="text-destructive">Unable to Load Leadership History</CardTitle>
                <CardDescription>{error}</CardDescription>
              </CardHeader>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1">
          <div className="container mx-auto px-4 py-16">
            <div className="text-center max-w-2xl mx-auto">
              <div className="w-24 h-24 mx-auto mb-8 bg-primary/10 rounded-full flex items-center justify-center">
                <Users className="h-12 w-12 text-primary" />
              </div>
              <h1 className="text-4xl font-bold text-glow mb-4">Leadership History</h1>
              <p className="text-xl text-muted-foreground mb-8">
                Leadership history will be displayed here once positions are recorded.
              </p>
              <p className="text-sm text-muted-foreground">
                Check back later to see our organization&apos;s leadership timeline.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1">
        {/* Hero Section */}
        <div className="relative overflow-hidden">
          <div className="relative container mx-auto px-4 py-16">
            <div className="text-center max-w-4xl mx-auto">
              <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-2 rounded-full text-sm font-medium mb-6">
                <Trophy className="h-4 w-4" />
                Leadership Excellence
              </div>
              <h1 className="text-5xl md:text-6xl font-bold text-glow mb-6">
                Our Leadership Journey
              </h1>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
                Track the remarkable individuals who have led SEDS Pakistan through innovation, 
                growth, and aerospace excellence. Our leadership history represents decades of 
                commitment to space exploration and student development.
              </p>
            </div>
          </div>
        </div>

      {/* Stats Section */}
        <div className="container mx-auto px-4 -mt-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-12">
          <Card className="text-center bg-card/80 backdrop-blur-sm border-border">
            <CardContent className="p-6">
              <div className="text-3xl font-bold text-primary mb-2">{currentLeaders.length}</div>
              <div className="text-sm text-muted-foreground">Current Leaders</div>
            </CardContent>
          </Card>
          <Card className="text-center bg-card/80 backdrop-blur-sm border-border">
            <CardContent className="p-6">
              <div className="text-3xl font-bold text-primary mb-2">{positionGroups.length}</div>
              <div className="text-sm text-muted-foreground">Leadership Roles</div>
            </CardContent>
          </Card>
          <Card className="text-center bg-card/80 backdrop-blur-sm border-border">
            <CardContent className="p-6">
              <div className="text-3xl font-bold text-primary mb-2">{positions.length}</div>
              <div className="text-sm text-muted-foreground">Total Positions</div>
            </CardContent>
          </Card>
          <Card className="text-center bg-card/80 backdrop-blur-sm border-border">
            <CardContent className="p-6">
              <div className="text-3xl font-bold text-green-600 mb-2">
                {(() => {
                  const years = new Set(positions.map(p => new Date(p.startDate).getFullYear()));
                  return years.size;
                })()}
              </div>
              <div className="text-sm text-muted-foreground">Years of History</div>
            </CardContent>
          </Card>
          </div>
        </div>

      {/* Main Content */}
        <div className="container mx-auto px-4 pb-16">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <div className="flex justify-center mb-8">
              <TabsList className="grid grid-cols-2 w-[400px]">
              <TabsTrigger value="current" className="flex items-center gap-2">
                <UserCheck className="h-4 w-4" />
                Current Leadership
              </TabsTrigger>
              <TabsTrigger value="history" className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Complete History
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Current Leadership Tab */}
          <TabsContent value="current" className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold mb-2">Current Leadership</h2>
              <p className="text-muted-foreground">
                Meet the dedicated leaders currently steering SEDS Pakistan toward new heights
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {currentLeaders.map((group) => (
                <PositionCard
                  key={group.role}
                  group={group}
                  position={group.position}
                  isCurrent={true}
                />
              ))}
            </div>
          </TabsContent>

          {/* Complete History Tab */}
          <TabsContent value="history" className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold mb-2">Complete Leadership Timeline</h2>
              <p className="text-muted-foreground">
                Explore the complete history of leadership transitions and organizational growth
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {historicalPositions.map(({ group, position }) => (
                <PositionCard
                  key={`${group.role}-${position.id}`}
                  group={group}
                  position={position}
                  isCurrent={!position.endDate}
                />
              ))}
            </div>
          </TabsContent>
        </Tabs>

        {/* About Section */}
        <Card className="mt-16 bg-card/80 backdrop-blur-sm border-accent/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building className="h-5 w-5" />
              About SEDS Pakistan Leadership
            </CardTitle>
            <CardDescription>
              Our leadership structure reflects our commitment to aerospace excellence and student development
            </CardDescription>
          </CardHeader>
          <CardContent className="prose max-w-none">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-yellow-500" />
                  Excellence in Leadership
                </h4>
                <p className="text-sm text-muted-foreground">
                  Our leadership team represents the best and brightest minds in Pakistan&apos;s aerospace community. 
                  Each leader brings unique expertise in rocketry, satellite technology, project management, and space research.
                </p>
              </div>
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <User className="h-4 w-4 text-blue-500" />
                  Continuous Growth
                </h4>
                <p className="text-sm text-muted-foreground">
                  Leadership positions provide valuable experience for personal and professional development. 
                  Our alumni have gone on to successful careers in aerospace engineering, research institutions, and space agencies worldwide.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        </div>
      </main>
    </div>
  );
}
