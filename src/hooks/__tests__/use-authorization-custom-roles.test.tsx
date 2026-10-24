/**
 * useAuthorization with custom-role grants (RP-03 fix): the hook must
 * evaluate the UNION of the holder's primary role and held custom
 * roles — each slug checked under its own key — so a custom-role
 * grantee is authorized, while a holder of the same primary role
 * WITHOUT the custom role is not (the leak test).
 */

import { renderHook } from '@testing-library/react';
import { useAuthorization } from '@/hooks/use-authorization';
import { hasPermission, injectRoleOverrides } from '@/config/permissions';

const mockState: { context: Record<string, unknown> } = {
  context: {
    role: 'member_basic',
    customRoles: [],
    customAllowedPaths: [],
    allowedPaths: [],
    isLoading: false,
  },
};

jest.mock('@/firebase/user-provider', () => ({
  useUserContext: () => mockState.context,
}));

jest.mock('@/firebase', () => ({
  useFirestore: () => null,
}));

const CUSTOM = 'custom_blog_editor';

beforeAll(() => {
  // The provider's job: a held custom role's definition permissions are
  // injected under the CUSTOM slug only.
  injectRoleOverrides(CUSTOM as never, ['canManageBlogs']);
});

describe('useAuthorization custom-role union', () => {
  it('(a) a holder whose custom role carries canManageBlogs is authorized', () => {
    mockState.context = {
      role: 'member_basic',
      customRoles: [CUSTOM],
      customAllowedPaths: [],
      allowedPaths: [],
      isLoading: false,
    };
    const { result } = renderHook(() => useAuthorization('canManageBlogs'));
    expect(result.current.isAuthorized).toBe(true);
    expect(result.current.role).toBe('member_basic');
  });

  it('(b) LEAK TEST: the same primary role without the custom role is NOT authorized', () => {
    mockState.context = {
      role: 'member_basic',
      customRoles: [],
      customAllowedPaths: [],
      allowedPaths: [],
      isLoading: false,
    };
    const { result } = renderHook(() => useAuthorization('canManageBlogs'));
    expect(result.current.isAuthorized).toBe(false);
    // Attribution at the source: the grant lives on the custom slug,
    // not on the primary role's key.
    expect(hasPermission(CUSTOM as never, 'canManageBlogs')).toBe(true);
    expect(hasPermission('member_basic' as never, 'canManageBlogs')).toBe(false);
  });

  it('(c) a user with no custom roles behaves exactly as before', () => {
    mockState.context = {
      role: 'member_basic',
      customRoles: [],
      customAllowedPaths: [],
      allowedPaths: [],
      isLoading: false,
    };
    // No permission argument: any signed-in role is authorized.
    expect(renderHook(() => useAuthorization()).result.current.isAuthorized).toBe(true);
    // A permission the primary role lacks stays denied.
    expect(
      renderHook(() => useAuthorization('canManageBlogs')).result.current.isAuthorized,
    ).toBe(false);
    // The founder bypass is untouched.
    mockState.context = {
      role: 'founder_patron',
      customRoles: [],
      customAllowedPaths: [],
      allowedPaths: [],
      isLoading: false,
    };
    expect(
      renderHook(() => useAuthorization('canManageRoles')).result.current.isAuthorized,
    ).toBe(true);
  });

  it('(c2) primary-role dynamic grants still work with no custom roles held', () => {
    injectRoleOverrides('chapter_secretary' as never, ['canManageEvents']);
    mockState.context = {
      role: 'chapter_secretary',
      customRoles: [],
      customAllowedPaths: [],
      allowedPaths: [],
      isLoading: false,
    };
    expect(
      renderHook(() => useAuthorization('canManageEvents')).result.current.isAuthorized,
    ).toBe(true);
  });

  it('a custom role can never authorize a Reserved Power', () => {
    injectRoleOverrides('custom_role_manager' as never, ['canManageRoles']);
    mockState.context = {
      role: 'member_basic',
      customRoles: ['custom_role_manager'],
      customAllowedPaths: [],
      allowedPaths: [],
      isLoading: false,
    };
    expect(
      renderHook(() => useAuthorization('canManageRoles')).result.current.isAuthorized,
    ).toBe(false);
  });
});
