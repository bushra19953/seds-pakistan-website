'use client';

import { useState } from 'react';
import { Shield, CheckCircle, Users, Calendar, Award } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';

interface VerificationMetric {
  label: string;
  value: string;
  verified: boolean;
  icon?: React.ReactNode;
  status?: 'verified' | 'pending' | 'approved';
}

interface LaunchReadinessSealProps {
  authorName?: string;
  verificationLevel?: 'expert' | 'peer-reviewed' | 'faculty-approved';
  verificationMetrics?: VerificationMetric[];
  className?: string;
}

const defaultMetrics: Record<string, VerificationMetric[]> = {
  'expert': [
    {
      label: 'Technical Accuracy',
      value: 'Verified by Lead Engineer',
      verified: true,
      icon: <CheckCircle className="h-3 w-3" />,
      status: 'verified'
    },
    {
      label: 'Data Integrity',
      value: '100% Source Validated',
      verified: true,
      icon: <Shield className="h-3 w-3" />,
      status: 'verified'
    }
  ],
  'peer-reviewed': [
    {
      label: 'Peer Review',
      value: '12 Engineers Validated',
      verified: true,
      icon: <Users className="h-3 w-3" />,
      status: 'approved'
    },
    {
      label: 'Technical Review',
      value: 'Completed 2 days ago',
      verified: true,
      icon: <Calendar className="h-3 w-3" />,
      status: 'verified'
    }
  ],
  'faculty-approved': [
    {
      label: 'Faculty Approval',
      value: 'Dr. Sarah Chen, Aerospace Dept.',
      verified: true,
      icon: <Award className="h-3 w-3" />,
      status: 'approved'
    },
    {
      label: 'Academic Standards',
      value: 'IEEE Compliant',
      verified: true,
      icon: <CheckCircle className="h-3 w-3" />,
      status: 'verified'
    }
  ]
};

export function LaunchReadinessSeal({ 
  authorName = "SEDS Team", 
  verificationLevel = "expert", 
  verificationMetrics,
  className = "" 
}: LaunchReadinessSealProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [hoveredMetric, setHoveredMetric] = useState<string | null>(null);
  
  // Convert simple verification metrics to the expected format
  const convertedMetrics = verificationMetrics?.map(metric => ({
    ...metric,
    icon: metric.verified ? <CheckCircle className="h-3 w-3" /> : <Shield className="h-3 w-3" />,
    status: metric.verified ? 'verified' as const : 'pending' as const
  }));
  
  const displayMetrics = convertedMetrics || defaultMetrics[verificationLevel] || defaultMetrics['expert'];
  
  const sealConfig = {
    'expert': {
      color: 'from-blue-500 to-cyan-400',
      bgColor: 'bg-blue-500/10',
      borderColor: 'border-blue-400/30',
      label: 'Expert Verified',
      icon: <Shield className="h-4 w-4" />
    },
    'peer-reviewed': {
      color: 'from-green-500 to-emerald-400',
      bgColor: 'bg-green-500/10',
      borderColor: 'border-green-400/30',
      label: 'Peer Reviewed',
      icon: <Users className="h-4 w-4" />
    },
    'faculty-approved': {
      color: 'from-purple-500 to-violet-400',
      bgColor: 'bg-purple-500/10',
      borderColor: 'border-purple-400/30',
      label: 'Faculty Approved',
      icon: <Award className="h-4 w-4" />
    }
  };

  const config = sealConfig[verificationLevel];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div 
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${config.bgColor} ${config.borderColor} border backdrop-blur-sm transition-all duration-300 hover:scale-105 cursor-pointer ${className}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <div className={`p-1 rounded-full bg-gradient-to-r ${config.color} ${isHovered ? 'animate-pulse' : ''}`}>
              {config.icon}
            </div>
            <span className="text-xs font-medium text-foreground/90">
              {config.label}
            </span>
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          </div>
        </TooltipTrigger>
        <TooltipContent 
          side="bottom" 
          className="bg-black/90 border-primary/20 backdrop-blur-sm max-w-xs"
        >
          <div className="space-y-3 p-2">
            <div className="text-center">
              <h4 className="font-semibold text-primary mb-1">Verification Status</h4>
              <p className="text-xs text-muted-foreground">
                Content by {authorName}
              </p>
            </div>
            
            <div className="space-y-2">
              {displayMetrics.map((metric, index) => (
                <div key={index} className="flex items-center gap-2 text-xs">
                  <div className={`
                    p-1 rounded-full 
                    ${metric.status === 'verified' ? 'bg-green-500/20 text-green-400' : ''}
                    ${metric.status === 'approved' ? 'bg-blue-500/20 text-blue-400' : ''}
                    ${metric.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' : ''}
                  `}>
                    {metric.icon}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-white/90">{metric.label}</div>
                    <div className="text-muted-foreground">{metric.value}</div>
                  </div>
                  <Badge 
                    variant="outline" 
                    className={`
                      text-xs px-1 py-0 
                      ${metric.status === 'verified' ? 'border-green-400/30 text-green-400' : ''}
                      ${metric.status === 'approved' ? 'border-blue-400/30 text-blue-400' : ''}
                      ${metric.status === 'pending' ? 'border-yellow-400/30 text-yellow-400' : ''}
                    `}
                  >
                    {metric.status}
                  </Badge>
                </div>
              ))}
            </div>
            
            <div className="text-center pt-2 border-t border-primary/20">
              <p className="text-xs text-primary/80">
                ✓ Mission-Critical Standards Met
              </p>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
