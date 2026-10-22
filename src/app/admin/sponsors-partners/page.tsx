import { redirect } from 'next/navigation';

// Sponsors & Partners management lives in the CRM Console (/admin/crm):
// the full organisation form, CSV export, agreement analysis, delete and
// the consent-gated save were ported there. This route is kept only as a
// redirect for old links/bookmarks.
export default function AdminSponsorsPartnersRedirectPage() {
  redirect('/admin/crm');
}
