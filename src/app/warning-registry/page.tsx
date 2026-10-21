import { permanentRedirect } from 'next/navigation';

/**
 * /warning-registry - RETIRED by the Phase 2 discipline rebuild
 * (spec E.7 Variant R, the default).
 *
 * The public warning registry is abolished: there is no public list of
 * named members and their sanctions under either variant. The URL
 * answers a permanent redirect (308) to the home page for one release,
 * then the route is removed. Internal records live behind the
 * authenticated performance-records view (Variant I) and the admin
 * discipline queue.
 */
export default function WarningRegistryPage() {
  permanentRedirect('/');
}
