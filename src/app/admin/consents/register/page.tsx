import { redirect } from 'next/navigation';

/**
 * The Register of Consents is now the "Register" tab of the Consents
 * hub (/admin/consents). This route stays alive as a redirect so the
 * Register's address - the one plausibly cited from minutes and audit
 * references - keeps working.
 */
export default function RegisterOfConsentsRedirect() {
  redirect('/admin/consents?tab=register');
}
