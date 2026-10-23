import { Badge } from '@/components/ui/badge';

/**
 * THE shared custom-role marker (G9 F1 / U5 - one treatment, reused).
 *
 * A custom role is non-constitutional (brief invariant 1); wherever a
 * role renders with a marker - registry rows here, and the picker,
 * hierarchy and grant surfaces owned by consumers / expiry-ui /
 * assign-path - this component is the marker to import, so a custom
 * role never renders dressed as a catalog role. Badge base is text-xs
 * with token classes (U1/U2), static (U7).
 *
 * Print surfaces cannot render a component: the PDF prints the
 * definition title plus a `(custom)` text suffix instead (contracts
 * 4.5, G9 B9) - the same marker, translated.
 */
export function CustomRoleBadge() {
  return <Badge variant="secondary">Custom</Badge>;
}
