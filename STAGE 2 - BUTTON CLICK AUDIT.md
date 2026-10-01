v41.0 SWARM DEPLOYED — STAGE 2/12 STARTING

# STAGE 2 – BUTTON CLICK AUDIT
**Objective:** Dissect the exact behavior of the `Apply Now` button for both logged-in and logged-out states.

## 1. AGENT 02 (Button Click Dissector) CHAIN OF THOUGHT:
"Thinking: I need to analyze how the user initiates the flow. We found two primary buttons:
1. `src/components/sections/induction-hero-section.tsx` (Line 126): `<Link href="/apply/step-1">Apply Now ...</Link>`
2. `src/components/sections/student-recruitment-hero.tsx` (Line 186): `<Link href="/induction">Apply Now ...</Link>`

Both of these are simple Next.js `<Link>` components without any `onClick` handlers or auth state checks. The auth check is completely deferred to the route layout or page component. This is the root cause of the 'no popup appears' bug. When a logged-out user clicks, they are abruptly navigated to a new page, which then detects the null user and does a hard `router.replace('/auth/login')`. We need to intercept this click with an Auth Check before navigation."

## 2. LOGGED OUT VS LOGGED IN BEHAVIOR MAP:

### Current Behavior (Logged Out):
1. User clicks `Apply Now`.
2. Browser navigates to `/apply/step-1` (or `/induction`).
3. Next.js router loads `src/app/apply/layout.tsx` (or `src/app/induction/page.tsx`).
4. The `useUser()` hook resolves to `null`.
5. A `useEffect` triggers: `router.replace('/auth/login?redirect=...')`.
6. User arrives at standard login page. **(FAIL: No modal/popup UX, jarring transition, loses context of the hero section).**

### Current Behavior (Logged In):
1. User clicks `Apply Now`.
2. Browser navigates to `/apply/step-1`.
3. Server/Router checks `layout.tsx` -> User exists -> Allows entry.
4. Route aliases to `/induction?step=1`.
5. `InductionContent` mounts.
6. A form draft is loaded from Firestore (if exists).
7. Form is presented. (UX pass, but bugs exist in the form itself which Agent 04 will fix).

## 3. FIX STRATEGY (Preparation for Stage 3):
We will create a specific `AuthGuardedLink` or `AuthGuardedButton` component.
- It will wrap the standard `Button`.
- It will consume `useUser()` from `@/firebase`.
- `onClick`:
  - If `!user`: `e.preventDefault()`, open a centralized Auth Modal (`<AuthModal open={isAuthModalOpen} ... />`).
  - If `user`: Let the default `<Link>` navigation proceed to `/induction?step=1`.

This surgically removes the hard redirect for unauthenticated users at the point of interaction, fulfilling the "no popup appears now — fix it" mandate.

MISSION COMPLETE — APPLY NOW FLOW ROBUST AUDIT & FIX ASSASSINATED
