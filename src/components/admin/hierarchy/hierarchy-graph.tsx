"use client";

import React, { useCallback, useMemo } from 'react';
import {
    ReactFlow,
    MiniMap,
    Controls,
    Background,
    useNodesState,
    useEdgesState,
    MarkerType,
    Position,
    Node,
    Edge,
    NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { useFirestore } from '@/firebase';
import { useCollection } from '@/firebase/firestore/use-collection';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { collection, query, where, DocumentData } from 'firebase/firestore';
import { USER_ROLES, ROLE_HIERARCHY } from '@/lib/roles';
import { Loader2 } from 'lucide-react';
import UserNode from './user-node';

const nodeWidth = 300;
const nodeHeight = 100;

const nodeTypes: NodeTypes = {
    userNode: UserNode,
};

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'TB') => {
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));

    dagreGraph.setGraph({
        rankdir: direction,
        nodesep: 50,
        ranksep: 100
    });

    nodes.forEach((node) => {
        dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
    });

    edges.forEach((edge) => {
        dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = dagreGraph.node(node.id);
        return {
            ...node,
            targetPosition: direction === 'LR' ? Position.Left : Position.Top,
            sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
            position: {
                x: nodeWithPosition.x - nodeWidth / 2,
                y: nodeWithPosition.y - nodeHeight / 2,
            },
        };
    });

    return { nodes: layoutedNodes, edges };
};

export default function HierarchyGraph() {
    const firestore = useFirestore();

    // Fetch Users
    const usersQuery = useMemoFirebase(() => query(collection(firestore, 'users')), [firestore]);
    const { data: users, loading: usersLoading } = useCollection<DocumentData>(usersQuery);

    // Fetch Roles
    const rolesQuery = useMemoFirebase(() => query(collection(firestore, 'roles')), [firestore]);
    const { data: rolesData, loading: rolesLoading } = useCollection<DocumentData>(rolesQuery);

    const { initialNodes, initialEdges } = useMemo(() => {
        if (usersLoading || rolesLoading || !users || !rolesData) {
            return { initialNodes: [], initialEdges: [] };
        }

        const rolesMap = new Map<string, string>();
        rolesData.forEach((r: any) => rolesMap.set(r.id, r.role));

        const nodes: Node[] = [];
        const edges: Edge[] = [];

        // Helper: Find National President / Superadmin
        const nationalPresidents: string[] = [];
        const chapterPresidents: Map<string, string> = new Map(); // chapterId -> uid
        const chapterMembers: Map<string, string[]> = new Map(); // chapterId -> [uids]

        // 1. Build Node Data
        users.forEach((u: any) => {
            const uid = u.id || u.uid;
            const role = rolesMap.get(uid) || 'guest';
            const label = u.displayName || u.email || 'Unknown';
            const photoURL = u.photoURL || '';
            const chapterId = u.chapterId;

            const isSuperAdmin = role === 'superadmin' || role === 'president_national';
            const isChapterPresident = role === 'president_chapter';

            if (isSuperAdmin) nationalPresidents.push(uid);
            if (isChapterPresident && chapterId) chapterPresidents.set(chapterId, uid);

            if (chapterId && !isSuperAdmin && !isChapterPresident) {
                const list = chapterMembers.get(chapterId) || [];
                list.push(uid);
                chapterMembers.set(chapterId, list);
            }

            nodes.push({
                id: uid,
                type: 'userNode', // Use Custom Node
                data: {
                    label,
                    role,
                    photoURL
                },
                position: { x: 0, y: 0 },
            });
        });

        // 2. Build Edges (Inferred Hierarchy)
        // Link Chapter Presidents to National Presidents
        const bossUid = nationalPresidents[0]; // Logic assumes one main boss for visual simplicity

        if (bossUid) {
            chapterPresidents.forEach((cpUid) => {
                edges.push({
                    id: `e-${bossUid}-${cpUid}`,
                    source: bossUid,
                    target: cpUid,
                    type: 'smoothstep',
                    markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
                    animated: true,
                    style: { stroke: '#94a3b8', strokeWidth: 2 },
                });
            });
        }

        // Link Members to their Chapter President
        chapterMembers.forEach((memberUids, chapterId) => {
            const cpUid = chapterPresidents.get(chapterId);
            if (cpUid) {
                memberUids.forEach(mUid => {
                    edges.push({
                        id: `e-${cpUid}-${mUid}`,
                        source: cpUid,
                        target: mUid,
                        type: 'smoothstep',
                        markerEnd: { type: MarkerType.ArrowClosed, color: '#e2e8f0' },
                        style: { stroke: '#e2e8f0', strokeWidth: 1.5 },
                    });
                });
            }
        });

        return { initialNodes: nodes, initialEdges: edges };
    }, [users, rolesData, usersLoading, rolesLoading]);

    // Layout calculation
    const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(() => {
        return getLayoutedElements(initialNodes, initialEdges);
    }, [initialNodes, initialEdges]);

    const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

    React.useEffect(() => {
        setNodes(layoutedNodes);
        setEdges(layoutedEdges);
    }, [layoutedNodes, layoutedEdges, setNodes, setEdges]);

    if (usersLoading || rolesLoading) {
        return <div className="h-96 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
    }

    return (
        <div className="h-[calc(100vh-180px)] w-full border border-border/40 rounded-xl overflow-hidden shadow-inner bg-slate-50 dark:bg-slate-950/50">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={nodeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
            >
                <Controls showInteractive={false} className="!bg-background !border-border !shadow-sm" />
                <MiniMap
                    className="!bg-background !border-border !shadow-sm"
                    nodeColor={(n) => {
                        if (n.data.role === 'superadmin' || n.data.role === 'president_national') return '#2563eb';
                        if (n.data.role === 'president_chapter') return '#16a34a';
                        return '#cbd5e1';
                    }}
                />
                <Background gap={20} size={1} color="#94a3b8" variant={'dots' as any} className="opacity-20" />
            </ReactFlow>
        </div>
    );
}
