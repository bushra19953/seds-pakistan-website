'use client';

import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Search, BarChart3, Users, MoreVertical, Edit, AlertCircle, Trash2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Capability } from '../types';

interface CapabilityDataGridProps {
  loading: boolean;
  filteredSkills: Capability[];
  selectedSkill: Capability | null;
  setSelectedSkill: (skill: Capability) => void;
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  categoryFilter: string;
  setCategoryFilter: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  categories: string[];
  onEdit: (skill: Capability) => void;
  onToggleStatus: (id: string, currentStatus: string) => void;
  onDeleteRequest: (skill: Capability) => void;
}

export function CapabilityDataGrid({
  loading, filteredSkills, selectedSkill, setSelectedSkill,
  searchTerm, setSearchTerm, categoryFilter, setCategoryFilter,
  statusFilter, setStatusFilter, categories,
  onEdit, onToggleStatus, onDeleteRequest
}: CapabilityDataGridProps) {
  return (
    <Card className="border-border/50 shadow-md">
      <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
        <div className="flex flex-col sm:flex-row justify-between gap-4">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" /> Matrix Index
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search capabilities..." 
                className="pl-9 w-[200px] bg-background h-9" 
                value={searchTerm} 
                onChange={(e) => setSearchTerm(e.target.value)} 
              />
            </div>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[140px] h-9 bg-background"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map(c => <SelectItem key={String(c)} value={String(c)}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[120px] h-9 bg-background"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 max-h-[600px] overflow-auto">
        <Table>
          <TableHeader className="bg-muted/30 sticky top-0 z-10 shadow-sm">
            <TableRow>
              <TableHead className="font-bold">Capability</TableHead>
              <TableHead className="font-bold">Category</TableHead>
              <TableHead className="font-bold text-center">Adoption</TableHead>
              <TableHead className="font-bold text-center">Status</TableHead>
              <TableHead className="text-right font-bold">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8"><div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full mx-auto" /></TableCell></TableRow>
            ) : filteredSkills.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No capabilities found matching parameters.</TableCell></TableRow>
            ) : (
              filteredSkills.map(s => (
                <TableRow 
                  key={s.id} 
                  className={`cursor-pointer transition-colors ${selectedSkill?.id === s.id ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-muted/50'}`}
                  onClick={() => setSelectedSkill(s)}
                >
                  <TableCell>
                    <div className="font-bold text-foreground">{s.name}</div>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">{s.slug}</div>
                  </TableCell>
                  <TableCell>
                    {s.category ? <Badge variant="outline" className="bg-muted/50">{s.category}</Badge> : <span className="text-muted-foreground text-xs">—</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Users className="h-3 w-3 text-muted-foreground" />
                      <span className="font-mono font-medium">{s.assignedUserCount || 0}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={s.status === 'active' ? 'default' : 'secondary'} className={s.status === 'active' ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20 border-green-500/20' : ''}>
                      {s.status.toUpperCase()}
                    </Badge>
                    {s.isFeatured && <Badge variant="outline" className="ml-1 bg-amber-500/10 text-amber-500 border-amber-500/20 text-[10px]">★</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8"><MoreVertical className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[160px]">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(s); }}>
                          <Edit className="h-4 w-4 mr-2" /> Edit Parameters
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onToggleStatus(s.id, s.status); }}>
                          <AlertCircle className="h-4 w-4 mr-2" /> Toggle Status
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:bg-destructive/10" onClick={(e) => { e.stopPropagation(); onDeleteRequest(s); }}>
                          <Trash2 className="h-4 w-4 mr-2" /> Purge Capability
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
