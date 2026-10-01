# Task Dispatch: Survey Explorer 1 (Frontend, Routes & Forms)

## Identity
- Role: Codebase Researcher / Explorer
- Working Directory: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_codebase_1
- Parent: Project Orchestrator (eb50595a-b458-4e87-a8e8-2126d0c6a4ec)

## Objective
Investigate the SEDS Pakistan website codebase frontend architecture, all routes, pages, components, and forms to build an exhaustive inventory of routes, pages, and interactive components.

## Authoritative Inputs
- Read `ORIGINAL_REQUEST.md` at `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\ORIGINAL_REQUEST.md`
- Read `graphify-out/GRAPH_REPORT.md` and `graphify-out/wiki/index.md` (mandatory per GEMINI.md)
- Inspect `package.json`, framework configs, routing directory (`src/pages`, `src/app`, `pages/`, `app/`, etc.)
- Scan all components, forms, dropzones, dialogs, buttons with click/submit handlers

## Deliverables
Produce a structured handoff report at:
`c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_codebase_1\handoff.md`

Covering:
1. Complete codebase architecture: Framework (Next.js version, router type), styling, UI libraries, state management.
2. Complete route inventory: All public, protected, and admin routes.
3. Complete form & submission inventory:
   - Identify every form across the codebase.
   - For each form: locate file, form purpose, fields, submit handler, payload structure.
   - Initial classification: Tier 1 (Production Ready - real persistence), Tier 2 (Partial/Impaired - partially wired or mock returns), Tier 3 (Mock/Stub - console.log or local state only).
4. CAD dropzones, file upload components, hardware/project submission interfaces.
