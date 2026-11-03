---
name: SEDS Pakistan
description: Dark mission-control HUD identity for a student space society: deep navy, coral signal accent, condensed display type, mono instrument text.
colors:
  background: "hsl(222 47.4% 11.2%)"
  surface: "hsl(222 40% 14%)"
  foreground: "hsl(210 40% 96%)"
  primary: "hsl(15 72% 63%)"
  primary-deep: "hsl(15 72% 38%)"
  accent: "hsl(220 80% 50%)"
  muted-foreground: "hsl(215.4 16.3% 41%)"
  border: "hsl(214.3 31.8% 91.4% / 0.12)"
  success: "hsl(152 60% 45%)"
typography:
  display:
    fontFamily: "Bebas Neue, Noto Sans, sans-serif"
    fontWeight: 400
    letterSpacing: "0.02em"
  accent:
    fontFamily: "Orbitron, Noto Sans, sans-serif"
    fontWeight: 600
    letterSpacing: "0.18em"
  body:
    fontFamily: "Courier Prime, Noto Sans, monospace"
    fontSize: "1rem"
    lineHeight: 1.6
  urdu:
    fontFamily: "Noto Nastaliq Urdu, Noto Sans, serif"
rounded:
  base: "0.5rem"
spacing:
  section: "6rem"
components:
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.base}"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.base}"
---

## Overview

The incumbent world is a mission-control HUD: deep navy void, hairline instrument borders, coral as the single signal color, condensed uppercase display type (Bebas Neue) for names and numbers, Orbitron letter-spaced labels for instrument readouts, and Courier Prime mono for body text and data. It reads as a control room, not a brochure. Preserve this world; design inside it with more discipline, not a new identity.

## Colors

- Background is a deep navy (222 47% 11%), never pure black. Surfaces lift by lightness steps, not by new hues.
- Coral (15 72% 63%) is the only signal color: progress, active states, the one primary action per view. Text on light surfaces uses the deepened coral (15 72% 38%) for contrast.
- Blue accent (220 80% 50%) is a secondary instrument color (links, info), used sparingly.
- Status colors are semantic only: green complete, amber in review, red destructive. Never decorative.

## Typography

- Display: Bebas Neue, uppercase, tight leading, large. Names of projects and missions are set like callsigns.
- Labels: Orbitron, uppercase, wide tracking (0.18em+), small size. Used for HUD readouts, section eyebrows, and stats.
- Body: Courier Prime mono. Data, descriptions, deadlines, and proof text all read as instrument output.
- Urdu: Noto Nastaliq Urdu with generous line-height; never force Urdu into the display or label styles.

## Layout

- Max content width with wide side gutters on desktop; single column under 768px.
- Sections separated by space and hairlines, not boxes inside boxes.
- Cards share one radius (0.5rem) and one border treatment (hairline, low-alpha white).

## Elevation & Depth

- Flat HUD: depth comes from background lightness steps and glows on signal elements (progress bars, live indicators), not drop shadows.
- Imagery sits in framed panels with the same hairline border as cards.

## Shapes

- Small, technical radii (0.5rem base). Pills only for status chips and tags.
- Segmented progress bars (tick-divided) are a signature motif of the mission surfaces.

## Components

- Project card: cover image panel (16:9), callsign title, one-line description, segmented progress bar with percentage, category tag, status chip (Ongoing/Completed).
- Mission Command board: stat blocks (Orbitron numerals), live mission rows with segmented progress, command feed list. Content must never clip: panels size to content or scroll internally with a visible affordance.
- Buttons: one coral primary per view; everything else ghost/hairline.

## Do's and Don'ts

- Do give every project a real cover visual; an empty logo placeholder panel is a defect, not a style.
- Do keep exactly one primary action per view.
- Do not introduce new hues, gradients for decoration, or rounded-blob shapes.
- Do not truncate operational text with ellipses where the full fact matters (names, deadlines, statuses).
- Do not set body copy in the display font or display headlines in mono.
