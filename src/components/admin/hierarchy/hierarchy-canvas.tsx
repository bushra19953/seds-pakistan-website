"use client";

import React, { useCallback, useEffect, useState, useRef, Component, ReactNode } from 'react';
import {
    ReactFlow, MiniMap, Controls, Background, useNodesState, useEdgesState,
    MarkerType, Position, Node, Edge, NodeTypes, Connection, OnConnect,
    NodeMouseHandler, SelectionMode, useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { Loader2, Maximize2, RefreshCw, Check, AlertCircle, AlertTriangle, Trash2 } from 'lucide-react';
import UserNode from './user-node';
import { Button } from '@/components/ui/button';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { getAuth } from 'firebase/auth';
import { AddPersonModal } from './add-person-modal';
import { DeletePersonDialog } from './delete-person-dialog';
import { BulkActionToolbar } from './bulk-action-toolbar';
import { SmartUserSearch } from './smart-user-search';
import { RelationshipTypeDialog } from './relationship-type-dialog';

const nodeWidth = 280, nodeHeight = 80;
const nodeTypes: NodeTypes = { userNode: UserNode };

// Error Boundary
class ErrorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { hasError: boolean; error: Error | null }> {
    constructor(props: any) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="h-full w-full flex flex-col items-center justify-center space-y-4 bg-red-950/20 rounded-lg border border-red-500/30 p-8">
                    <AlertTriangle className="h-12 w-12 text-red-400" />
                    <p className="text-red-400 font-medium">Hierarchy Error</p>
                    <p className="text-sm text-slate-400 text-center max-w-md">{this.state.error?.message || 'Unknown error'}</p>
                    <Button variant="outline" onClick={() => { this.setState({ hasError: false, error: null }); this.props.onRetry(); }}>Retry</Button>
                </div>
            );
        }
        return this.props.children;
    }
}

// Edge styles
const getEdgeStyle = (type: 'direct' | 'dotted') => ({
    stroke: type === 'dotted' ? '#f59e0b' : '#22c55e',
    strokeWidth: 2,
    strokeDasharray: type === 'dotted' ? '5,5' : undefined,
});

// Layout
const getLayoutedElements = (nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } => {
    if (nodes.length === 0) return { nodes: [], edges: [] };
    try {
        const g = new dagre.graphlib.Graph();
        g.setDefaultEdgeLabel(() => ({}));
        g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 100, marginx: 40, marginy: 40 });
        nodes.forEach(n => g.setNode(n.id, { width: nodeWidth, height: nodeHeight }));
        edges.forEach(e => { if (e.source && e.target) g.setEdge(e.source, e.target); });
        dagre.layout(g);
        return {
            nodes: nodes.map(n => {
                const p = g.node(n.id);
                return p
                    ? { ...n, targetPosition: Position.Top, sourcePosition: Position.Bottom, position: { x: p.x - nodeWidth / 2, y: p.y - nodeHeight / 2 } }
                    : { ...n, position: { x: Math.random() * 400, y: 0 } };
            }),
            edges
        };
    } catch (e) {
        console.error('Layout error:', e);
        return { nodes, edges };
    }
};

// Validate and sanitize data
const validateNodes = (rawUsers: any[]): Node[] => {
    return rawUsers
        .filter(u => u && u.id && typeof u.id === 'string')
        .map(u => ({
            id: u.id,
            type: 'userNode',
            data: {
                label: u.displayName || u.email || 'Unknown',
                email: u.email || '',
                role: u.role || 'member',
                photoURL: u.photoURL || null,
                isSelected: false,
                isHighlighted: false,
                managerCount: Array.isArray(u.managerIds) ? u.managerIds.length : (u.managerId ? 1 : 0)
            },
            position: { x: 0, y: 0 }
        }));
};

const validateEdges = (rawUsers: any[], userIds: Set<string>): Edge[] => {
    const edges: Edge[] = [];
    const seen = new Set<string>();

    rawUsers.forEach(u => {
        if (!u || !u.id) return;

        const managerIds = Array.isArray(u.managerIds) ? u.managerIds : [];

        managerIds.forEach((m: { managerId?: string; type?: string }) => {
            if (!m || !m.managerId) return;
            if (!userIds.has(m.managerId)) return; // Manager not in current view

            const edgeId = `e-${m.managerId}-${u.id}`;
            if (seen.has(edgeId)) return;
            seen.add(edgeId);

            const type = m.type === 'dotted' ? 'dotted' : 'direct';
            edges.push({
                id: `${edgeId}-${type}`,
                source: m.managerId,
                target: u.id,
                type: 'smoothstep',
                markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: type === 'dotted' ? '#f59e0b' : '#22c55e' },
                style: getEdgeStyle(type),
                data: { relationType: type }
            });
        });

        // Fallback to legacy managerId
        if (managerIds.length === 0 && u.managerId && userIds.has(u.managerId)) {
            const edgeId = `e-${u.managerId}-${u.id}`;
            if (!seen.has(edgeId)) {
                seen.add(edgeId);
                edges.push({
                    id: `${edgeId}-direct`,
                    source: u.managerId,
                    target: u.id,
                    type: 'smoothstep',
                    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: '#22c55e' },
                    style: getEdgeStyle('direct'),
                    data: { relationType: 'direct' }
                });
            }
        }
    });

    return edges;
};

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function HierarchyCanvasInner({ chapterId }: { chapterId: string }) {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [rawUsers, setRawUsers] = useState<any[]>([]);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [filterQuery, setFilterQuery] = useState('');
    const [highlightedNode, setHighlightedNode] = useState<string | null>(null);
    const { showErrorToast, showSuccessToast } = useEnhancedToast();
    const fetchIdRef = useRef(0);
    const { fitView, setCenter, getNode } = useReactFlow();

    const [addModalOpen, setAddModalOpen] = useState(false);
    const [addModalEmail, setAddModalEmail] = useState('');
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [selectedPerson, setSelectedPerson] = useState<{ id: string; displayName: string } | null>(null);
    const [typeDialogOpen, setTypeDialogOpen] = useState(false);
    const [pendingConnection, setPendingConnection] = useState<{ source: string; target: string; sourceName: string; targetName: string } | null>(null);

    const getToken = async () => {
        try {
            return (await getAuth().currentUser?.getIdToken()) || null;
        } catch {
            return null;
        }
    };

    const apiCall = async (url: string, opts: RequestInit, retries = 2): Promise<Response> => {
        for (let i = 1; i <= retries; i++) {
            try {
                const res = await fetch(url, opts);
                return res;
            } catch (e) {
                if (i === retries) throw e;
                await new Promise(r => setTimeout(r, 500 * i));
            }
        }
        throw new Error('Request failed');
    };

    // Fetch data
    const fetchData = useCallback(async () => {
        const id = ++fetchIdRef.current;
        setLoading(true);
        setError(null);

        try {
            const t = await getToken();
            if (!t) throw new Error('Not authenticated');

            const res = await fetch(`/api/admin/hierarchy/users?chapterId=${chapterId}`, {
                headers: { Authorization: `Bearer ${t}` }
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const errorDetail = err.details ? ` (${err.details})` : '';
                throw new Error((err.error || `Error: ${res.status}`) + errorDetail);
            }

            if (id !== fetchIdRef.current) return;

            const data = await res.json();
            const users = Array.isArray(data.users) ? data.users : [];
            setRawUsers(users);

            // Validate and build graph data
            const userIds = new Set<string>(users.map((u: any) => u.id).filter(Boolean));
            const validNodes = validateNodes(users);
            const validEdges = validateEdges(users, userIds);

            const layout = getLayoutedElements(validNodes, validEdges);
            setNodes(layout.nodes as any);
            setEdges(layout.edges as any);
            setSelectedIds(new Set());

        } catch (e: any) {
            if (id === fetchIdRef.current) {
                const msg = e.message || 'Failed to load';
                setError(msg);
                showErrorToast(msg);
            }
        } finally {
            if (id === fetchIdRef.current) setLoading(false);
        }
    }, [chapterId, setNodes, setEdges, showErrorToast]);

    useEffect(() => { if (chapterId) fetchData(); }, [chapterId, fetchData]);

    // Zoom to node
    const handleFocusNode = useCallback((nodeId: string) => {
        const node = getNode(nodeId);
        if (!node) return;
        setHighlightedNode(nodeId);
        setCenter(node.position.x + nodeWidth / 2, node.position.y + nodeHeight / 2, { zoom: 1.5, duration: 500 });
        setTimeout(() => setHighlightedNode(null), 5000);
    }, [getNode, setCenter]);

    // Update styling
    useEffect(() => {
        setNodes((nds: Node[]) => nds.map((n: Node) => ({
            ...n,
            data: { ...n.data, isSelected: selectedIds.has(n.id), isHighlighted: n.id === highlightedNode },
            selected: selectedIds.has(n.id),
        })) as any);
    }, [selectedIds, highlightedNode, setNodes]);

    // Filter
    useEffect(() => {
        if (!filterQuery) {
            setNodes((nds: Node[]) => nds.map((n: Node) => ({ ...n, style: { ...n.style, opacity: 1 } })) as any);
            return;
        }
        const q = filterQuery.toLowerCase();
        setNodes((nds: Node[]) => nds.map((n: Node) => {
            const match = ((n.data.label as string) || '').toLowerCase().includes(q) ||
                ((n.data.email as string) || '').toLowerCase().includes(q);
            return { ...n, style: { ...n.style, opacity: match ? 1 : 0.15 } };
        }) as any);
    }, [filterQuery, setNodes]);

    // Keyboard
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { setSelectedIds(new Set()); setHighlightedNode(null); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); setSelectedIds(new Set(nodes.map((n: any) => n.id))); }
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [nodes]);

    // Add relationship
    const addRelationship = useCallback(async (subordinateId: string, managerId: string, type: 'direct' | 'dotted') => {
        if (!subordinateId || !managerId) return;

        const edgeId = `e-${managerId}-${subordinateId}-${type}`;

        // Optimistic add
        const newEdge: Edge = {
            id: edgeId,
            source: managerId,
            target: subordinateId,
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: type === 'dotted' ? '#f59e0b' : '#22c55e' },
            style: getEdgeStyle(type),
            data: { relationType: type }
        };

        setEdges((eds: Edge[]) => [...eds, newEdge] as any);
        setNodes((nds: Node[]) => nds.map((n: Node) =>
            n.id === subordinateId
                ? { ...n, data: { ...n.data, managerCount: ((n.data.managerCount as number) || 0) + 1 } }
                : n
        ) as any);

        setSaveStatus('saving');

        try {
            const t = await getToken();
            if (!t) throw new Error('Not authenticated');

            const r = await apiCall('/api/admin/hierarchy/relationships', {
                method: 'POST',
                headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ subordinateId, managerId, type })
            });

            const result = await r.json();

            if (!r.ok) {
                throw new Error(result.error || 'Failed to add relationship');
            }

            setSaveStatus('saved');
            showSuccessToast(type === 'dotted' ? 'Added dotted-line report' : 'Added direct report');
            setTimeout(() => setSaveStatus('idle'), 2000);

        } catch (e: any) {
            // Rollback
            setEdges((eds: Edge[]) => eds.filter((ed: Edge) => ed.id !== edgeId) as any);
            setNodes((nds: Node[]) => nds.map((n: Node) =>
                n.id === subordinateId
                    ? { ...n, data: { ...n.data, managerCount: Math.max(0, ((n.data.managerCount as number) || 1) - 1) } }
                    : n
            ) as any);
            setSaveStatus('error');
            showErrorToast(e.message || 'Failed to add relationship');
        }
    }, [setEdges, setNodes, showSuccessToast, showErrorToast]);

    // On connect
    const onConnect: OnConnect = useCallback((c: Connection) => {
        if (!c.source || !c.target || c.source === c.target) return;

        // Check duplicate
        const existing = edges.find((e: Edge) => e.source === c.source && e.target === c.target);
        if (existing) {
            showErrorToast('Relationship already exists');
            return;
        }

        // Check if has existing managers
        const existingManagerEdges = edges.filter((e: Edge) => e.target === c.target);

        if (existingManagerEdges.length === 0) {
            addRelationship(c.target, c.source, 'direct');
        } else {
            const sourceUser = rawUsers.find(u => u.id === c.source);
            const targetUser = rawUsers.find(u => u.id === c.target);
            setPendingConnection({
                source: c.source,
                target: c.target,
                sourceName: sourceUser?.displayName || 'Manager',
                targetName: targetUser?.displayName || 'Person'
            });
            setTypeDialogOpen(true);
        }
    }, [edges, rawUsers, addRelationship, showErrorToast]);

    const handleTypeSelect = useCallback((type: 'direct' | 'dotted') => {
        if (pendingConnection) {
            addRelationship(pendingConnection.target, pendingConnection.source, type);
        }
        setTypeDialogOpen(false);
        setPendingConnection(null);
    }, [pendingConnection, addRelationship]);

    // State for delete edge confirmation
    const [pendingEdgeDelete, setPendingEdgeDelete] = useState<{ edge: Edge; subordinateId: string; managerId: string } | null>(null);
    const [deletingEdge, setDeletingEdge] = useState(false);

    // Edge click - show confirmation
    const onEdgeClick = useCallback((_: React.MouseEvent, e: Edge) => {
        const subordinateId = e.target;
        const managerId = e.source;
        const subordinateUser = rawUsers.find(u => u.id === subordinateId);
        const managerUser = rawUsers.find(u => u.id === managerId);

        // Confirm before delete
        console.log('[Hierarchy] Edge click - preparing to delete:', { subordinateId, managerId });
        setPendingEdgeDelete({ edge: e, subordinateId, managerId });
    }, [rawUsers]);

    // Actually delete the edge - ONLY after confirmation
    const confirmDeleteEdge = useCallback(async () => {
        if (!pendingEdgeDelete) return;

        const { edge, subordinateId, managerId } = pendingEdgeDelete;
        setDeletingEdge(true);
        setSaveStatus('saving');

        console.log('[Hierarchy] Deleting edge (server-first):', { subordinateId, managerId });

        try {
            const t = await getToken();
            if (!t) throw new Error('Not authenticated');

            const r = await apiCall('/api/admin/hierarchy/relationships', {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ subordinateId, managerId })
            });

            const result = await r.json().catch(() => ({}));
            console.log('[Hierarchy] DELETE response:', { ok: r.ok, status: r.status, result });

            if (!r.ok) {
                throw new Error(result.error || `Server error: ${r.status}`);
            }

            // SUCCESS - NOW update UI (server-confirmed)
            setEdges((eds: Edge[]) => eds.filter((ed: Edge) => ed.id !== edge.id) as any);
            setNodes((nds: Node[]) => nds.map((n: Node) =>
                n.id === subordinateId
                    ? { ...n, data: { ...n.data, managerCount: Math.max(0, ((n.data.managerCount as number) || 1) - 1) } }
                    : n
            ) as any);

            setSaveStatus('saved');
            showSuccessToast('Relationship removed permanently');
            console.log('[Hierarchy] Edge deleted successfully, UI updated');
            setTimeout(() => setSaveStatus('idle'), 2000);

        } catch (err: any) {
            // FAILURE - Don't touch UI, edge stays
            console.error('[Hierarchy] DELETE FAILED:', err);
            setSaveStatus('error');
            showErrorToast(`Failed to remove: ${err.message || 'Unknown error'}`);
        } finally {
            setDeletingEdge(false);
            setPendingEdgeDelete(null);
        }
    }, [pendingEdgeDelete, setEdges, setNodes, showSuccessToast, showErrorToast]);

    const cancelDeleteEdge = useCallback(() => {
        setPendingEdgeDelete(null);
    }, []);

    // Node interactions
    const onNodeClick = useCallback((e: React.MouseEvent, n: Node) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            setSelectedIds(p => { const x = new Set(p); x.has(n.id) ? x.delete(n.id) : x.add(n.id); return x; });
        } else {
            setSelectedIds(new Set([n.id]));
        }
    }, []);

    const onNodeContextMenu: NodeMouseHandler = useCallback((e, n) => {
        e.preventDefault();
        setSelectedPerson({ id: n.id, displayName: (n.data.label as string) || 'Unknown' });
        setDeleteDialogOpen(true);
    }, []);

    const onSelectionChange = useCallback(({ nodes: sn }: { nodes: Node[] }) => {
        if (sn.length > 0) setSelectedIds(new Set(sn.map((n: Node) => n.id)));
    }, []);

    // Add existing user
    const handleAddExistingUser = useCallback((user: any) => {
        if (!user || !user.id) return;
        const exists = nodes.find((n: Node) => n.id === user.id);
        if (exists) { handleFocusNode(user.id); return; }

        const newNode: Node = {
            id: user.id,
            type: 'userNode',
            data: { ...user, label: user.displayName || user.email, isSelected: false, isHighlighted: true, managerCount: 0 },
            position: { x: 200, y: 50 }
        };

        setNodes((nds: Node[]) => {
            const updated = [...nds, newNode];
            const layout = getLayoutedElements(updated, edges);
            return layout.nodes as any;
        });
        setRawUsers(prev => [...prev, user]);
        setHighlightedNode(user.id);
        setTimeout(() => { handleFocusNode(user.id); setTimeout(() => setHighlightedNode(null), 5000); }, 100);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
    }, [nodes, edges, setNodes, handleFocusNode]);

    // Add new person
    const handleAddNewPerson = useCallback((p: any) => {
        if (!p) return;
        const id = p.id || `temp-${Date.now()}`;
        const nn: Node = {
            id,
            type: 'userNode',
            data: { ...p, label: p.displayName || p.email, isSelected: false, isHighlighted: true, managerCount: p.managerId ? 1 : 0 },
            position: { x: 200, y: 50 }
        };

        setNodes((nds: Node[]) => {
            const u = [...nds, nn];
            const layout = getLayoutedElements(u, edges);
            return layout.nodes as any;
        });

        if (p.managerId) {
            const newEdge: Edge = {
                id: `e-${p.managerId}-${id}-direct`,
                source: p.managerId,
                target: id,
                type: 'smoothstep',
                markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: '#22c55e' },
                style: getEdgeStyle('direct'),
                data: { relationType: 'direct' }
            };
            setEdges((eds: Edge[]) => [...eds, newEdge] as any);
        }

        setRawUsers(prev => [...prev, { ...p, id }]);
        setHighlightedNode(id);
        setTimeout(() => setHighlightedNode(null), 5000);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
    }, [edges, setNodes, setEdges]);

    // Delete person
    const handleDeletePerson = useCallback(async () => {
        if (!selectedPerson) return;
        const uid = selectedPerson.id;
        const pn = [...nodes], pe = [...edges], pu = [...rawUsers];

        setNodes((nds: Node[]) => nds.filter((n: Node) => n.id !== uid) as any);
        setEdges((eds: Edge[]) => eds.filter((e: Edge) => e.source !== uid && e.target !== uid) as any);
        setRawUsers(p => p.filter(u => u.id !== uid));
        setDeleteDialogOpen(false);
        setSelectedIds(p => { const x = new Set(p); x.delete(uid); return x; });

        setSaveStatus('saving');

        try {
            const t = await getToken();
            if (!t) throw new Error('Not authenticated');

            const r = await apiCall('/api/admin/hierarchy/user', {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: uid })
            });

            if (!r.ok) {
                const result = await r.json();
                throw new Error(result.error || 'Failed');
            }

            setSaveStatus('saved');
            showSuccessToast('Removed');
            setTimeout(() => setSaveStatus('idle'), 2000);

        } catch (e: any) {
            setNodes(pn as any);
            setEdges(pe as any);
            setRawUsers(pu);
            setSaveStatus('error');
            showErrorToast(e.message || 'Failed');
        }
    }, [selectedPerson, nodes, edges, rawUsers, setNodes, setEdges, showSuccessToast, showErrorToast]);

    // Bulk ops
    const handleBulkReassign = useCallback(async (mid: string | null) => {
        if (!mid) return;
        const ids = Array.from(selectedIds);
        for (const uid of ids) {
            await addRelationship(uid, mid, 'direct');
        }
        setSelectedIds(new Set());
    }, [selectedIds, addRelationship]);

    const handleBulkDisconnect = useCallback(async () => {
        const ids = Array.from(selectedIds);
        const toRemove = edges.filter((e: Edge) => ids.includes(e.target));

        for (const edge of toRemove) {
            setEdges((eds: Edge[]) => eds.filter((ed: Edge) => ed.id !== edge.id) as any);
            try {
                const t = await getToken();
                if (t) {
                    await apiCall('/api/admin/hierarchy/relationships', {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ subordinateId: edge.target, managerId: edge.source })
                    });
                }
            } catch (e) {
                console.error('Disconnect error:', e);
            }
        }

        showSuccessToast(`Disconnected ${ids.length} people`);
        setSelectedIds(new Set());
    }, [selectedIds, edges, setEdges, showSuccessToast]);

    const handleBulkDelete = useCallback(async () => {
        const ids = Array.from(selectedIds);
        const pn = [...nodes], pe = [...edges], pu = [...rawUsers];

        setNodes((nds: Node[]) => nds.filter((n: Node) => !ids.includes(n.id)) as any);
        setEdges((eds: Edge[]) => eds.filter((e: Edge) => !ids.includes(e.source) && !ids.includes(e.target)) as any);
        setRawUsers(p => p.filter(u => !ids.includes(u.id)));
        setSelectedIds(new Set());

        setSaveStatus('saving');

        try {
            const t = await getToken();
            if (!t) throw new Error('Not authenticated');

            for (const uid of ids) {
                await apiCall('/api/admin/hierarchy/user', {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: uid })
                });
            }

            setSaveStatus('saved');
            showSuccessToast(`Deleted ${ids.length}`);
            setTimeout(() => setSaveStatus('idle'), 2000);

        } catch (e: any) {
            setNodes(pn as any);
            setEdges(pe as any);
            setRawUsers(pu);
            setSaveStatus('error');
            showErrorToast(e.message || 'Failed');
        }
    }, [selectedIds, nodes, edges, rawUsers, setNodes, setEdges, showSuccessToast, showErrorToast]);

    if (loading) {
        return (
            <div className="h-full w-full flex flex-col items-center justify-center space-y-4 bg-slate-950/50 rounded-lg border border-white/10">
                <Loader2 className="h-12 w-12 animate-spin text-primary" />
                <p className="text-muted-foreground">Loading hierarchy...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="h-full w-full flex flex-col items-center justify-center space-y-4 bg-red-950/20 rounded-lg border border-red-500/30">
                <AlertCircle className="h-12 w-12 text-red-400" />
                <p className="text-red-400">{error}</p>
                <Button variant="outline" onClick={fetchData}>Retry</Button>
            </div>
        );
    }

    return (
        <>
            {/* Controls */}
            <div className="absolute top-4 left-4 z-10 flex gap-2 items-start">
                <div className="w-72">
                    <SmartUserSearch
                        chapterId={chapterId}
                        onAddUser={handleAddExistingUser}
                        onCreateNew={(email) => { setAddModalEmail(email || ''); setAddModalOpen(true); }}
                        onFilterChange={setFilterQuery}
                        onFocusNode={handleFocusNode}
                    />
                </div>
                <Button size="icon" variant="outline" className="bg-slate-900/90 border-slate-700" onClick={fetchData} title="Refresh">
                    <RefreshCw className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="outline" className="bg-slate-900/90 border-slate-700" onClick={() => fitView({ padding: 0.2, duration: 500 })} title="Fit">
                    <Maximize2 className="h-4 w-4" />
                </Button>
            </div>

            {/* Status */}
            <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
                {saveStatus === 'saving' && <div className="bg-blue-900/80 px-3 py-1.5 rounded-full border border-blue-500/50 text-xs text-blue-300 flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />Saving...</div>}
                {saveStatus === 'saved' && <div className="bg-green-900/80 px-3 py-1.5 rounded-full border border-green-500/50 text-xs text-green-300 flex items-center gap-2"><Check className="h-3 w-3" />Saved</div>}
                {saveStatus === 'error' && <div className="bg-red-900/80 px-3 py-1.5 rounded-full border border-red-500/50 text-xs text-red-300 flex items-center gap-2"><AlertCircle className="h-3 w-3" />Failed</div>}
                <div className="bg-slate-900/90 px-3 py-1.5 rounded-full border border-slate-700 text-xs text-slate-300">{nodes.length} • {edges.length}</div>
            </div>

            {/* Legend */}
            <div className="absolute top-16 right-4 z-10 bg-slate-900/90 px-3 py-2 rounded-lg border border-slate-700 text-xs">
                <div className="flex items-center gap-2 mb-1"><div className="w-6 h-0.5 bg-green-500"></div><span className="text-slate-300">Direct</span></div>
                <div className="flex items-center gap-2"><div className="w-6 h-0.5 border-t-2 border-dashed border-amber-500"></div><span className="text-slate-300">Dotted</span></div>
            </div>

            {/* Bulk Toolbar */}
            <BulkActionToolbar
                selectedCount={selectedIds.size}
                allUsers={rawUsers.filter(u => !selectedIds.has(u.id)).map(u => ({ id: u.id, displayName: u.displayName || u.email }))}
                onClearSelection={() => setSelectedIds(new Set())}
                onReassignManager={handleBulkReassign}
                onDisconnectAll={handleBulkDisconnect}
                onDeleteSelected={handleBulkDelete}
            />

            {nodes.length === 0 ? (
                <div className="h-full w-full flex flex-col items-center justify-center space-y-3">
                    <p className="text-muted-foreground">No users in this chapter</p>
                    <p className="text-xs text-slate-500">Search for existing users or create new ones</p>
                </div>
            ) : (
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onEdgeClick={onEdgeClick}
                    onNodeClick={onNodeClick}
                    onNodeContextMenu={onNodeContextMenu}
                    onSelectionChange={onSelectionChange}
                    nodeTypes={nodeTypes}
                    selectionMode={SelectionMode.Partial}
                    selectionOnDrag
                    panOnDrag={[1, 2]}
                    selectNodesOnDrag
                    fitView
                    proOptions={{ hideAttribution: true }}
                    colorMode="dark"
                    connectionLineStyle={{ stroke: '#22c55e', strokeWidth: 2 }}
                    deleteKeyCode={null}
                >
                    <Controls className="!bg-slate-900 !border-slate-700 [&>button]:!bg-slate-800 [&>button]:!border-slate-600" />
                    <MiniMap className="!bg-slate-900 !border-slate-700" nodeColor={(n: any) => highlightedNode === n.id ? '#f59e0b' : selectedIds.has(n.id) ? '#22c55e' : '#475569'} />
                    <Background gap={20} size={1} color="#334155" className="opacity-30" />
                </ReactFlow>
            )}

            <div className="absolute bottom-4 left-4 z-10 bg-slate-900/90 px-3 py-2 rounded-lg border border-slate-700 text-xs text-slate-400">
                <strong className="text-white">Drag</strong> to add manager • <strong className="text-white">Click edge</strong> to remove • <strong className="text-amber-400">Multiple managers</strong> supported
            </div>

            {/* Dialogs */}
            <AddPersonModal
                open={addModalOpen}
                onOpenChange={setAddModalOpen}
                chapterId={chapterId}
                existingUsers={rawUsers.filter(u => u.id).map(u => ({ id: u.id, displayName: u.displayName || u.email || u.id }))}
                onSuccess={(p) => { setAddModalOpen(false); if (p) handleAddNewPerson(p); }}
                initialEmail={addModalEmail}
            />
            <DeletePersonDialog
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
                person={selectedPerson}
                onSuccess={handleDeletePerson}
            />
            <RelationshipTypeDialog
                open={typeDialogOpen}
                onOpenChange={setTypeDialogOpen}
                subordinateName={pendingConnection?.targetName || ''}
                managerName={pendingConnection?.sourceName || ''}
                onSelect={handleTypeSelect}
            />

            {/* Edge Delete Confirmation */}
            <AlertDialog open={!!pendingEdgeDelete} onOpenChange={(open) => !open && cancelDeleteEdge()}>
                <AlertDialogContent className="bg-slate-900 border-slate-700 text-white">
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2 text-red-400">
                            <Trash2 className="h-5 w-5" /> Remove Reporting Relationship?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-slate-400">
                            This will permanently remove the reporting relationship. The change will take effect immediately.
                        </AlertDialogDescription>
                        {pendingEdgeDelete && (
                            <div className="mt-3 p-3 bg-slate-800/50 rounded-lg text-sm">
                                <strong className="text-white">
                                    {rawUsers.find(u => u.id === pendingEdgeDelete.subordinateId)?.displayName || 'User'}
                                </strong>
                                <span className="mx-2">→</span>
                                <strong className="text-white">
                                    {rawUsers.find(u => u.id === pendingEdgeDelete.managerId)?.displayName || 'Manager'}
                                </strong>
                            </div>
                        )}
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel className="bg-slate-800 border-slate-700 text-white hover:bg-slate-700" disabled={deletingEdge}>
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={confirmDeleteEdge}
                            className="bg-red-600 hover:bg-red-500 text-white"
                            disabled={deletingEdge}
                        >
                            {deletingEdge ? (
                                <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Removing...
                                </>
                            ) : (
                                <>
                                    <Trash2 className="h-4 w-4 mr-2" /> Remove Permanently
                                </>
                            )}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

export default function HierarchyCanvas({ chapterId }: { chapterId: string }) {
    const [retryKey, setRetryKey] = useState(0);

    return (
        <div className="relative h-full w-full bg-slate-950 rounded-lg overflow-hidden border border-white/10">
            <ErrorBoundary key={retryKey} onRetry={() => setRetryKey(k => k + 1)}>
                <ReactFlowProvider>
                    <HierarchyCanvasInner chapterId={chapterId} />
                </ReactFlowProvider>
            </ErrorBoundary>
        </div>
    );
}
