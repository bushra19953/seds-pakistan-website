import React from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * THE custom-role marker (consumers plan section 2; G9 U5, SEC-14).
 * One treatment, reused on every React surface where a custom role
 * renders: the design-system Badge, variant outline, text "Custom"
 * (Badge's base class is already text-xs, satisfying U2; token classes
 * only, U1; static, U7). No surface invents its own marker, colour, or
 * wording. Print (the workflow PDF) uses the text suffix " (custom)"
 * appended to the role line, where a badge cannot render.
 */
export function CustomRoleMarker({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={className}>
      Custom
    </Badge>
  );
}
