"use client";

import { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { USER_ROLES, ROLE_HIERARCHY } from '@/lib/roles';
import { Check, Star, Users } from 'lucide-react';

const getLevelColor = (role: string) => {
    const level = (ROLE_HIERARCHY as Record<string, number>)[role] || 1;
    if (level >= 10) return { bg: 'bg-blue-500/20', border: 'border-blue-500/50', text: 'text-blue-400', badge: 'bg-blue-500' };
    if (level >= 8) return { bg: 'bg-emerald-500/20', border: 'border-emerald-500/50', text: 'text-emerald-400', badge: 'bg-emerald-500' };
    if (level >= 7) return { bg: 'bg-amber-500/20', border: 'border-amber-500/50', text: 'text-amber-400', badge: 'bg-amber-500' };
    return { bg: 'bg-slate-500/20', border: 'border-slate-500/50', text: 'text-slate-400', badge: 'bg-slate-500' };
};

const getRoleDisplay = (role: string) => {
    return (USER_ROLES as Record<string, string>)[role] || role.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
};

function UserNode({ data, selected }: NodeProps) {
    const { label, role, photoURL, email, isHighlighted, managerCount = 0 } = data as any;
    const colors = getLevelColor(role);
    const isSelected = selected || (data as any).isSelected;
    const highlighted = isHighlighted || false;

    return (
        <div className={`
            relative px-4 py-3 rounded-xl shadow-lg backdrop-blur-sm transition-all duration-300
            ${highlighted
                ? 'bg-amber-500/30 border-amber-400 ring-4 ring-amber-400/50 shadow-amber-500/30 shadow-xl animate-pulse'
                : isSelected
                    ? 'bg-primary/30 border-primary ring-2 ring-primary/50 shadow-primary/20'
                    : `${colors.bg} ${colors.border}`
            } 
            border-2 hover:shadow-xl hover:scale-[1.02]
            cursor-pointer group min-w-[240px]
        `}>
            {/* Highlight star indicator */}
            {highlighted && (
                <div className="absolute -top-3 -left-3 z-10 w-7 h-7 bg-amber-400 rounded-full flex items-center justify-center shadow-lg animate-bounce">
                    <Star className="h-4 w-4 text-black fill-black" />
                </div>
            )}

            {/* Multi-manager badge */}
            {managerCount > 1 && (
                <div className="absolute -top-2 -left-2 z-10 px-1.5 py-0.5 bg-violet-500 rounded-full flex items-center gap-0.5 shadow-md text-[10px] font-bold text-white">
                    <Users className="h-3 w-3" />
                    {managerCount}
                </div>
            )}

            {/* Selection checkmark */}
            {isSelected && !highlighted && (
                <div className="absolute -top-2 -right-2 z-10 w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow-md">
                    <Check className="h-3 w-3 text-black" />
                </div>
            )}

            {/* Connection Handles */}
            <Handle
                type="target"
                position={Position.Top}
                className="!w-3 !h-3 !bg-slate-600 !border-2 !border-slate-400 !-top-1.5"
            />
            <Handle
                type="source"
                position={Position.Bottom}
                className="!w-3 !h-3 !bg-slate-600 !border-2 !border-slate-400 !-bottom-1.5"
            />

            <div className="flex items-center gap-3">
                <Avatar className={`h-12 w-12 border-2 shadow-md shrink-0 ${highlighted ? 'border-amber-400' : isSelected ? 'border-primary' : 'border-white/20'}`}>
                    <AvatarImage src={photoURL || undefined} className="object-cover" />
                    <AvatarFallback className={`${colors.badge} text-white font-bold text-sm`}>
                        {(label as string)?.charAt(0)?.toUpperCase() || '?'}
                    </AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-white text-sm truncate leading-tight">
                        {label || 'Unknown'}
                    </h3>
                    <p className={`text-xs ${colors.text} font-medium truncate`}>
                        {getRoleDisplay(role)}
                    </p>
                    {email && (
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">
                            {email}
                        </p>
                    )}
                </div>

                <div className={`w-2 h-full absolute right-0 top-0 rounded-r-xl ${highlighted ? 'bg-amber-400' : isSelected ? 'bg-primary' : colors.badge} opacity-60`} />
            </div>
        </div>
    );
}

export default memo(UserNode);
