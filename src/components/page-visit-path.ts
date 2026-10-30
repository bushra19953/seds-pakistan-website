/**
 * Collapse a raw pathname to the path PageVisitTracker reports.
 *
 * The tracker used to send the RAW pathname, and the track route
 * mints one pageVisits doc per distinct path — so every blog slug,
 * mission id, ticket code and bot-invented URL grew the collection
 * forever (read-bleed census 21). Paths under a known dynamic route
 * now collapse to the route pattern (e.g. /blog/:slug), so the
 * collection holds one doc per route instead of one per entity.
 *
 * Static paths, and static children of a dynamic parent (e.g.
 * /blog/new, /events/register), are returned unchanged. Deeper
 * segments under a dynamic segment are dropped: the visit counts
 * toward the entity page itself (/missions/:id/submit/2 counts as
 * /missions/:id).
 */

interface DynamicParent {
  /** Static segments before the dynamic one. */
  prefix: string[];
  /** Placeholder name for the dynamic segment. */
  param: string;
  /** First-segment values that are static pages, not dynamic ids. */
  except?: string[];
}

// Longest prefixes first so e.g. /events/ticket/:ticketId wins
// over /events/:slug.
const DYNAMIC_PARENTS: DynamicParent[] = [
  { prefix: ['events', 'ticket'], param: 'ticketId' },
  { prefix: ['verify', 'ticket'], param: 'ticketId' },
  { prefix: ['profile', 'unified'], param: 'uid' },
  { prefix: ['profile', 'discipline'], param: 'caseId' },
  { prefix: ['admin', 'blogs', 'edit'], param: 'id' },
  { prefix: ['admin', 'events', 'edit'], param: 'id' },
  { prefix: ['admin', 'resources', 'edit'], param: 'id' },
  { prefix: ['admin', 'compliance', 'obligations'], param: 'id' },
  { prefix: ['admin', 'agm'], param: 'id' },
  { prefix: ['admin', 'cadetships'], param: 'id' },
  { prefix: ['admin', 'circular-resolutions'], param: 'resolutionId' },
  { prefix: ['admin', 'consents'], param: 'id' },
  { prefix: ['admin', 'discipline'], param: 'caseId' },
  { prefix: ['admin', 'elections'], param: 'electionId' },
  { prefix: ['admin', 'events'], param: 'id' },
  { prefix: ['missions'], param: 'id' },
  { prefix: ['blog'], param: 'slug', except: ['new', 'post'] },
  { prefix: ['events'], param: 'slug', except: ['detail', 'new', 'register', 'ticket'] },
  { prefix: ['tasks'], param: 'taskId' },
  { prefix: ['skills'], param: 'skillSlug' },
  { prefix: ['u'], param: 'username' },
  { prefix: ['agm'], param: 'agmId' },
  { prefix: ['elections'], param: 'electionId' },
  { prefix: ['meetings'], param: 'meetingId' },
  { prefix: ['verify'], param: 'code' },
  { prefix: ['verify-appointment'], param: 'code' },
];

export function collapseDynamicPath(pathname: string): string {
  if (!pathname || pathname === '/') return pathname;
  const segments = pathname.split('/').filter(Boolean);
  for (const { prefix, param, except } of DYNAMIC_PARENTS) {
    if (segments.length <= prefix.length) continue;
    if (!prefix.every((seg, i) => segments[i] === seg)) continue;
    const dynamicSegment = segments[prefix.length];
    if (except && except.includes(dynamicSegment)) return pathname;
    return '/' + [...prefix, `:${param}`].join('/');
  }
  return pathname;
}
