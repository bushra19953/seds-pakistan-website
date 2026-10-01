'use client';

import { useState, useEffect } from 'react';
import { MapPin, Calendar, Award, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface AuthorProfile {
  name: string;
  title: string;
  avatar?: string;
  location: string;
  achievements: string[];
  credentials: string[];
}

interface AuthorBylineProps {
  authorProfile?: AuthorProfile;
  publishDate?: string;
  className?: string;
}

export function AuthorByline({
  authorProfile,
  publishDate = "March 15, 2024",
  className = ""
}: AuthorBylineProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  // Default author data if none provided
  const defaultAuthor: AuthorProfile = {
    name: "Dr. Sarah Chen",
    title: "Senior Aerospace Engineer",
    avatar: "/api/placeholder/80/80",
    location: "NASA Johnson Space Center, Houston",
    achievements: [
      "Led Mars rover mission design team",
      "Published 50+ peer-reviewed papers",
      "NASA Excellence Award recipient",
      "International Space Station consultant"
    ],
    credentials: [
      "Ph.D. Aerospace Engineering, MIT",
      "NASA Mission Specialist Certification",
      "Professional Engineer (PE) License",
      "IEEE Senior Member"
    ]
  };

  const author = authorProfile || defaultAuthor;

  // Default social links
  const socialLinks = {
    linkedin: "https://linkedin.com/in/sarahchen",
    researchGate: "https://researchgate.net/profile/Sarah-Chen",
    nasa: "https://nasa.gov/people/sarah-chen"
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const formatDate = (dateString: string) => {
    if (!hasMounted) return "";
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch {
      return dateString;
    }
  };

  return (
    <div className={`bg-slate-900/50 border border-slate-800 backdrop-blur-md rounded-lg p-6 ${className}`}>
      <div className="flex items-start gap-4">
        <Avatar className="h-16 w-16 border-2 border-blue-500/50">
          <AvatarImage src={author.avatar} alt={author.name} />
          <AvatarFallback className="bg-slate-800 text-blue-400 font-semibold">
            {getInitials(author.name)}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-lg text-slate-100">{author.name}</h3>
            <Badge variant="secondary" className="bg-blue-900/40 text-blue-300 text-xs border border-blue-500/20">
              Verified Author
            </Badge>
          </div>

          <p className="text-slate-400 font-medium mb-2">{author.title}</p>

          <div className="flex items-center gap-4 text-sm text-slate-500 mb-3">
            <div className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              <span>{formatDate(publishDate)}</span>
            </div>
            <div className="flex items-center gap-1">
              <MapPin className="h-4 w-4" />
              <span>{author.location}</span>
            </div>
          </div>

          {/* Credentials */}
          <div className="flex flex-wrap gap-2 mb-3">
            {author.credentials.map((credential, index) => (
              <Badge
                key={index}
                variant="outline"
                className="text-xs bg-slate-800/50 border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                {credential}
              </Badge>
            ))}
          </div>

          {/* Expandable achievements section */}
          <div className="space-y-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="h-auto p-0 text-blue-600 hover:text-blue-700 font-medium"
            >
              <span className="mr-1">
                {isExpanded ? 'Hide' : 'Show'} achievements
              </span>
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>

            {isExpanded && (
              <div className="space-y-3 pt-2 border-t border-slate-800">
                <div>
                  <h4 className="font-medium text-slate-300 mb-2 flex items-center gap-1">
                    <Award className="h-4 w-4 text-blue-400" />
                    Key Achievements
                  </h4>
                  <ul className="space-y-1">
                    {author.achievements.map((achievement, index) => (
                      <li key={index} className="text-sm text-slate-400 flex items-start gap-2">
                        <span className="text-blue-500 mt-1">•</span>
                        {achievement}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="pt-2 flex gap-2">
                  <Button variant="outline" size="sm" className="text-xs">
                    <ExternalLink className="h-3 w-3 mr-1" />
                    LinkedIn
                  </Button>
                  <Button variant="outline" size="sm" className="text-xs">
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Research Profile
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}