## Slice 11/20 DONE — AI output reliability

- Server validates only steps-is-array + points sum. Empty string/null/missing/hallucinated assigneeUid all survive the API.
- Client (582-584): type-only check. "" -> assigneeId:"" with aiSelected:true (wrongly flagged). Hallucinated non-empty string -> never checked against user pool -> flows into suggestedUids -> main assigneeIds.
- Submit gate (399) blocks only !s.assigneeId — garbage string is truthy -> passes. Combobox renders blank placeholder for unresolvable uid; bogus UID persisted verbatim (page.tsx:805 non-null assertion). Phantom-user tasks possible, invisible in UI.
- Empty steps[] passes server validation (length>0 guard skips throw); client skips assignee gate when workflowSteps empty (387). Per-step duplicates allowed by design (dedup only on main assigneeIds).
- reason shown in form UI (1009-1014, blue italic "AI Rationale") but DROPPED on save (page.tsx:801-811 payload excludes reason/aiSelected). Never reaches Firestore or assignees.
- No retry: single generateContent, single JSON.parse; brace-extraction fragile (indexOf { -> lastIndexOf }); JSON.parse SyntaxError rethrown, no retry; user-key path zero retry even for 429.
- Minor: points auto-correction string-concat bug ("20"+20="2020"), client coerces to 0.
- Ranked: (1) hallucinated assigneeUid -> phantom tasks; (2) no parse recovery; (3) empty-string misflag + empty-steps bypass; (4) reason dropped (cosmetic).
