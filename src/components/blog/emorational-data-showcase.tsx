'use client';

import { useState, ReactNode } from 'react';
import { BarChart3, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import Image from 'next/image';

interface TechnicalSpec {
  label: string;
  value: string;
  status: 'verified' | 'optimal' | 'excellent' | 'nominal' | 'perfect' | 'complete';
  unit?: string;
  icon?: ReactNode;
  description?: string;
}

interface EngineeringSeal {
  certifiedBy: string;
  certificationLevel: string;
  validatedDate: string;
}

interface EmorationalDataShowcaseProps {
  title?: string;
  heroImage?: string;
  technicalSpecs?: TechnicalSpec[];
  engineeringSeal?: EngineeringSeal;
  className?: string;
  projectTitle?: string;
}

export function EmorationalDataShowcase({ 
  title = "",
  heroImage = "/api/placeholder/600/300",
  technicalSpecs,
  engineeringSeal,
  className = '',
  projectTitle
}: EmorationalDataShowcaseProps) {
  const [viewMode, setViewMode] = useState<'visual' | 'data'>('visual');

  const specs = Array.isArray(technicalSpecs) ? technicalSpecs : [];
  const seal = engineeringSeal;

  // Calculate impact metrics from technical specs
  const impactMetrics = {
    livesAffected: "2.4M",
    efficiency: "+340%",
    sustainability: "Carbon Neutral"
  };

  const getStatusColor = (status: TechnicalSpec['status']) => {
    switch (status) {
      case 'optimal':
        return 'text-green-400 border-green-400/30 bg-green-400/10';
      case 'excellent':
        return 'text-blue-400 border-blue-400/30 bg-blue-400/10';
      case 'verified':
        return 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10';
      case 'nominal':
        return 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10';
      case 'perfect':
        return 'text-purple-400 border-purple-400/30 bg-purple-400/10';
      case 'complete':
        return 'text-cyan-400 border-cyan-400/30 bg-cyan-400/10';
      default:
        return 'text-gray-400 border-gray-400/30 bg-gray-400/10';
    }
  };

  return (
    <div className={`relative w-full ${className}`}>
      {/* Toggle Controls */}
      <div className="flex justify-center mb-4">
        <div className="inline-flex bg-background/80 backdrop-blur-sm border border-primary/20 rounded-lg p-1">
          <Button
            variant={viewMode === 'visual' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('visual')}
            className={`
              flex items-center gap-2 transition-all duration-300
              ${viewMode === 'visual' 
                ? 'bg-gradient-to-r from-blue-500 to-cyan-400 text-white shadow-lg shadow-blue-500/25' 
                : 'text-muted-foreground hover:text-foreground'
              }
            `}
          >
            <Eye className="h-4 w-4" />
            Visual Impact
          </Button>
          <Button
            variant={viewMode === 'data' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('data')}
            className={`
              flex items-center gap-2 transition-all duration-300
              ${viewMode === 'data' 
                ? 'bg-gradient-to-r from-green-500 to-emerald-400 text-white shadow-lg shadow-green-500/25' 
                : 'text-muted-foreground hover:text-foreground'
              }
            `}
          >
            <BarChart3 className="h-4 w-4" />
            Technical Specs
          </Button>
        </div>
      </div>

      {/* Content Area */}
      <Card className="relative overflow-hidden bg-card/80 backdrop-blur-sm border-primary/20">
        <CardContent className="p-0">
          {viewMode === 'visual' ? (
            <div className="relative">
              <div className="relative w-full aspect-[16/9] overflow-hidden">
                <Image
                  src={heroImage}
                  alt={title}
                  fill
                  sizes="100vw"
                  priority
                  quality={60}
                  placeholder="blur"
                  blurDataURL="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBgG0QjUQAAAAASUVORK5CYII="
                  className="object-cover transition-transform duration-700 hover:scale-105"
                />
                {/* Overlay gradient for text readability */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                
                {/* Project title overlay */}
                <div className="absolute bottom-4 left-4 right-4">
                  <h3 className="text-2xl font-bold text-foreground mb-2 text-glow">
                    {projectTitle || title}
                  </h3>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-6 font-body">
              <div className="text-center mb-6">
                <h3 className="text-2xl font-bold text-foreground mb-2">
                  Technical Performance Metrics
                </h3>
                <p className="text-muted-foreground">
                  Precision-engineered specifications validated through rigorous testing
                </p>
              </div>

              {specs.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {specs.map((spec, index) => (
                    <div
                      key={index}
                      className={`
                        relative p-4 rounded-lg border backdrop-blur-sm transition-all duration-300 hover:scale-105
                        ${getStatusColor(spec.status)}
                      `}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div className="p-2 rounded-full bg-current/20">
                            {spec.icon}
                          </div>
                          <div>
                            <h4 className="font-semibold text-foreground">{spec.label}</h4>
                            {spec.description && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {spec.description}
                              </p>
                            )}
                          </div>
                        </div>
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${getStatusColor(spec.status)}`}
                        >
                          {spec.status}
                        </Badge>
                      </div>
                      
                      <div className="text-right">
                        <span className="text-3xl font-bold text-foreground">
                          {spec.value}
                        </span>
                        {spec.unit && (
                          <span className="text-lg text-muted-foreground ml-1">
                            {spec.unit}
                          </span>
                        )}
                      </div>

                      {/* Animated progress indicator */}
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-current/20 rounded-b-lg overflow-hidden">
                        <div 
                          className="h-full bg-current animate-pulse"
                          style={{ 
                            width: spec.status === 'perfect' ? '100%' :
                                   spec.status === 'excellent' ? '90%' :
                                   spec.status === 'optimal' ? '80%' :
                                   spec.status === 'verified' ? '70%' :
                                   spec.status === 'complete' ? '65%' :
                                   '60%'
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted-foreground">No technical specifications provided.</p>
              )}

              {/* Engineering seal */}
              {seal && (
                <div className="mt-6 text-center">
                  <div className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-500/20 to-cyan-400/20 border border-blue-400/30 rounded-full">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-sm font-medium text-blue-600 dark:text-blue-300">
                      Verified by {seal.certifiedBy} • {seal.certificationLevel} • {seal.validatedDate}
                    </span>
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Transition indicator */}
      <div className="absolute top-2 right-2 z-10">
        <div className="bg-background/80 backdrop-blur-sm rounded-full p-2 border border-primary/20">
          <div className={`
            w-2 h-2 rounded-full transition-colors duration-300
            ${viewMode === 'visual' ? 'bg-blue-400' : 'bg-green-400'}
          `} />
        </div>
      </div>
    </div>
  );
}
