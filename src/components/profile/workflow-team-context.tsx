'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageSquare, Mail, Phone, Info, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import Link from 'next/link';

interface TeamMember {
  uid: string;
  name: string;
  photoURL?: string;
  role?: string;
  position?: string;
  status: string;
  isCurrentStep?: boolean;
  whatsapp?: string;
  email?: string;
  sequenceIndex: number;
}

interface WorkflowTeamContextProps {
  members: TeamMember[];
  currentUserId: string;
}

export function WorkflowTeamContext({ members, currentUserId }: WorkflowTeamContextProps) {
  // Sort members by sequence index
  const sortedMembers = [...members].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-accent text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground flex items-center gap-2">
          <Info className="h-3 w-3 text-primary-text" /> Mission Squad Context
        </h4>
        <Badge variant="outline" className="text-[9px] font-code border-border text-muted-foreground">
          {members.length} UNITS ASSIGNED
        </Badge>
      </div>

      <div className="relative flex items-center justify-between gap-2 py-4 px-2 overflow-x-auto no-scrollbar">
        {/* Connection Line */}
        <div className="absolute top-1/2 left-8 right-8 h-px bg-border -translate-y-1/2 z-0" />

        {sortedMembers.map((member, idx) => {
          const isYou = member.uid === currentUserId;
          const isDone = member.status === 'completed';
          const isActive = member.isCurrentStep;
          const isPending = !isDone && !isActive;

          return (
            <div key={member.uid} className="relative z-10 flex flex-col items-center gap-3 min-w-[80px]">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="relative">
                      <div className={`
                        h-12 w-12 rounded-lg border p-0.5 transition-all duration-500
                        ${isActive ? 'border-primary scale-110 bg-primary/10' : 
                          isDone ? 'border-emerald-500/60 bg-emerald-500/10' : 
                          'border-border bg-card'}
                      `}>
                        <Avatar className="h-full w-full rounded-md">
                          <AvatarImage src={member.photoURL} alt={member.name} />
                          <AvatarFallback className="bg-muted text-[10px] font-accent font-semibold">
                            {member.name.substring(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      </div>

                      {/* Status Icon Overlay */}
                      <div className={`
                        absolute -bottom-1 -right-1 h-5 w-5 rounded-full border-2 border-card flex items-center justify-center
                        ${isDone ? 'bg-emerald-500' : isActive ? 'bg-primary' : 'bg-muted'}
                      `}>
                        {isDone ? <CheckCircle2 className="h-3 w-3 text-primary-foreground" /> : 
                         isActive ? <Clock className="h-3 w-3 text-primary-foreground animate-pulse" /> : 
                         <AlertCircle className="h-3 w-3 text-muted-foreground" />}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="bg-card border-border text-foreground p-3 space-y-2">
                    <div className="space-y-0.5">
                      <p className="font-accent text-[11px] font-semibold uppercase tracking-wider">{member.name} {isYou && '(YOU)'}</p>
                      <p className="text-[10px] text-muted-foreground">{member.role || member.position || 'Team Member'}</p>
                    </div>
                    <div className="pt-2 border-t border-border flex gap-2">
                      {member.whatsapp && (
                        <a 
                          href={`https://wa.me/${member.whatsapp.replace(/[^0-9]/g, '')}`} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500 hover:text-black transition-colors"
                        >
                          <Phone className="h-3.5 w-3.5" />
                        </a>
                      )}
                      {member.email && (
                        <a 
                          href={`mailto:${member.email}`}
                          className="p-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-black transition-colors"
                        >
                          <Mail className="h-3.5 w-3.5" />
                        </a>
                      )}
                      <Link
                        href={`/profile/unified?uid=${member.uid}`}
                        prefetch={false}
                        className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground transition-colors"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <div className="text-center space-y-0.5">
                <p className={`font-accent text-[9px] font-semibold uppercase tracking-[0.15em] truncate max-w-[70px] ${isActive ? 'text-primary-text' : 'text-muted-foreground'}`}>
                  {isYou ? 'YOU' : member.name.split(' ')[0]}
                </p>
                <p className="text-[8px] font-code text-muted-foreground/60 uppercase tracking-tighter">
                  STEP {member.sequenceIndex + 1}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
