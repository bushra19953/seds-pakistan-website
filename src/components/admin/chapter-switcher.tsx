"use client";

import { useState, useEffect } from "react";
import { useFirestore, useCollection } from "@/firebase";
import { collection, query, orderBy } from "firebase/firestore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useUserContext } from "@/firebase/user-provider";

interface Chapter {
    id: string;
    name: string;
}

interface ChapterSwitcherProps {
    currentChapterId?: string | null;
    onChapterChange?: (chapterId: string | null) => void;
}

export function ChapterSwitcher({ currentChapterId: propId, onChapterChange: propOnChange }: ChapterSwitcherProps) {
    const { activeChapterContext, setActiveChapterContext } = useUserContext();
    const firestore = useFirestore();
    
    // Support both controlled (props) and uncontrolled (context) modes
    const currentId = propId !== undefined ? propId : activeChapterContext;
    const handleChange = propOnChange || setActiveChapterContext;

    const chaptersQuery = query(collection(firestore, 'chapters'), orderBy('name', 'asc'));
    const { data: chapters, loading } = useCollection(chaptersQuery);

    if (loading) return <div className="h-10 w-48 bg-slate-800 animate-pulse rounded-lg" />;

    return (
        <div className="flex items-center gap-3 bg-slate-900/50 border border-slate-800 p-1.5 rounded-xl backdrop-blur-md">
            <div className="pl-3 pr-1">
                <Globe className={`h-4 w-4 ${!currentId ? 'text-primary' : 'text-muted-foreground'}`} />
            </div>
            
            <Select 
                value={currentId || "all"} 
                onValueChange={(val) => handleChange(val === "all" ? null : val)}
            >
                <SelectTrigger className="w-[220px] bg-slate-950 border-slate-800 h-9 font-mono text-[10px] font-black uppercase tracking-widest">
                    <SelectValue placeholder="Select Fleet Context" />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-800">
                    <SelectItem value="all" className="font-mono text-[10px] font-black uppercase tracking-widest">
                        <span className="flex items-center gap-2">
                            <Globe className="h-3 w-3" /> ALL CHAPTERS (NATIONAL)
                        </span>
                    </SelectItem>
                    {chapters?.map((c: any) => (
                        <SelectItem key={c.id} value={c.id} className="font-mono text-[10px] font-black uppercase tracking-widest">
                            <span className="flex items-center gap-2">
                                <Building2 className="h-3 w-3" /> {c.name}
                            </span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {!currentId ? (
                <Badge className="bg-primary/20 text-primary border-0 text-[9px] font-black uppercase px-2 h-6 mr-2">Combined Stats</Badge>
            ) : (
                <Badge variant="outline" className="border-slate-700 text-muted-foreground text-[9px] font-black uppercase px-2 h-6 mr-2">Local View</Badge>
            )}
        </div>
    );
}
