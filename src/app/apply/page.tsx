import { redirect } from 'next/navigation';

export default function ApplyIndexPage() {
  // Alias `/apply` to the existing induction stepper at step 1
  redirect('/induction?step=1');
}
