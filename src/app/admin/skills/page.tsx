'use client';

import { useEffect, useMemo, useState } from 'react';
import { useUser } from '@/firebase';
import { hasPermissionForRole } from '@/config/permissions.config';
import { useRouter } from 'next/navigation';
import { doc } from 'firebase/firestore';
;
import { useFirestore } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import MultiSelectUserCombobox from '@/components/admin/multi-select-user-combobox';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Target, Users, Plus, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

// Child Components & Types
import { Capability } from './types';
import { MatrixMetricsRow } from './components/matrix-metrics-row';
import { CapabilityDataGrid } from './components/capability-data-grid';
import { CapabilityDetailPanel } from './components/capability-detail-panel';
import { RegisterCapabilityModal } from './components/register-capability-modal';
import { updateDoc } from '@/lib/client/firestore-wrapper';

export default function AdminSkillsCommandCenter() {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const firestore = useFirestore();

  const [skills, setSkills] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);

  // UI Filter State
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSkill, setSelectedSkill] = useState<Capability | null>(null);

  // Modal State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  // Form Targets
  const [editingSkill, setEditingSkill] = useState<Capability | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Capability | null>(null);

  // Bulk State
  const [bulkSkillId, setBulkSkillId] = useState('');
  const [bulkUserIds, setBulkUserIds] = useState<string[]>([]);


  const refreshSkills = useMemo(() => {
    return async () => {
      try {
        setLoading(true);
        const token = await user!.getIdToken(true);
        const res = await fetch('/api/skills', { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('Failed to load matrix');
        const data = await res.json();
        setSkills(data.items || []);
      } catch (e: any) {
        toast.error('System Failure: Could not load capabilities.');
      } finally {
        setLoading(false);
      }
    };
  }, [user]);

  useEffect(() => {
    if (user) {
      refreshSkills();
    }
  }, [user, refreshSkills]);

  const categories = useMemo(() => Array.from(new Set(skills.map(s => s.category).filter(Boolean))), [skills]) as string[];

  const filteredSkills = useMemo(() => {
    return skills.filter(s => {
      const matchesSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase()) || s.slug.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory = categoryFilter === 'all' || s.category === categoryFilter;
      const matchesStatus = statusFilter === 'all' || s.status === statusFilter;
      return matchesSearch && matchesCategory && matchesStatus;
    }).sort((a, b) => (a.displayOrder || 999) - (b.displayOrder || 999));
  }, [skills, searchTerm, categoryFilter, statusFilter]);

  // Actions
  const handleToggleStatus = async (id: string, currentStatus: string) => {
    try {
      await updateDoc(doc(firestore, 'skills', id), { status: currentStatus === 'active' ? 'archived' : 'active' });
      setSkills(prev => prev.map(s => s.id === id ? { ...s, status: currentStatus === 'active' ? 'archived' : 'active' } : s));
      toast.success('Status toggled.');
    } catch { toast.error('Toggle failed.'); }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const token = await user!.getIdToken(true);
      const res = await fetch('/api/skills', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ id: deleteTarget.id }) });
      if (!res.ok) throw new Error('Delete failed');
      setSkills(prev => prev.filter(s => s.id !== deleteTarget.id));
      setIsDeleteOpen(false);
      setDeleteTarget(null);
      if (selectedSkill?.id === deleteTarget.id) setSelectedSkill(null);
      toast.success('Capability permanently purged.');
    } catch { toast.error('Purge failed. Ensure no personnel are actively assigned this skill.'); }
  };

  const handleBulkAssign = async () => {
    if (!bulkSkillId || bulkUserIds.length === 0) return toast.error('Select a capability and personnel.');
    try {
      const token = await user!.getIdToken(true);
      const res = await fetch('/api/skills/assign-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ skillId: bulkSkillId, userIds: bulkUserIds }),
      });
      if (!res.ok) throw new Error('Bulk deployment failed');
      toast.success(`Capability successfully deployed to ${bulkUserIds.length} personnel.`);
      setIsBulkOpen(false);
      setBulkSkillId('');
      setBulkUserIds([]);
      refreshSkills(); 
    } catch { toast.error('Bulk deployment failed.'); }
  };


  return (
    <AuthorizationGate permission="canManageSkills">
      <div className="space-y-6 animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tight flex items-center gap-3">
              <Target className="h-8 w-8 text-primary" />
              Capabilities & Skills Matrix
            </h1>
            <p className="text-muted-foreground font-medium mt-1">Manage organizational taxonomies, track adoption, and configure capability structures.</p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => setIsBulkOpen(true)} className="border border-border/50 shadow-sm font-bold">
              <Users className="h-4 w-4 mr-2" /> Bulk Deploy
            </Button>
            <Button onClick={() => { setEditingSkill(null); setIsCreateOpen(true); }} className="font-bold shadow-md">
              <Plus className="h-4 w-4 mr-2" /> Register Capability
            </Button>
          </div>
        </div>

        <MatrixMetricsRow skills={skills} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <CapabilityDataGrid 
              loading={loading}
              filteredSkills={filteredSkills}
              selectedSkill={selectedSkill}
              setSelectedSkill={setSelectedSkill}
              searchTerm={searchTerm}
              setSearchTerm={setSearchTerm}
              categoryFilter={categoryFilter}
              setCategoryFilter={setCategoryFilter}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              categories={categories}
              onEdit={(skill) => { setEditingSkill(skill); setIsCreateOpen(true); }}
              onToggleStatus={handleToggleStatus}
              onDeleteRequest={(skill) => { setDeleteTarget(skill); setIsDeleteOpen(true); }}
            />
          </div>
          <div className="space-y-4">
            <CapabilityDetailPanel 
              selectedSkill={selectedSkill} 
              onOpenBulkAssign={(id) => { setBulkSkillId(id); setIsBulkOpen(true); }} 
            />
          </div>
        </div>

        <RegisterCapabilityModal 
          isOpen={isCreateOpen} 
          onOpenChange={setIsCreateOpen} 
          editingSkill={editingSkill} 
          onSuccess={refreshSkills} 
        />

        <Dialog open={isBulkOpen} onOpenChange={setIsBulkOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="text-2xl font-black uppercase tracking-tight text-primary">Force Assignment</DialogTitle>
              <DialogDescription>Bypass standard acquisition protocols and directly assign capabilities to personnel.</DialogDescription>
            </DialogHeader>
            <div className="space-y-6 py-4">
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Target Capability</Label>
                <Select value={bulkSkillId} onValueChange={setBulkSkillId}>
                  <SelectTrigger className="font-bold"><SelectValue placeholder="Select from Matrix..." /></SelectTrigger>
                  <SelectContent>
                    {skills.filter(s => s.status === 'active').map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Target Personnel</Label>
                <div className="border border-border/50 rounded-lg p-1 bg-background">
                  <MultiSelectUserCombobox value={bulkUserIds} onChange={setBulkUserIds} />
                </div>
                <p className="text-xs text-muted-foreground text-right mt-1">{bulkUserIds.length} personnel selected</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsBulkOpen(false)}>Abort</Button>
              <Button onClick={handleBulkAssign} className="font-bold" disabled={!bulkSkillId || bulkUserIds.length === 0}>Execute Deployment</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
          <DialogContent className="border-destructive/30">
            <DialogHeader>
              <DialogTitle className="text-destructive flex items-center gap-2"><AlertCircle className="h-5 w-5" /> Critical Action</DialogTitle>
              <DialogDescription>
                You are about to permanently purge <strong className="text-foreground">{deleteTarget?.name}</strong> from the matrix.
                This will forcefully detach it from all assigned personnel and invalidate associated event configurations.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => { setIsDeleteOpen(false); setDeleteTarget(null); }}>Abort</Button>
              <Button variant="destructive" onClick={handleDelete} className="font-bold">Confirm Purge</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AuthorizationGate>
  );
}
