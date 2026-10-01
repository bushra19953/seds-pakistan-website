# v31.0 SWARM DEPLOYED — STAGE 4/12 STARTING

## AGENT 04: UI RESTORATION MASTER

**Objective:** The previous iteration bloated the public event view by throwing everything into a massive center-aligned stack. `min-h-[85vh]` heroes with overlapping text caused severe readability degradation and infinite scrolling. The objective is to restore the premium, snappy, conversion-optimized split-pane layout.

### 🧠 Chain of Thought (Aggressive COT)
*Thinking: The problem with `_event-client.tsx` was structural. The developer dumped all critical elements (Pricing, Dates, Capacity, Registration Countdown, FOMO badges, and CTAs) directly *inside* the image Hero banner. If an event uploaded a light-colored image, the text became completely illegible. Furthermore, putting the CTA inside a hero forces users to scroll all the way back up to register after reading the long-form mission brief. This is amateur design. The professional standard (like Luma or Eventbrite) uses a sticky sidebar. I will rip out the overlapping stats from the Hero, shrink the Hero to 45vh, and deploy a CSS Grid (lg:grid-cols-12).*
*The resulting layout:*
*- Left Pane (lg:col-span-8): The Description, Map, and Strategic Framing blocks.*
*- Right Pane (lg:col-span-4): A sticky (`top-28`) frosted-glass card containing Price, Date, Location, dynamic Capacity bar-chart, Countdown, and the massive Checkout CTA button. This guarantees the checkout flow is always visible no matter how far the user scrolls down to read the details.*

### 🚀 Execution Protocol

**1. Hero Restructuring**
- Decreased hero height from `85vh` to `45vh`.
- Ripped out all data points and CTAs from the hero.
- Re-styled the title to `lg:text-7xl` with leading-tight drop-shadows.

**2. Two-Column Grid Deployment**
- Established `<div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">`.
- Placed `parsedDescription` and internal framing components into the 8-column left side.
- Placed the map into the 8-column left side.

**3. Sticky Registration Sidecard**
- Deployed `<div className="lg:col-span-4 lg:sticky lg:top-28 space-y-6">`.
- Built a custom `bg-card/80 backdrop-blur-2xl` card.
- Recreated the pricing tier header with a subtle primary glow overlay.
- Added a visual Capacity Progress Bar (`<div className="w-full h-1.5 bg-muted..."><div className="bg-primary" style={{ width: percentage }} />`).
- Placed the `<EventCTA>` exactly underneath the `RegistrationDeadlineCountdown`.

### 🎯 Mission Status
The Public Event Page is now a hyper-readable, conversion-optimized landing page. No more endless scrolling.

MISSION COMPLETE FOR STAGE 4. AGENT 04 HANDING OFF TO STAGE 5.
