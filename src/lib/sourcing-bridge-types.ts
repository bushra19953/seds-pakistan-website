/**
 * CMS content types for the sourcing-bridge page.
 *
 * Firestore layout: collection `sourcing_bridge_content`, one document per
 * section (document IDs listed in each interface). All fields are plain
 * serializable values so the admin UI can edit them as simple forms.
 */

/** Firestore collection that stores every sourcing-bridge content document. */
export const SOURCING_BRIDGE_COLLECTION = 'sourcing_bridge_content';

/** Document ID in `sourcing_bridge_content` that controls the page hero. */
export const HERO_DOC_ID = 'hero';

/** Document ID in `sourcing_bridge_content` that controls the arbitrage grid. */
export const ARBITRAGE_GRID_DOC_ID = 'arbitrage_grid';

/** Document ID in `sourcing_bridge_content` that controls the workflow steps. */
export const WORKFLOW_DOC_ID = 'workflow';

/** Document ID in `sourcing_bridge_content` that controls the factory showcase. */
export const FACILITIES_DOC_ID = 'facilities';

/** Document ID in `sourcing_bridge_content` that controls pilot packages. */
export const PILOT_PACKAGES_DOC_ID = 'pilot_packages';

/** Icon key for hero metric badges. Must match a lucide icon key in the component map. */
export type HeroBadgeIcon = 'compass' | 'cpu' | 'clock' | 'shield';

/** One of the four metric badges under the hero CTAs. */
export interface HeroMetricBadge {
  /** Which lucide icon to render ('compass' | 'cpu' | 'clock' | 'shield'). */
  icon: HeroBadgeIcon;
  /** Small uppercase label above the value, e.g. '5-Axis Precision'. */
  label: string;
  /** Large headline value, e.g. '±0.005 mm'. */
  value: string;
  /** One-line caption under the value, e.g. 'Al 7075-T651 / Ti-6Al-4V'. */
  caption: string;
  /** Accent color theme: 'primary' or 'accent'. */
  theme: 'primary' | 'accent';
}

/** Call-to-action button rendered in the hero. */
export interface HeroCta {
  /** Button text, e.g. 'Request 48-Hour DFM & Benchmark Quote'. */
  label: string;
  /** Anchor href, e.g. '#intake-form'. */
  href: string;
  /** 'primary' for the filled button, 'secondary' for the outline button. */
  variant: 'primary' | 'secondary';
}

/**
 * Document `sourcing_bridge_content/hero`.
 * Renders: src/components/sourcing-bridge/SourcingHero.tsx
 */
export interface SourcingHeroContent {
  /** Eyebrow badge segments shown before the headline, e.g. ['SEDS SOURCING BRIDGE', 'ACADEMIC HARDWARE PIPELINE']. */
  eyebrowBadges: string[];
  /** Secondary badge label, e.g. 'SJTU Fellow Coordinated'. */
  secondaryBadge: string;
  /** Headline text; supports **bold** spans and {highlight} for the accent span. */
  headline: string;
  /** Sub-headline body text below the headline. */
  subheadline: string;
  /** CTA buttons, in display order. */
  ctas: HeroCta[];
  /** Metric badges in the 4-card grid. */
  metricBadges: HeroMetricBadge[];
  /** 'Operational Base' footer value. */
  operationalBase: string;
  /** 'Project Lead' footer value. */
  projectLead: string;
}

/** One comparison card in the arbitrage grid. */
export interface ArbitrageItem {
  /** Card title, e.g. 'Prototyping Cost'. */
  dimension: string;
  /** Icon key matching the component map: 'dollar' | 'clock' | 'shield' | 'cpu'. */
  icon: 'dollar' | 'clock' | 'shield' | 'cpu';
  /** Red panel copy describing the traditional bottleneck. */
  bottleneck: string;
  /** Blue panel copy describing the SEDS resolution. */
  resolution: string;
  /** Pill label, e.g. '50%–70% Savings'. */
  metric: string;
  /** Accent theme: 'primary' or 'accent'. */
  theme: 'primary' | 'accent';
}

/**
 * Document `sourcing_bridge_content/arbitrage_grid`.
 * Renders: src/components/sourcing-bridge/ArbitrageGrid.tsx
 */
export interface ArbitrageGridContent {
  /** Small pill label above the section title. */
  eyebrow: string;
  /** Section H2 title. */
  title: string;
  /** Intro paragraph under the title. */
  description: string;
  /** Comparison cards in display order. */
  items: ArbitrageItem[];
}

/** One step in the 4-step sourcing workflow. */
export interface WorkflowStep {
  /** Step number watermark, e.g. '01'. */
  stepNumber: string;
  /** Step title, e.g. 'Submit CAD & Specs'. */
  title: string;
  /** One-paragraph step description. */
  description: string;
  /** Icon key: 'upload' | 'search' | 'cog' | 'plane'. */
  icon: 'upload' | 'search' | 'cog' | 'plane';
  /** Badge label, e.g. 'Step 1'. */
  badge: string;
  /** Accent theme: 'primary' or 'accent'. */
  theme: 'primary' | 'accent';
}

/**
 * Document `sourcing_bridge_content/workflow`.
 * Renders: src/components/sourcing-bridge/SourcingWorkflow.tsx
 */
export interface WorkflowContent {
  /** Small pill label above the section title. */
  eyebrow: string;
  /** Section H2 title. */
  title: string;
  /** Intro paragraph under the title. */
  description: string;
  /** Workflow steps in display order. */
  steps: WorkflowStep[];
}

/** One manufacturing base card in the factory showcase. */
export interface Facility {
  /** Stable slug used as React key and for admin editing, e.g. 'cnc-base'. */
  id: string;
  /** Filter tab key: 'cnc' | 'pcba' | 'tooling'. */
  category: 'cnc' | 'pcba' | 'tooling';
  /** Human label for the category tab, e.g. '5-Axis Precision Machining'. */
  categoryLabel: string;
  /** Location line under the title, e.g. 'Kunshan / Suzhou / Shanghai Precision Corridor'. */
  location: string;
  /** Card title, e.g. '5-Axis Aerospace Machining Base'. */
  title: string;
  /** Bullet list of verified machinery. */
  machinery: string[];
  /** Single line of tolerances and standards. */
  tolerances: string;
  /** Chip list of certified materials. */
  materials: string[];
  /** Checkmark list of typical target components. */
  components: string[];
  /** Pill badge, e.g. 'Zeiss CMM Certified'. */
  badge: string;
  /** Accent theme: 'primary' or 'accent'. */
  theme: 'primary' | 'accent';
  /** Icon key: 'cog' | 'cpu' | 'wrench'. */
  icon: 'cog' | 'cpu' | 'wrench';
}

/**
 * Document `sourcing_bridge_content/facilities`.
 * Renders: src/components/sourcing-bridge/FactoryShowcase.tsx
 */
export interface FacilitiesContent {
  /** Small pill label above the section title. */
  eyebrow: string;
  /** Section H2 title. */
  title: string;
  /** Intro paragraph under the title. */
  description: string;
  /** Tab filter definitions in display order (excluding 'All Capabilities'). */
  categories: { key: 'cnc' | 'pcba' | 'tooling'; label: string }[];
  /** Facility cards; filtered client-side by category. */
  facilities: Facility[];
}

/** One pilot package card. */
export interface PilotPackage {
  /** Stable slug used as React key and for admin editing, e.g. 'pilot-basic'. */
  id: string;
  /** Package name, e.g. 'Prototype Sprint'. */
  name: string;
  /** One-line tagline. */
  tagline: string;
  /** Price string, e.g. 'From $2,500'. */
  price: string;
  /** Bullet list of included items. */
  features: string[];
  /** Accent theme: 'primary' or 'accent'. */
  theme: 'primary' | 'accent';
  /** Whether this card renders as the highlighted/recommended package. */
  highlighted: boolean;
}

/**
 * Document `sourcing_bridge_content/pilot_packages`.
 * Renders: the pilot packages section on the sourcing-bridge page.
 */
export interface PilotPackagesContent {
  /** Small pill label above the section title. */
  eyebrow: string;
  /** Section H2 title. */
  title: string;
  /** Intro paragraph under the title. */
  description: string;
  /** Package cards in display order. */
  packages: PilotPackage[];
}
