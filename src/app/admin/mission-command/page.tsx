import { redirect } from 'next/navigation';

// Mission Command was folded into the admin dashboard as its Live Missions
// section. This route is kept only as a redirect for old links/bookmarks.
export default function MissionCommandRedirectPage() {
  redirect('/admin');
}
