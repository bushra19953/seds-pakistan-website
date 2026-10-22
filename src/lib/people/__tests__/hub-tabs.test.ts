import { resolvePeopleHubTab, peopleHubTabUrl } from '../hub-tabs';

describe('resolvePeopleHubTab', () => {
  it.each([
    ['roles', 'roles'],
    ['directory', 'directory'],
    ['bogus', 'directory'],
    ['', 'directory'],
    [null, 'directory'],
    [undefined, 'directory'],
  ])('maps %p to %p', (raw, expected) => {
    expect(resolvePeopleHubTab(raw as string | null)).toBe(expected);
  });
});

describe('peopleHubTabUrl', () => {
  it('deep-links the registry tab and keeps the directory on the bare URL', () => {
    expect(peopleHubTabUrl('roles')).toBe('/admin/users?tab=roles');
    expect(peopleHubTabUrl('directory')).toBe('/admin/users');
  });
});
