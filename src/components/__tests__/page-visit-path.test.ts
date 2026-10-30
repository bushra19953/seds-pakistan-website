/**
 * @jest-environment node
 *
 * collapseDynamicPath: dynamic route segments collapse to the route
 * pattern so PageVisitTracker stops minting one pageVisits doc per
 * slug/id/code (read-bleed census 21); static paths pass through
 * byte-identically.
 */
import { collapseDynamicPath } from '@/components/page-visit-path';

describe('collapseDynamicPath', () => {
  it('collapses blog slugs, mission ids and other dynamic segments', () => {
    expect(collapseDynamicPath('/blog/my-post-slug')).toBe('/blog/:slug');
    expect(collapseDynamicPath('/missions/wf_1793206249841')).toBe('/missions/:id');
    expect(collapseDynamicPath('/missions/wf_1/submit/3')).toBe('/missions/:id');
    expect(collapseDynamicPath('/events/space-week-2026')).toBe('/events/:slug');
    expect(collapseDynamicPath('/events/ticket/tkt-123')).toBe('/events/ticket/:ticketId');
    expect(collapseDynamicPath('/tasks/task-9')).toBe('/tasks/:taskId');
    expect(collapseDynamicPath('/skills/rocketry')).toBe('/skills/:skillSlug');
    expect(collapseDynamicPath('/u/bushra')).toBe('/u/:username');
    expect(collapseDynamicPath('/profile/unified/uid-1')).toBe('/profile/unified/:uid');
    expect(collapseDynamicPath('/profile/discipline/case-7')).toBe('/profile/discipline/:caseId');
    expect(collapseDynamicPath('/verify/ABC123')).toBe('/verify/:code');
    expect(collapseDynamicPath('/admin/events/evt-1')).toBe('/admin/events/:id');
    expect(collapseDynamicPath('/admin/events/edit/evt-1')).toBe('/admin/events/edit/:id');
    expect(collapseDynamicPath('/admin/discipline/case-2')).toBe('/admin/discipline/:caseId');
  });

  it('leaves static paths and static children unchanged', () => {
    expect(collapseDynamicPath('/')).toBe('/');
    expect(collapseDynamicPath('/about')).toBe('/about');
    expect(collapseDynamicPath('/blog')).toBe('/blog');
    expect(collapseDynamicPath('/blog/new')).toBe('/blog/new');
    expect(collapseDynamicPath('/blog/post')).toBe('/blog/post');
    expect(collapseDynamicPath('/events')).toBe('/events');
    expect(collapseDynamicPath('/events/new')).toBe('/events/new');
    expect(collapseDynamicPath('/events/register')).toBe('/events/register');
    expect(collapseDynamicPath('/events/detail')).toBe('/events/detail');
    expect(collapseDynamicPath('/profile')).toBe('/profile');
    expect(collapseDynamicPath('/profile/leave')).toBe('/profile/leave');
    expect(collapseDynamicPath('/admin/analytics')).toBe('/admin/analytics');
    expect(collapseDynamicPath('/apply/status')).toBe('/apply/status');
  });
});
