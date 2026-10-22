import { redirect } from 'next/navigation';

// AI Sponsor Match works on sponsors_partners data, not events, so it now
// lives as the "Sponsor Match" tab of the CRM Console (/admin/crm). This
// route is kept only as a redirect for old links/bookmarks.
export default function SponsorMatchRedirectPage() {
  redirect('/admin/crm?tab=sponsor-match');
}
