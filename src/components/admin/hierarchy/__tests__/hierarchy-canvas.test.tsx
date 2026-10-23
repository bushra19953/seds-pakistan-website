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
import { render, waitFor, act, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@xyflow/react/dist/style.css', () => ({}));

jest.mock('@xyflow/react', () => {
    const ReactLocal = require('react');
    const registry = {
        nodes: [] as any[],
        setCenterCalls: [] as any[],
        props: null as any,
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
            registry.props = props;
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

// The registry hook's data source (contracts.md Section 4.2 client
// adapter): serves the one shared fixture definition.
jest.mock('@/lib/role-definitions', () => {
    const { POSTER_DEF } = require('./custom-role-fixture');
    return {
        getCustomRoleDefinitions: jest.fn(async () => [POSTER_DEF]),
    };
});
jest.mock('@/components/admin/hierarchy/add-person-modal', () => ({ AddPersonModal: () => null }));
jest.mock('@/components/admin/hierarchy/depart-person-dialog', () => ({ DepartPersonDialog: () => null }));
jest.mock('@/components/admin/hierarchy/bulk-action-toolbar', () => ({ BulkActionToolbar: () => null }));
jest.mock('@/components/admin/hierarchy/smart-user-search', () => ({ SmartUserSearch: () => null }));
jest.mock('@/components/admin/hierarchy/relationship-type-dialog', () => ({ RelationshipTypeDialog: () => null }));

import HierarchyCanvas from '../hierarchy-canvas';
import { getCustomRoleDefinitions } from '@/lib/role-definitions';
import { __setCustomRoleDefinitionsForTests } from '@/lib/custom-role-sync';
import {
    POSTER_DEF,
    CUSTOM_USER,
    UNKNOWN_USER,
    CUSTOM_ROLE_NAME,
    CUSTOM_ROLE_SLUG,
} from './custom-role-fixture';

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

describe('HierarchyCanvas custom roles (Custom Roles consumers, Surface 4)', () => {
    // Same fixture people as the clusters suite (shared module), minus
    // chapterId: this suite's API fixtures carry none (server filters).
    const stripChapter = ({ chapterId, ...rest }: any) => rest;
    const CUSTOM_CANVAS_USERS = [
        { id: 'u-boss', displayName: 'Chapter Boss', email: 'boss@example.com', role: 'chapter_president' },
        stripChapter(CUSTOM_USER),
        stripChapter(UNKNOWN_USER),
    ];

    beforeEach(() => {
        (getCustomRoleDefinitions as jest.Mock).mockImplementation(async () => [POSTER_DEF]);
        __setCustomRoleDefinitionsForTests([POSTER_DEF]);
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ users: CUSTOM_CANVAS_USERS }),
        })) as any;
    });

    afterEach(() => {
        __setCustomRoleDefinitionsForTests(null);
    });

    async function renderCustomCanvas() {
        const utils = render(<HierarchyCanvas chapterId="ist-chapter" focusRequest={null} />);
        await waitFor(() => expect(registry.nodes.length).toBe(CUSTOM_CANVAS_USERS.length));
        return utils;
    }

    it('node data for a custom-primary user carries the definition title and the custom flag', async () => {
        await renderCustomCanvas();
        const node = nodeById('u-custom');
        expect(node).toBeDefined();
        expect(node.data.role).toBe(CUSTOM_ROLE_SLUG);
        expect(node.data.roleTitle).toBe(CUSTOM_ROLE_NAME);
        expect(node.data.isCustomRole).toBe(true);
    });

    it('catalog and unknown nodes gain no custom title (rendering unchanged)', async () => {
        await renderCustomCanvas();
        expect(nodeById('u-boss').data.roleTitle).toBeUndefined();
        expect(nodeById('u-boss').data.isCustomRole).toBeFalsy();
        expect(nodeById('u-unknown').data.roleTitle).toBeUndefined();
        expect(nodeById('u-unknown').data.isCustomRole).toBeFalsy();
    });

    it('the detail panel shows the identical title string as the node data, plus the marker', async () => {
        await renderCustomCanvas();
        const node = nodeById('u-custom');
        const props = (registry as any).props;
        expect(props?.onNodeClick).toBeDefined();
        act(() => {
            props.onNodeClick({}, node);
        });
        // The panel is the only rendered surface in this suite that can
        // carry the title (the node chip component is mocked out), and
        // its string must equal the node data title character for
        // character (plan section 6.4 three-way consistency, with the
        // clusters suite asserting the same constant for the pill).
        const panelTitle = await screen.findByText(CUSTOM_ROLE_NAME);
        expect(panelTitle).toBeInTheDocument();
        expect(panelTitle.textContent).toBe(nodeById('u-custom').data.roleTitle);
        expect(screen.getByText('Custom')).toBeInTheDocument();
        expect(screen.queryByText('Guest')).toBeNull();
    });
});
