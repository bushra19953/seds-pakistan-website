## Slice 20/20 DONE — end-to-end failure chain (Task 02 incident)

1. Brain dump contained NO design step (typesetting only existed in file 06, never pasted). Orchestrator invents 2-5 steps from briefing only -> generated Verification, Vendor/Procurement, Assembly/QC — nothing a designer matches to.
2. Registry = {uid,name,role} only. No workload counts despite prompt advertising them. Role definitions reduced to {role,description}, 5-min TTL cache.
3. Stale datum: Eman Shah still general_secretary in DB at click time (demotion existed only in chat). Every re-run re-ingested it.
4. MATCHING rule does definition-text -> step-text similarity matching.
5. Pick 1 (Eman -> Step 1): brain dump "collaborate with higher executive leadership... room allocation, signatory line-up, visual asset audit" matched general_secretary definition nearly verbatim. Direct evidence of text matching.
6. Pick 2 (Syeda, projects_director -> Step 2): Blue Area/F-7, 100gsm, folders matched projects_director execution/procurement description.
7. Pick 3 (naqvi.dabeer55, projects_director, no display name -> Step 3): QC+delivery+photo-proof matched same role. Name fell back to email; identity completeness not a criterion.
8. Designers were candidates (chair_design passes filter, no chapter filter) but no design step existed to match.
9. VP/President eligible under MEMBERSHIP but structurally unpickable: brief frames them as collaborators/recipients; no prompt rule permits assigning brief-named stakeholders as executors.
10. Regeneration destructive: overwrote corrected title, deadline (-> +7d default 2026-10-11), discarded assignee corrections. No merge behavior.
11. Demotions are the correct data-layer fix: roles/{uid}=member -> userPool filter drops them -> MEMBERSHIP rule makes future selection impossible.

Residual risks: workload claim false by construction; nameless accounts assignable; model can re-pick any role-title match; re-runs clobber human corrections.
