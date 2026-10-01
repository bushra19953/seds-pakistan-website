import { redirect } from 'next/navigation';

export default function SignupPage() {
  // Redirect legacy route to canonical auth signup
  redirect('/auth/signup');
}
