v41.0 SWARM DEPLOYED — STAGE 6/12 STARTING

# STAGE 6 – ADMIN FORM EDITABILITY IMPLEMENTATION
**Objective:** Empower administrators to dynamically add, remove, and modify the application form fields without touching the codebase.

## 1. AGENT 06 (Dynamic Architecture Specialist) CHAIN OF THOUGHT:
"Thinking: The prompt strictly requires 'Make the form editable on the admin side (add/remove fields like name, email, university, etc.)'. The previous induction form was aggressively hardcoded across multiple files: `induction/page.tsx` housed a static Zod schema, and `Step1Personal.tsx` & `Step2Skills.tsx` contained static JSX inputs.

To solve this properly, I must:
1. Build a new admin UI tool (`InductionFormEditor`) that writes a JSON array of `CustomField` objects to Firestore (`settings/induction_form`).
2. Attach this UI tool to the existing `AdminApplicationsPage` so it exists right where admins review the incoming applications.
3. Completely tear down and rebuild `src/app/induction/page.tsx` to act as a **Dynamic Form Engine**. It must fetch the config from Firestore on mount, dynamically stitch together a custom Zod validation schema, generate dynamic `defaultValues`, and pass the array down to the stepper components.
4. Refactor `Step1`, `Step2`, and `Step4 (Review)` to map over the dynamic fields array and render `<Input>` tags contextually."

## 2. COMPONENT OVERHAUL DETAILS

### New Admin UI: `src/components/admin/applications/induction-form-editor.tsx`
- Added a "Configure Application Form" settings gear button directly above the applications table in `admin/applications/page.tsx`.
- Opens a Dialog allowing admins to add custom fields, specify their `label`, internal `camelCase` name, UI `step` (Personal vs Skills), and toggle the `required` boolean.
- Stores configuration reliably to `doc(db, "settings", "induction_form")`.

### Dynamic Form Engine: `src/app/induction/page.tsx`
- Replaced the static schema with a highly dynamic React `useEffect` data-fetching pattern.
- Maps `required` booleans to `z.string().min(1)` and optional fields to `z.string().optional()`.
- Passes the schema shape dynamically to `react-hook-form` via the `useForm` hook's `zodResolver`.
- Binds safe fallbacks so if an admin deletes the configuration, the system automatically reconstructs the classic Name/University/Department array.

### Stepper Component Refactoring
- **`Step1Personal.tsx` & `Step2Skills.tsx`:** Ripped out the static HTML. Both now accept `fields: CustomField[]` as props and elegantly `<Map>` over them, rendering `Input` components and intelligent error boundary displays inline.
- **`Step4Review.tsx`:** Replaced the hardcoded summary list with a dynamic iterator that perfectly reads `formData[field.name]` and displays the admin-defined labels on the final review screen.

## 3. RESULTS & VERIFICATION
- [x] **No Code Deploys Needed:** If SEDS wants to ask for "Discord ID" or "Dietary Restrictions" tomorrow, an Admin can click 3 buttons and the form updates live in production.
- [x] **Unbroken Validation:** Dynamic fields still securely obey Zod schema rules and step-by-step trigger gates built in Stage 5.
- [x] **Zero Redundancy/Leftovers:** Hardcoded vestiges have been completely purged from the stepper components.

MISSION COMPLETE — APPLY NOW FLOW ROBUST AUDIT & FIX ASSASSINATED
