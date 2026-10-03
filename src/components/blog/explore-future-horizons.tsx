'use client';

import { useState } from 'react';
import { Rocket, Zap, Globe, Brain, Star, ChevronRight, Calendar, Target, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface FutureHorizon {
  id: string;
  title: string;
  description: string;
  timeline: string;
  probability: number;
  impact: 'Low' | 'Medium' | 'High' | 'Revolutionary';
  category: string;
  keyMilestones: string[];
  technologies: string[];
  challenges: string[];
}

interface ExploreFutureHorizonsProps {
  horizons?: FutureHorizon[];
  title?: string;
  className?: string;
}

export function ExploreFutureHorizons({ 
  horizons, 
  title = "Future Horizons",
  className = ""
}: ExploreFutureHorizonsProps) {
  const [selectedHorizon, setSelectedHorizon] = useState(0);

  // Default horizons data if none provided
  const defaultHorizons: FutureHorizon[] = [
    {
      id: '1',
      title: 'Mars Colony Infrastructure',
      description: 'Developing sustainable life support systems and habitat modules for permanent Mars settlement.',
      timeline: '2030-2035',
      probability: 75,
      impact: 'Revolutionary',
      category: 'Exploration',
      keyMilestones: [
        'Habitat module prototyping',
        'Life support system testing',
        'Resource utilization trials',
        'Colony establishment'
      ],
      technologies: ['Closed-loop life support', 'In-situ resource utilization', 'Radiation shielding'],
      challenges: ['Radiation exposure', 'Resource scarcity', 'Psychological isolation']
    },
    {
      id: '2',
      title: 'Quantum Propulsion Systems',
      description: 'Revolutionary propulsion technology enabling faster interplanetary travel.',
      timeline: '2028-2032',
      probability: 45,
      impact: 'Revolutionary',
      category: 'Technology',
      keyMilestones: [
        'Quantum field manipulation',
        'Prototype engine testing',
        'Efficiency optimization',
        'Commercial deployment'
      ],
      technologies: ['Quantum field theory', 'Exotic matter manipulation', 'Energy containment'],
      challenges: ['Energy requirements', 'Field stability', 'Safety protocols']
    },
    {
      id: '3',
      title: 'Asteroid Mining Operations',
      description: 'Autonomous mining systems for rare earth elements and space-based manufacturing.',
      timeline: '2026-2030',
      probability: 85,
      impact: 'High',
      category: 'Industry',
      keyMilestones: [
        'Asteroid identification',
        'Mining robot deployment',
        'Resource extraction',
        'Space-based refining'
      ],
      technologies: ['Autonomous robotics', 'Space-based manufacturing', 'Resource processing'],
      challenges: ['Navigation precision', 'Equipment durability', 'Economic viability']
    }
  ];

  const futureHorizons = horizons || defaultHorizons;
  const currentHorizon = futureHorizons[selectedHorizon];

  const getImpactColor = (impact: string) => {
    switch (impact) {
      case 'Revolutionary':
        return 'bg-red-500/20 text-red-300 border-red-400/30';
      case 'High':
        return 'bg-orange-500/20 text-orange-300 border-orange-400/30';
      case 'Medium':
        return 'bg-yellow-500/20 text-yellow-300 border-yellow-400/30';
      case 'Low':
        return 'bg-green-500/20 text-green-300 border-green-400/30';
      default:
        return 'bg-gray-500/20 text-gray-300 border-gray-400/30';
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category.toLowerCase()) {
      case 'exploration':
        return <Globe className="h-4 w-4" />;
      case 'technology':
        return <Zap className="h-4 w-4" />;
      case 'industry':
        return <Target className="h-4 w-4" />;
      default:
        return <Star className="h-4 w-4" />;
    }
  };

  return (
    <Card className={`bg-gradient-to-br from-slate-900/50 to-blue-900/50 border-blue-400/20 ${className}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-white">
          <Rocket className="h-5 w-5 text-blue-400" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Horizon selector */}
        <div className="flex gap-2 overflow-x-auto pb-2">
          {futureHorizons.map((horizon, index) => (
            <Button
              key={horizon.id}
              variant={selectedHorizon === index ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedHorizon(index)}
              className={`whitespace-nowrap ${
                selectedHorizon === index 
                  ? 'bg-blue-600 text-white' 
                  : 'border-blue-400/30 text-blue-300 hover:bg-blue-400/10'
              }`}
            >
              {getCategoryIcon(horizon.category)}
              <span className="ml-1">{horizon.title}</span>
            </Button>
          ))}
        </div>

        {/* Current horizon details */}
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-white">{currentHorizon.title}</h3>
              <p className="text-blue-200">{currentHorizon.description}</p>
              
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-1 text-blue-300">
                  <Calendar className="h-4 w-4" />
                  {currentHorizon.timeline}
                </div>
                <Badge className={getImpactColor(currentHorizon.impact)}>
                  {currentHorizon.impact} Impact
                </Badge>
              </div>
            </div>
          </div>

          {/* Probability indicator */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-blue-300">Success Probability</span>
              <span className="text-white font-medium">{currentHorizon.probability}%</span>
            </div>
            <Progress value={currentHorizon.probability} className="h-2" />
          </div>

          {/* Key milestones */}
          <div className="space-y-2">
            <h4 className="font-medium text-white flex items-center gap-1">
              <Target className="h-4 w-4 text-blue-400" />
              Key Milestones
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {currentHorizon.keyMilestones.map((milestone, index) => (
                <div key={index} className="flex items-center gap-2 text-sm text-blue-200">
                  <ChevronRight className="h-3 w-3 text-blue-400" />
                  {milestone}
                </div>
              ))}
            </div>
          </div>

          {/* Technologies and challenges */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <h4 className="font-medium text-white flex items-center gap-1">
                <Brain className="h-4 w-4 text-green-400" />
                Key Technologies
              </h4>
              <div className="flex flex-wrap gap-1">
                {currentHorizon.technologies.map((tech, index) => (
                  <Badge key={index} variant="outline" className="text-xs border-green-400/30 text-green-300">
                    {tech}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="font-medium text-white flex items-center gap-1">
                <TrendingUp className="h-4 w-4 text-orange-400" />
                Challenges
              </h4>
              <div className="flex flex-wrap gap-1">
                {currentHorizon.challenges.map((challenge, index) => (
                  <Badge key={index} variant="outline" className="text-xs border-orange-400/30 text-orange-300">
                    {challenge}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}