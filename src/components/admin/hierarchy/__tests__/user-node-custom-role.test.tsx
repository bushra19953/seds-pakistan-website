/**
 * UserNode role line (Custom Roles consumers, Surface 4): the canvas
 * node chip renders data.roleTitle with the Custom marker when the
 * canvas resolved a custom role (plan Surface 4 change 3); without a
 * resolved title it keeps today's rendering exactly (catalog title
 * from USER_ROLES, humanised slug for unknown tokens).
 *
 * Together with the clusters and canvas suites, this file completes
 * the three-way consistency set against the shared fixture in
 * ./custom-role-fixture: pill == node chip == detail panel.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));

import UserNode from '@/components/admin/hierarchy/user-node';
import { CUSTOM_ROLE_NAME, CUSTOM_ROLE_SLUG } from './custom-role-fixture';

// The component uses the classic JSX runtime, so React must be in
// global scope at render time (same pattern as the clusters suite).
(global as any).React = React;

function renderNode(data: Record<string, any>) {
  return render(<UserNode {...({ id: 'n1', data, selected: false } as any)} />);
}

describe('UserNode custom role line (Surface 4)', () => {
  it('renders the resolved definition title and the Custom marker for a custom node', () => {
    renderNode({
      label: 'Custom Person',
      role: CUSTOM_ROLE_SLUG,
      roleTitle: CUSTOM_ROLE_NAME,
      isCustomRole: true,
      email: 'custom@example.com',
    });
    expect(screen.getByText(CUSTOM_ROLE_NAME)).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    // The pre-fix rendering of this slug was the humanised whole slug;
    // it must not survive anywhere on the node.
    expect(screen.queryByText('Custom Poster Team Lead')).toBeNull();
  });

  it('a catalog node renders its catalog title and no marker (unchanged)', () => {
    renderNode({ label: 'Chapter Boss', role: 'chapter_president', email: 'boss@example.com' });
    expect(screen.getByText('Chapter President')).toBeInTheDocument();
    expect(screen.queryByText('Custom')).toBeNull();
  });

  it('an unknown non-custom token keeps the humanised fallback (unchanged)', () => {
    renderNode({ label: 'Unknown Person', role: 'team_member', email: 'unknown@example.com' });
    expect(screen.getByText('Team Member')).toBeInTheDocument();
    expect(screen.queryByText('Custom')).toBeNull();
  });
});
