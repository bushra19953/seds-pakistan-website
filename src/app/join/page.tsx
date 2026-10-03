import { redirect } from 'next/navigation';

export default function JoinPage() {
  // Alias `/join` to the induction stepper at step 1
  redirect('/induction?step=1');
}
