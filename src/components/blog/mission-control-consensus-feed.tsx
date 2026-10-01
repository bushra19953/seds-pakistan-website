'use client';

import { useState, useEffect } from 'react';
import { CheckCircle, Users, Clock, TrendingUp, Award, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ConsensusActivity {
  id: string;
  type: 'validation' | 'recommendation' | 'approval' | 'review';
  user: {
    name: string;
    title: string;
    avatar?: string;
    status: 'faculty' | 'lead' | 'expert' | 'peer';
  };
  action: string;
  target: string;
  timestamp: string;
  priority: 'high' | 'medium' | 'low';
}

interface MissionControlConsensusFeedProps {
  activities?: ConsensusActivity[];
  className?: string;
}

const mockActivities: ConsensusActivity[] = [
  {
    id: '1',
    type: 'validation',
    user: {
      name: 'Dr. Sarah Chen',
      title: 'Faculty Advisor',
      avatar: '/avatars/sarah-chen.jpg',
      status: 'faculty'
    },
    action: 'validated the latest',
    target: 'Structural Analysis Report',
    timestamp: '2 hours ago',
    priority: 'high'
  },
  {
    id: '2',
    type: 'recommendation',
    user: {
      name: 'Alex Rodriguez',
      title: 'Project Lead',
      avatar: '/avatars/alex-rodriguez.jpg',
      status: 'lead'
    },
    action: 'recommended this',
    target: 'Propulsion Design Log',
    timestamp: '4 hours ago',
    priority: 'high'
  },
  {
    id: '3',
    type: 'approval',
    user: {
      name: 'Dr. Michael Park',
      title: 'Systems Engineer',
      avatar: '/avatars/michael-park.jpg',
      status: 'expert'
    },
    action: 'approved the',
    target: 'Flight Test Parameters',
    timestamp: '6 hours ago',
    priority: 'medium'
  },
  {
    id: '4',
    type: 'review',
    user: {
      name: 'Emma Thompson',
      title: 'Avionics Specialist',
      avatar: '/avatars/emma-thompson.jpg',
      status: 'expert'
    },
    action: 'completed review of',
    target: 'Navigation Algorithm',
    timestamp: '8 hours ago',
    priority: 'medium'
  },
  {
    id: '5',
    type: 'validation',
    user: {
      name: 'James Wilson',
      title: 'Peer Reviewer',
      avatar: '/avatars/james-wilson.jpg',
      status: 'peer'
    },
    action: 'validated the',
    target: 'Thermal Analysis Data',
    timestamp: '12 hours ago',
    priority: 'low'
  }
];

export function MissionControlConsensusFeed({
  activities = mockActivities,
  className = ""
}: MissionControlConsensusFeedProps) {
  const [liveActivities, setLiveActivities] = useState(activities);
  const [isLive, setIsLive] = useState(true);

  // Simulate live updates
  useEffect(() => {
    if (!isLive) return;

    const interval = setInterval(() => {
      // Randomly update timestamps to simulate live activity
      setLiveActivities(prev => 
        prev.map(activity => ({
          ...activity,
          timestamp: Math.random() > 0.9 ? 'Just now' : activity.timestamp
        }))
      );
    }, 10000);

    return () => clearInterval(interval);
  }, [isLive]);

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'validation':
        return <CheckCircle className="h-3 w-3" />;
      case 'recommendation':
        return <TrendingUp className="h-3 w-3" />;
      case 'approval':
        return <Award className="h-3 w-3" />;
      case 'review':
        return <Users className="h-3 w-3" />;
      default:
        return <Zap className="h-3 w-3" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'faculty':
        return 'border-purple-400/30 bg-purple-400/10 text-purple-300';
      case 'lead':
        return 'border-blue-400/30 bg-blue-400/10 text-blue-300';
      case 'expert':
        return 'border-green-400/30 bg-green-400/10 text-green-300';
      case 'peer':
        return 'border-yellow-400/30 bg-yellow-400/10 text-yellow-300';
      default:
        return 'border-gray-400/30 bg-gray-400/10 text-gray-300';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high':
        return 'bg-red-500';
      case 'medium':
        return 'bg-yellow-500';
      case 'low':
        return 'bg-green-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <Card className={`bg-card/80 backdrop-blur-sm border-primary/20 ${className}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <div className="relative">
            <Users className="h-5 w-5 text-blue-400" />
            <div className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${isLive ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`} />
          </div>
          Mission Control Consensus
        </CardTitle>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          Live Activity Feed
        </div>
      </CardHeader>
      
      <CardContent className="p-0">
        <ScrollArea className="h-[400px] px-4">
          <div className="space-y-3 pb-4">
            {liveActivities.map((activity, index) => (
              <div
                key={activity.id}
                className="relative flex items-start gap-3 p-3 rounded-lg bg-background/40 border border-primary/10 hover:border-primary/20 transition-all duration-200"
              >
                {/* Priority indicator */}
                <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-lg ${getPriorityColor(activity.priority)}`} />
                
                {/* Avatar */}
                <div className="relative flex-shrink-0">
                  <Avatar className="h-8 w-8 border border-primary/20">
                    <AvatarImage src={activity.user.avatar} alt={activity.user.name} />
                    <AvatarFallback className="text-xs bg-gradient-to-br from-blue-500 to-cyan-400 text-white">
                      {getInitials(activity.user.name)}
                    </AvatarFallback>
                  </Avatar>
                  
                  {/* Activity type icon */}
                  <div className={`
                    absolute -bottom-1 -right-1 w-4 h-4 rounded-full border border-background flex items-center justify-center text-white
                    ${activity.type === 'validation' ? 'bg-green-500' : ''}
                    ${activity.type === 'recommendation' ? 'bg-blue-500' : ''}
                    ${activity.type === 'approval' ? 'bg-purple-500' : ''}
                    ${activity.type === 'review' ? 'bg-yellow-500' : ''}
                  `}>
                    {getActivityIcon(activity.type)}
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex-1">
                      <p className="text-sm text-white">
                        <span className="font-medium">{activity.user.name}</span>
                        <span className="text-muted-foreground"> {activity.action} </span>
                        <span className="font-medium text-blue-300">{activity.target}</span>
                      </p>
                      
                      <div className="flex items-center gap-2 mt-1">
                        <Badge 
                          variant="outline" 
                          className={`text-xs px-1.5 py-0 ${getStatusColor(activity.user.status)}`}
                        >
                          {activity.user.title}
                        </Badge>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {activity.timestamp}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-primary/20 bg-background/20">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              <span>{liveActivities.length} Recent Activities</span>
            </div>
            <div className="flex items-center gap-1 text-green-300">
              <CheckCircle className="h-3 w-3" />
              <span>All Systems Nominal</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}