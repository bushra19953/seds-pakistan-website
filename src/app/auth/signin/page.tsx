import { permanentRedirect } from 'next/navigation';

// Legacy sign-in alias. /auth/login is the canonical sign-in route.
// Any ?redirect= parameter is preserved across the hop.
export default function SignInRedirectPage({
  searchParams,
}: {
  searchParams: { redirect?: string };
}) {
  const target = searchParams?.redirect
    ? `/auth/login?redirect=${encodeURIComponent(searchParams.redirect)}`
    : '/auth/login';
  permanentRedirect(target);
}
