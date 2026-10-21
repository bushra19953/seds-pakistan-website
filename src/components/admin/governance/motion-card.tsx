'use client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { MotionView } from '@/lib/governance/meetings-ui';
import { thresholdLabel, motionResultSummary, secretDemandState } from '@/lib/governance/meetings-ui';
export function MotionCard({ motion, canClose, onClose }: { motion: MotionView; canClose?: boolean; onClose?: (id: string) => void }) {
  const secret = secretDemandState(motion);
  return (<Card><CardHeader><CardTitle className="text-base">{motion.text}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
    <div className="flex flex-wrap gap-2"><Badge>{motion.status}</Badge><Badge variant="outline">{motion.method.replace(/_/g, ' ')}</Badge><Badge variant="outline">{thresholdLabel(motion.threshold)}</Badge></div>
    <p>{motionResultSummary(motion)}</p>
    {motion.method === 'secret_ballot' ? <p>Secret ballot. Totals only are shown. No individual choices are visible.</p> : null}
    {secret.demands > 0 ? <p>Secret ballot demands: {secret.demands} of 2 needed to lock.</p> : null}
    {motion.threshold.consentRequired ? <p>Founder Consent required for this decision class.</p> : null}
    {motion.threshold.isReservedMatter ? <p>Reserved Matter.</p> : null}
    {canClose && motion.status === 'open' && onClose ? <Button size="sm" onClick={() => onClose(motion.id)}>Close voting</Button> : null}
  </CardContent></Card>);
}
export default MotionCard;
