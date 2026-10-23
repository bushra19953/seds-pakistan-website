/**
 * HierarchyCanvas: Issue 6 (Vacant label) + Issue 7 (focusRequest).
 *
 * ReactFlow is mocked with a state-backed stand-in: useNodesState /
 * useEdgesState are plain useState, the ReactFlow component records the
 * nodes it is handed in a registry, and useReactFlow reads that registry
 * for getNode and records setCenter calls. That makes the two behaviors
 * under test observable without a real canvas layout:
 *   - node data.label produced by validateNodes after a data load
 *   - setCenter / highlight, which is exactly what handleFocusNode does
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@xyflow/react/dist/style.css', () => ({}));

jest.mock('@xyflow/react', () => {
    const ReactLocal = require('react');
    const registry = {
        nodes: [] as any[],
        setCenterCalls: [] as any[],
    };
    const setCenter = jest.fn((...args: any[]) => {
        registry.setCenterCalls.push(args);
    });
    const useStateBacked = (initial: any) => {
        const [value, setValue] = ReactLocal.useState(initial);
        return [value, setValue, () => {}];
    };
    return {
        __registry: registry,
        __setCenter: setCenter,
        ReactFlow: (props: any) => {
            registry.nodes = props.nodes;
            return ReactLocal.createElement('div', { 'data-testid': 'react-flow' }, props.children);
        },
        ReactFlowProvider: (props: any) => ReactLocal.createElement(ReactLocal.Fragment, null, props.children),
        MiniMap: () => null,
        Controls: () => null,
        Background: () => null,
        useNodesState: useStateBacked,
        useEdgesState: useStateBacked,
        useReactFlow: () => ({
            fitView: jest.fn(),
            setCenter,
            getNode: (id: string) => registry.nodes.find((n: any) => n.id === id),
        }),
        MarkerType: { ArrowClosed: 'arrowclosed' },
        Position: { Top: 'top', Bottom: 'bottom' },
        SelectionMode: { Partial: 'partial' },
    };
});

jest.mock('firebase/auth', () => ({
    getAuth: () => ({ currentUser: { getIdToken: async () => 'test-token' } }),
}));

jest.mock('@/hooks/use-enhanced-toast', () => {
    // Stable identities: fetchData depends on these, so a fresh object per
    // render would retrigger the load effect forever.
    const showErrorToast = jest.fn();
    const showSuccessToast = jest.fn();
    return { useEnhancedToast: () => ({ showErrorToast, showSuccessToast }) };
});

jest.mock('@/components/ui/button', () => ({
    Button: (props: any) => React.createElement('button', props, props.children),
}));

jest.mock('@/components/ui/alert-dialog', () => ({
    AlertDialog: () => null,
    AlertDialogAction: () => null,
    AlertDialogCancel: () => null,
    AlertDialogContent: () => null,
    AlertDialogDescription: () => null,
    AlertDialogFooter: () => null,
    AlertDialogHeader: () => null,
    AlertDialogTitle: () => null,
}));

jest.mock('@/components/admin/hierarchy/user-node', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/admin/hierarchy/add-person-modal', () => ({ AddPersonModal: () => null }));
jest.mock('@/components/admin/hierarchy/depart-person-dialog', () => ({ DepartPersonDialog: () => null }));
jest.mock('@/components/admin/hierarchy/bulk-action-toolbar', () => ({ BulkActionToolbar: () => null }));
jest.mock('@/components/admin/hierarchy/smart-user-search', () => ({ SmartUserSearch: () => null }));
jest.mock('@/components/admin/hierarchy/relationship-type-dialog', () => ({ RelationshipTypeDialog: () => null }));

import HierarchyCanvas from '../hierarchy-canvas';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const xyflow = require('@xyflow/react');
const registry = xyflow.__registry as { nodes: any[]; setCenterCalls: any[] };
const mockSetCenter = xyflow.__setCenter as jest.Mock;

const USERS = [
    { id: 'u-boss', displayName: 'Chapter Boss', email: 'boss@example.com', role: 'chapter_president' },
    { id: 'u-noname', email: 'noname@example.com', role: 'member' },
    { id: 'u-blank', displayName: '   ', email: 'blank@example.com', role: 'member' },
];

beforeEach(() => {
    jest.clearAllMocks();
    registry.nodes = [];
    registry.setCenterCalls = [];
    global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ users: USERS }),
    })) as any;
});

const nodeById = (id: string) => registry.nodes.find((n: any) => n.id === id);

async function renderAndLoad(focusRequest: any = null) {
    const utils = render(<HierarchyCanvas chapterId="ist-chapter" focusRequest={focusRequest} />);
    await waitFor(() => expect(registry.nodes.length).toBe(USERS.length));
    return utils;
}

describe('HierarchyCanvas Issue 6: vacant seat label', () => {
    it('labels users without a displayName as "Vacant", never their email', async () => {
        await renderAndLoad();

        expect(nodeById('u-boss').data.label).toBe('Chapter Boss');
        expect(nodeById('u-noname').data.label).toBe('Vacant');
        expect(nodeById('u-blank').data.label).toBe('Vacant');
        // The email stays in the node data; it just is not the display name.
        expect(nodeById('u-noname').data.email).toBe('noname@example.com');
    });
});

describe('HierarchyCanvas Issue 7: focusRequest consumption', () => {
    it('centers and highlights the requested node, once per nonce, and ignores unknown uids', async () => {
        const { rerender } = await renderAndLoad(null);
        expect(mockSetCenter).not.toHaveBeenCalled();

        rerender(<HierarchyCanvas chapterId="ist-chapter" focusRequest={{ uid: 'u-boss', nonce: 1 }} />);
        await waitFor(() => expect(mockSetCenter).toHaveBeenCalledTimes(1));

        const boss = nodeById('u-boss');
        expect(registry.setCenterCalls[0]).toEqual([
            boss.position.x + 140,
            boss.position.y + 40,
            { zoom: 1.5, duration: 500 },
        ]);
        await waitFor(() => expect(nodeById('u-boss').data.isHighlighted).toBe(true));

        // Same nonce again: no second focus.
        rerender(<HierarchyCanvas chapterId="ist-chapter" focusRequest={{ uid: 'u-boss', nonce: 1 }} />);
        expect(mockSetCenter).toHaveBeenCalledTimes(1);

        // A uid that is not in this chapter: silent no-op.
        rerender(<HierarchyCanvas chapterId="ist-chapter" focusRequest={{ uid: 'u-elsewhere', nonce: 2 }} />);
        expect(mockSetCenter).toHaveBeenCalledTimes(1);

        // A fresh nonce for the same person focuses again.
        rerender(<HierarchyCanvas chapterId="ist-chapter" focusRequest={{ uid: 'u-boss', nonce: 3 }} />);
        await waitFor(() => expect(mockSetCenter).toHaveBeenCalledTimes(2));
    });
});
