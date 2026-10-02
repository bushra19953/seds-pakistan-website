"use client";

import { useState, useEffect } from 'react';
import { useUser } from '@/firebase';
import { hasSufficientRole } from '@/lib/roles';
import { hasPermission } from '@/config/permissions';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import UserSelectionCombobox from '@/components/admin/user-selection-combobox';
import { getRoleDisplayName, USER_ROLES } from '@/lib/roles';
import { format } from 'date-fns';
import { safeFormat, toDate } from '@/lib/date-utils';
import { 
  Plus, 
  Edit, 
  Trash2, 
  Save, 
  X, 
  Users, 
  Clock, 
  Shield,
  CheckCircle,
  AlertCircle,
  Loader2,
  History,
  UserCheck,
  Calendar
} from 'lucide-react';

interface Position {
  id: string;
  role: string;
  userId: string;
  startDate: Date;
  endDate: Date | null;
  appointedBy: string;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: {
    roleDisplayName: string;
    userDisplayName: string;
    appointedByDisplayName: string;
  };
}

export default function PositionsAdminPage() {
  const { user, role, isLoading } = useUser();
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  
  // Form state
  const [formData, setFormData] = useState({
    role: '',
    userId: '',
    startDate: '',
    endDate: '',
    notes: ''
  });

  // Check permissions - same as existing admin patterns

  // Fetch positions
  const fetchPositions = async () => {
    try {
      setLoading(true);
      setError('');
      
      const token = await user?.getIdToken();
      const res = await fetch('/api/positions?admin=true&limit=100', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch positions');
      }

      const data = await res.json();
      setPositions(data.positions || []);
    } catch (err: any) {
      console.error('Error fetching positions:', err);
      setError(err.message || 'Failed to load positions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && role) {
      fetchPositions();
    }
  }, [user, role]);

  // Group positions by role
  const groupedPositions = positions.reduce((acc, position) => {
    if (!acc[position.role]) {
      acc[position.role] = [];
    }
    acc[position.role].push(position);
    return acc;
  }, {} as Record<string, Position[]>);

  // Sort positions within each role by start date (newest first)
  Object.keys(groupedPositions).forEach(role => {
    groupedPositions[role].sort((a, b) => 
      new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
    );
  });

  const startEdit = (position?: Position) => {
    if (position) {
      setEditingPosition(position);
      setFormData({
        role: position.role,
        userId: position.userId,
        startDate: safeFormat(position.startDate, 'yyyy-MM-dd', ''),
        endDate: position.endDate ? safeFormat(position.endDate, 'yyyy-MM-dd', '') : '',
        notes: position.notes || ''
      });
    } else {
      setEditingPosition(null);
      setFormData({
        role: '',
        userId: '',
        startDate: '',
        endDate: '',
        notes: ''
      });
    }
    setIsFormOpen(true);
    setError('');
    setSuccess('');
  };

  const cancelEdit = () => {
    setEditingPosition(null);
    setIsFormOpen(false);
    setFormData({
      role: '',
      userId: '',
      startDate: '',
      endDate: '',
      notes: ''
    });
    setError('');
    setSuccess('');
  };

  const validateForm = () => {
    if (!formData.role || !formData.userId || !formData.startDate) {
      setError('Role, user, and start date are required');
      return false;
    }
    return true;
  };

  const savePosition = async () => {
    if (!validateForm()) return;
    
    try {
      setError('');
      setSuccess('');
      
      const token = await user?.getIdToken();
      const payload = {
        role: formData.role,
        userId: formData.userId,
        startDate: formData.startDate,
        endDate: formData.endDate ? formData.endDate : null,
        notes: formData.notes || ''
      };

      let res: Response;
      
      if (editingPosition) {
        // Update existing position
        res = await fetch('/api/positions', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            positionId: editingPosition.id,
            updates: payload
          })
        });
      } else {
        // Create new position
        res = await fetch('/api/positions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save position');
      }

      const data = await res.json();
      setSuccess(data.message || 'Position saved successfully');
      
      // Refresh positions list
      await fetchPositions();
      cancelEdit();
      
      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(''), 3000);
      
    } catch (err: any) {
      console.error('Error saving position:', err);
      setError(err.message || 'Failed to save position');
    }
  };

  const deletePosition = async (positionId: string) => {
    if (!confirm('Are you sure you want to delete this position? This will create an audit log.')) {
      return;
    }

    try {
      setError('');
      setSuccess('');
      
      const token = await user?.getIdToken();
      const res = await fetch('/api/positions', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ positionId })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete position');
      }

      setSuccess('Position deleted successfully');
      await fetchPositions();
      
      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(''), 3000);
      
    } catch (err: any) {
      console.error('Error deleting position:', err);
      setError(err.message || 'Failed to delete position');
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };


  return (
    <AuthorizationGate permission="canManagePositions">
      <div className="mb-6">
        <h1 className="text-4xl font-bold text-glow mb-2">Leadership History</h1>
        <p className="text-muted-foreground">
          Track organizational leadership timeline for public display and alumni networking
        </p>
      </div>

      {/* Success/Error Messages */}
      {success && (
        <Alert className="mb-6 border-green-200 bg-green-50">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800">{success}</AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert className="mb-6 border-red-200 bg-red-50">
          <AlertCircle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-800">{error}</AlertDescription>
        </Alert>
      )}

      {/* Explanation Card */}
      <Card className="mb-6 bg-blue-50 border-blue-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-blue-800">
            <History className="h-5 w-5" />
            What is Leadership History?
          </CardTitle>
        </CardHeader>
        <CardContent className="text-blue-700">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="font-medium mb-2">📊 Purpose</h4>
              <p className="text-sm">
                Creates a historical record of who held leadership positions when. 
                This appears on your public website to show organizational continuity.
              </p>
            </div>
            <div>
              <h4 className="font-medium mb-2">🔄 Integration</h4>
              <p className="text-sm">
                Uses the same role names as your existing user roles system, 
                but tracks historical assignments, not current permissions.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Positions List */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Leadership Timeline by Role
            </CardTitle>
            <CardDescription>
              Historical record of leadership positions. Current holders are marked as &quot;Present&quot;.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="ml-2">Loading leadership history...</span>
              </div>
            ) : positions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No leadership history recorded yet</p>
                <p className="text-sm">Add the first leadership position to get started</p>
                <Button 
                  className="mt-4" 
                  onClick={() => startEdit()}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add First Position
                </Button>
              </div>
            ) : (
              <Accordion type="multiple" className="w-full">
                {Object.entries(groupedPositions).map(([role, rolePositions]) => {
                  const currentPosition = rolePositions.find(p => !p.endDate);
                  const displayName = getRoleDisplayName(role as any);
                  
                  return (
                    <AccordionItem key={role} value={role}>
                      <AccordionTrigger>
                        <div className="flex items-center gap-3">
                          <span className="font-medium">{displayName}</span>
                          {currentPosition && (
                            <Badge variant="secondary" className="ml-2 bg-green-100 text-green-800">
                              <UserCheck className="h-3 w-3 mr-1" />
                              Current: {currentPosition.metadata?.userDisplayName || currentPosition.userId}
                            </Badge>
                          )}
                          <Badge variant="outline">
                            {rolePositions.length} {rolePositions.length === 1 ? 'leader' : 'leaders'}
                          </Badge>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-3">
                          {rolePositions.map((position) => {
                            const isCurrent = !position.endDate;
                            const initials = position.metadata?.userDisplayName
                              ?.split(' ')
                              .map(n => n[0])
                              .join('') || 'U';
                            
                            return (
                              <div key={position.id} className="border rounded-lg p-4 space-y-3">
                                <div className="flex items-start justify-between">
                                  <div className="flex items-center gap-3">
                                    <Avatar className="h-8 w-8">
                                      <AvatarFallback>{initials}</AvatarFallback>
                                    </Avatar>
                                    <div>
                                      <div className="font-medium">
                                        {position.metadata?.userDisplayName || position.userId}
                                      </div>
                                      <div className="text-sm text-muted-foreground flex items-center gap-2">
                                        <Clock className="h-3 w-3" />
                                        <span>
                                          {safeFormat(position.startDate, 'MMM dd, yyyy')} — 
                                          {position.endDate ? ` ${safeFormat(position.endDate, 'MMM dd, yyyy')}` : ' Present'}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {isCurrent && (
                                      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                        Current
                                      </Badge>
                                    )}
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => startEdit(position)}
                                    >
                                      <Edit className="h-3 w-3 mr-1" />
                                      Edit
                                    </Button>
                                    <Button
                                      variant="destructive"
                                      size="sm"
                                      onClick={() => deletePosition(position.id)}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                                {position.notes && (
                                  <div className="text-sm text-muted-foreground bg-gray-50 p-2 rounded">
                                    <strong>Notes:</strong> {position.notes}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            )}
          </CardContent>
        </Card>

        {/* Add/Edit Form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {editingPosition ? <Edit className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
              {editingPosition ? 'Edit Leadership Position' : 'Add Leadership Position'}
            </CardTitle>
            <CardDescription>
              {editingPosition 
                ? 'Update the leadership history record.'
                : 'Record a new leadership position assignment.'
              }
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert className="bg-yellow-50 border-yellow-200">
              <AlertDescription className="text-yellow-800 text-sm">
                <strong>Note:</strong> This tracks leadership history, not current user permissions. 
                User roles are managed separately in the Users section.
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label htmlFor="role">Leadership Role *</Label>
              <Select
                value={formData.role}
                onValueChange={(value) => handleInputChange('role', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a leadership role" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(USER_ROLES).map(([roleKey, roleName]) => (
                    <SelectItem key={roleKey} value={roleKey}>
                      {roleName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                These are the same roles used in your user management system
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="userId">Person *</Label>
              <UserSelectionCombobox
                selectedUid={formData.userId || null}
                onSelect={(uid) => handleInputChange('userId', uid)}
                placeholder="Select the person who held this position"
              />
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date *</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={formData.startDate}
                  onChange={(e) => handleInputChange('startDate', e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={formData.endDate}
                  onChange={(e) => handleInputChange('endDate', e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty if this person currently holds the position
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Textarea
                id="notes"
                value={formData.notes}
                onChange={(e) => handleInputChange('notes', e.target.value)}
                placeholder="Additional notes about this leadership period..."
                rows={3}
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={savePosition} className="flex-1">
                <Save className="h-4 w-4 mr-2" />
                {editingPosition ? 'Update' : 'Add'} Position
              </Button>
              {isFormOpen && (
                <Button variant="outline" onClick={cancelEdit}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* How it Works */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>How This Integrates With Your Site</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <Users className="h-4 w-4 text-blue-600" />
                Public About Page
              </h4>
              <p className="text-sm text-muted-foreground">
                Automatically shows current leadership by reading from this history.
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <History className="h-4 w-4 text-green-600" />
                Leadership Timeline
              </h4>
              <p className="text-sm text-muted-foreground">
                Complete historical view for visitors and alumni networking.
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="font-medium flex items-center gap-2">
                <Calendar className="h-4 w-4 text-purple-600" />
                Automatic Continuity
              </h4>
              <p className="text-sm text-muted-foreground">
                When you add a new current position, the previous one is automatically closed.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </AuthorizationGate>
  );
}
