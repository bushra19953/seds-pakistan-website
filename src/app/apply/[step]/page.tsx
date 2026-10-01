import { redirect, notFound } from 'next/navigation';

type Params = { step: string };

export default async function ApplyStepPage({ params }: { params: Promise<Params> }) {
  // Expect paths like `/apply/step-1`, `/apply/step-2`, etc.
  const { step } = await params;
  const match = step.match(/^step-(\d+)$/);
  const stepNumber = match ? match[1] : undefined;

  if (!stepNumber) {
    notFound();
  }

  // Route to the existing induction stepper with the correct step
  redirect(`/induction?step=${stepNumber}`);
}
