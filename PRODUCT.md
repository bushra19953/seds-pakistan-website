# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: university students in Pakistan (and partner-chapter students in Sri Lanka) who join SEDS Pakistan, take on engineering missions, submit proof of work, and follow public project progress. Their situation: mostly mobile, exam-bound academic calendars, first-generation exposure to structured engineering work.
Secondary: partner chapters and institutions (SEDS Sri Lanka, NCGSA, IST), sponsors, and the public, who evaluate the society's credibility from its public pages.

## Product Purpose

SEDS Pakistan's single platform: the public face of the society (projects, events, hierarchy, store) and its internal operating system (applications, tasks and mission workflows, reviews, roles, discipline register). Success means a student can join, be given real work, prove it, and be scored fairly, and an outsider can verify the society is real and active.

## Positioning

A student society run with the operating discipline of a space agency's mission control: named missions, deadlines, reviewers, and public proof. Neighboring student societies run on chat groups and memory; this platform makes the work itself the public record.

## Operating Context

- Public pages are the society's shopfront: projects, the South Asia Aerospace Grand Prix with SEDS Sri Lanka, events, hierarchy, store.
- Internal work runs as mission workflows: multi-step tasks with assignees, reviewers, deadlines, platform-generated mission PDFs, and a public mission page per workflow.
- The Bilateral Communique V5.0 (PK-LK:SEDS-COMMUNIQUE:2026-11-03/V5.0) locks the Grand Prix operating timeline with SEDS Sri Lanka.
- Academic calendar rules the rhythm: mobilization windows avoid exam periods (IST midterms Nov 10-19, 2026).

## Capabilities and Constraints

- Free-tier infrastructure only: no paid hosting or Firebase billing upgrades. File uploads run on Google Drive, not Firebase Storage.
- Reads are served largely from a Supabase mirror of Firestore; Firebase Auth is the identity layer.
- Legal status line (Status Line A) must appear on outbound/public copy until the ICT 1860 filing receipt exists: "SEDS Pakistan is an independent student-led aerospace engineering initiative. Its registration under the Societies Registration Act 1860 (Act XXI of 1860) is currently in process."
- Public claims discipline: never claim designs leave Earth, never pitch a private space company to student volunteers, never present unbuilt hardware as built.

## Brand Commitments

- Name: SEDS Pakistan (Students for the Exploration and Development of Space, Pakistan).
- Identity: dark mission-control HUD world (documented in DESIGN.md), coral primary accent, Bebas Neue display type, Courier Prime body/mono, Orbitron accents.
- Voice: short, direct, factual. Facts and proof over adjectives.
- Footer legal: Status Line A plus "Operations operate under strict safety guidelines with zero chemical propellants permitted on university grounds."

## Evidence on Hand

- Live platform: https://sedspakistan.live (public projects, hierarchy, missions, store).
- Bilateral Communique V5.0 PDF (2026-11-03) with SEDS Sri Lanka.
- Real project proof: task deliverables and Drive proof files from the crucible pods (rocketry, CubeSat, rover work).
- Absence to respect: most projects have no cover imagery yet; do not fabricate photography of hardware that does not exist. Generated illustration is acceptable when it reads as illustration.

## Product Principles

1. Join first and last: every public surface routes a student toward joining or doing the next real thing.
2. Proof over promise: show the work, the deadline, the reviewer, the record.
3. One standard: the same mission pipeline for everyone, officers included.
4. Protect the student's calendar: plan around exams, publish dates early.
5. Earn trust in public: hierarchy, warnings, and progress are facts on the record, stated plainly.

## Accessibility & Inclusion

- Urdu content appears on the platform (Noto Nastaliq Urdu in the font stack); bilingual reality is a product fact, not an edge case.
- Mobile-first audience: most students arrive on phones over variable connections.
