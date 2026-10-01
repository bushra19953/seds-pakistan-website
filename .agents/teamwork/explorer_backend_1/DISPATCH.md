# Task Dispatch: Survey Explorer 2 (Backend, Data, Security & Services)

## Identity
- Role: Backend & Security Explorer
- Working Directory: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_backend_1
- Parent: Project Orchestrator (eb50595a-b458-4e87-a8e8-2126d0c6a4ec)

## Objective
Investigate backend infrastructure, Firebase authentication & RBAC, Firestore collections & security rules, storage buckets & rules, and external service integrations across the SEDS Pakistan website.

## Authoritative Inputs
- Read `ORIGINAL_REQUEST.md` at `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\ORIGINAL_REQUEST.md`
- Inspect `firestore.rules`, `storage.rules`, `firebase.json` (if present)
- Inspect Firebase initialization, auth providers, token verification, custom claims, middleware, and route guards
- Inspect all Firestore collection references, queries, mutations (`collection(db, ...)`, `addDoc`, `setDoc`, `updateDoc`, etc.)
- Inspect storage references (`ref(storage, ...)`, `uploadBytes`, `uploadBytesResumable`, etc.)
- Inspect external services: mailers (Resend, Nodemailer, SendGrid, etc.), payment/registration APIs, environment variable references (`process.env.*`, `.env.example`, etc.)

## Deliverables
Produce a structured handoff report at:
`c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_backend_1\handoff.md`

Covering:
1. Authentication & RBAC analysis: auth methods, session handling, roles, route guard implementations vs stubs.
2. Firestore Collections & Schema Ground Truth: All collections, document structures, field types, indexes, and real vs mock database operations. Detailed analysis of `firestore.rules`.
3. Storage Pipelines: Buckets, folders, file types, size limits, and `storage.rules` analysis.
4. External Services & APIs: Mailers, third-party integrations, webhook handlers, and env var inventory.
5. Identify any security risks, missing rules, unauthenticated endpoints, or hardcoded secrets/keys.

## 2026-09-26T06:07:50Z
You are explorer_backend_1, a teamwork_preview_explorer.
Your working directory is: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_backend_1

MANDATORY FIRST STEP:
Read ORIGINAL_REQUEST.md at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\ORIGINAL_REQUEST.md
Also read your task dispatch at: c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_backend_1\DISPATCH.md

Objective:
Investigate backend infrastructure, Firebase Authentication, RBAC, Firestore database & rules, Storage pipelines & rules, and External Services.
Enumerate:
1. Authentication & RBAC: Firebase auth initialization, auth providers, token verification, custom claims, session handling, route guards (real vs mock).
2. Firestore Collections & Schema Ground Truth: All collections, document schemas, field types, and operations. Detailed analysis of `firestore.rules` (what is allowed, restricted, or open).
3. Storage Pipelines: Buckets, paths, file types, size limits, and `storage.rules`.
4. External Services & APIs: Mailers (Resend, Nodemailer, etc.), third-party APIs, webhooks, environment variable references.
5. Identify any security vulnerabilities, missing rules, unauthenticated operations, or secret leakage risks.

Write your full exploration report to:
`c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_backend_1\handoff.md`

When complete, send a message back to your caller agent (parent) informing them of completion and referencing the handoff path.
