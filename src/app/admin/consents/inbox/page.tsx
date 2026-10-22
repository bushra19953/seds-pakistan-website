import { redirect } from 'next/navigation';

/**
 * The Founder Inbox is now the "Awaiting Decision" tab of the Consents
 * hub (/admin/consents). This route stays alive as a redirect so
 * bookmarks and older links land on the right tab.
 */
export default function FounderConsentInboxRedirect() {
  redirect('/admin/consents?tab=awaiting');
}
