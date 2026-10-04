## Slice 10/20 DONE — system-prompt bias analysis

- Bias is prompt-determined, not model flakiness. Role-title is the ONLY matching axis (registry sends only {uid,name,role} — no skills).
- Coordinator definitions use broad verbs (coordinate/oversee/manage/liaise) that overlap any decomposed step; doer definitions are narrow. Decomposition itself is coordinator-flavored (typesetting folded into "Digital Asset Preparation" under General Secretary).
- REASONING rule forces justification "based on their role" — locks in title-anchored picks.
- COMPOUNDING: the "workload"/"active task counts" signal is FICTIONAL — client never sends it. Prompt advertises a tiebreaker that doesn't exist.
- President/VP never assignable: brief says "collaborate with HIGHER executive leadership" -> model makes them liaison objects; nothing says named collaborators may be assignees. Registry param literally named "subordinates".
- Proposed prompt edit: add DOERS OVER COORDINATORS rule + NAMED PEOPLE ARE ASSIGNABLE rule after MATCHING. Also delete "and current workload" claims or actually send per-user counts.
- Bottom line: re-running generation keeps producing coordinator picks until MATCHING is constrained; Eman Shah demotion was load-bearing because re-runs re-select coordinator-title holders.
