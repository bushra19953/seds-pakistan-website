'use client';

import { useState, useEffect } from 'react';
import { useFirestore } from '@/firebase';
import { collection, query, where, limit, getDocs } from 'firebase/firestore';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Target, Users, Tag, Calendar } from 'lucide-react';
import { Capability } from '../types';

interface CapabilityDetailPanelProps {
  selectedSkill: Capability | null;
  onOpenBulkAssign: (skillId: string) => void;
}

export function CapabilityDetailPanel({ selectedSkill, onOpenBulkAssign }: CapabilityDetailPanelProps) {
  if (!selectedSkill) {
    return (
      <Card className="border-dashed border-2 border-muted-foreground/20 bg-muted/5 h-[300px] flex flex-col items-center justify-center text-center p-6">
        <Target className="h-12 w-12 text-muted-foreground/30 mb-4" />
        <CardTitle className="text-lg text-muted-foreground mb-2">No Capability Selected</CardTitle>
        <CardDescription>Select a skill from the matrix to view detailed adoption metrics and event sources.</CardDescription>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30 shadow-lg border-t-4 border-t-primary animate-in slide-in-from-right-4 duration-300">
      <CardHeader className="pb-3 border-b border-border/50 bg-muted/10">
        <CardDescription className="text-xs uppercase tracking-widest font-bold text-primary mb-1">Selected Capability</CardDescription>
        <CardTitle className="text-xl font-black">{selectedSkill.name}</CardTitle>
        <div className="flex gap-2 mt-2">
          <Badge variant="outline" className="font-mono text-[10px]">{selectedSkill.slug}</Badge>
          {selectedSkill.category && <Badge variant="secondary" className="text-[10px]">{selectedSkill.category}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="w-full rounded-none border-b border-border/50 bg-transparent h-12">
            <TabsTrigger value="overview" className="flex-1 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none">Overview</TabsTrigger>
            <TabsTrigger value="events" className="flex-1 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none flex gap-2">
              Sources <Badge variant="secondary" className="h-4 px-1">{selectedSkill.linkedEventCount || 0}</Badge>
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="overview" className="p-5 space-y-4 mt-0">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-muted/30 p-3 rounded-lg border border-border/50 text-center">
                <Users className="h-5 w-5 text-primary mx-auto mb-1" />
                <div className="text-2xl font-black">{selectedSkill.assignedUserCount || 0}</div>
                <div className="text-[10px] uppercase font-bold text-muted-foreground">Personnel</div>
              </div>
              <div className="bg-muted/30 p-3 rounded-lg border border-border/50 text-center">
                <Tag className="h-5 w-5 text-primary mx-auto mb-1" />
                <div className="text-2xl font-black">{selectedSkill.isFeatured ? 'YES' : 'NO'}</div>
                <div className="text-[10px] uppercase font-bold text-muted-foreground">Featured</div>
              </div>
            </div>
            <Button variant="secondary" className="w-full font-bold shadow-sm" onClick={() => onOpenBulkAssign(selectedSkill.id)}>
              <Users className="h-4 w-4 mr-2" /> Force Assignment
            </Button>
          </TabsContent>

          <TabsContent value="events" className="p-0 mt-0">
            <div className="p-4 bg-primary/5 border-b border-primary/10">
              <p className="text-xs text-muted-foreground font-medium">
                Showing events/workshops configured to automatically grant <strong className="text-primary">{selectedSkill.name}</strong> upon completion.
              </p>
            </div>
            <RelatedEventsFeed skillId={selectedSkill.id} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function RelatedEventsFeed({ skillId }: { skillId: string }) {
  const firestore = useFirestore();
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    const fetchEvents = async () => {
      setLoading(true);
      try {
        const q = query(
          collection(firestore, 'events'), 
          where('grantedSkillIds', 'array-contains', skillId),
          limit(5)
        );
        const snap = await getDocs(q);
        if (!isMounted) return;
        setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch (err) {
        console.warn('Failed to fetch related events', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchEvents();
    return () => { isMounted = false; };
  }, [skillId, firestore]);

  if (loading) return <div className="p-5 flex justify-center"><div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" /></div>;
  
  if (events.length === 0) return (
    <div className="p-8 text-center text-muted-foreground">
      <Calendar className="h-8 w-8 mx-auto mb-2 opacity-20" />
      <p className="text-sm font-medium">No sources configured.</p>
      <p className="text-xs mt-1">Go to Events Management to link workshops to this capability.</p>
    </div>
  );

  return (
    <div className="divide-y divide-border/50">
      {events.map(ev => {
        const isPastEvent = ev.event_date && new Date(ev.event_date.toDate ? ev.event_date.toDate() : ev.event_date) < new Date();
        return (
          <div key={ev.id} className="p-4 hover:bg-muted/30 transition-colors flex items-start gap-3">
            <div className={`p-2 rounded-md shrink-0 ${ev.type === 'workshop' ? 'bg-indigo-500/10 text-indigo-500' : 'bg-primary/10 text-primary'}`}>
              <Calendar className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-bold truncate pr-2">{ev.title}</h4>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="outline" className="text-[9px] uppercase">{ev.type || 'Event'}</Badge>
                <span className="text-xs text-muted-foreground font-medium">
                  {ev.event_date ? new Date(ev.event_date.toDate ? ev.event_date.toDate() : ev.event_date).toLocaleDateString() : 'TBD'}
                </span>
                {isPastEvent && <span className="text-[10px] text-amber-500 font-bold ml-auto">Archived</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
