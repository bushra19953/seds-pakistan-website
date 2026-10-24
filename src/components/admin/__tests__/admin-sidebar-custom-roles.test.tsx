/**
 * AdminSidebar with custom-role grants (RP-03 fix): a nav item gated
 * by requiredPermission must render for a holder whose CUSTOM role
 * carries the permission, and stay hidden for a holder of the same
 * primary role without it. A custom role's allowedPaths widen the
 * primary role's path filter for this holder only. minRole rank gates
 * are not exercised here: custom roles carry no rank by design.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import AdminSidebar from '@/components/admin/admin-sidebar';
import { injectRoleOverrides } from '@/config/permissions';
import type { AdminNavGroup } from '@/config/admin-nav';

const mockState: { context: Record<string, unknown> } = {
  context: {
    role: 'member_basic',
    allowedPaths: [],
    customRoles: [],
    customAllowedPaths: [],
  },
};

jest.mock('next/navigation', () => ({
  usePathname: () => '/admin',
}));

jest.mock('@/firebase/auth/use-user', () => ({
  useUser: () => mockState.context,
}));

const groups: AdminNavGroup[] = [
  {
    label: 'Content',
    items: [
      { label: 'Blogs', path: '/admin/blog', requiredPermission: 'canManageBlogs' },
    ],
  },
];

const CUSTOM = 'custom_blog_editor';

beforeAll(() => {
  injectRoleOverrides(CUSTOM as never, ['canManageBlogs']);
});

describe('AdminSidebar custom-role union', () => {
  it('shows the Blogs item to a custom-role grantee', () => {
    mockState.context = {
      role: 'member_basic',
      allowedPaths: [],
      customRoles: [CUSTOM],
      customAllowedPaths: [],
    };
    render(<AdminSidebar groups={groups} />);
    expect(screen.getByText('Blogs')).toBeTruthy();
  });

  it('hides the Blogs item from the same primary role without the custom role', () => {
    mockState.context = {
      role: 'member_basic',
      allowedPaths: [],
      customRoles: [],
      customAllowedPaths: [],
    };
    render(<AdminSidebar groups={groups} />);
    expect(screen.queryByText('Blogs')).toBeNull();
  });

  it("a custom role's allowedPaths widen the primary role's path filter for this holder", () => {
    mockState.context = {
      role: 'member_basic',
      allowedPaths: ['/admin'],
      customRoles: [CUSTOM],
      customAllowedPaths: ['/admin/blog'],
    };
    render(<AdminSidebar groups={groups} />);
    expect(screen.getByText('Blogs')).toBeTruthy();
  });

  it('the path filter still hides the item when neither primary nor custom paths include it', () => {
    mockState.context = {
      role: 'member_basic',
      allowedPaths: ['/admin'],
      customRoles: [CUSTOM],
      customAllowedPaths: [],
    };
    render(<AdminSidebar groups={groups} />);
    expect(screen.queryByText('Blogs')).toBeNull();
  });

  it('no-custom behavior is unchanged: a primary-role grant alone shows the item', () => {
    injectRoleOverrides('chapter_secretary' as never, ['canManageBlogs']);
    mockState.context = {
      role: 'chapter_secretary',
      allowedPaths: [],
      customRoles: [],
      customAllowedPaths: [],
    };
    render(<AdminSidebar groups={groups} />);
    expect(screen.getByText('Blogs')).toBeTruthy();
  });
});
