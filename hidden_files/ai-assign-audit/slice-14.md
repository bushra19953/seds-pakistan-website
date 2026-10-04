## Slice 14/20 DONE — git history, KEY FINDING

- The AI registry is built client-side as `subordinates: usersChapter.map(u => ({uid, name, role: u.role}))` — role comes from `users/{uid}.role`, NOT the `roles` collection. Unchanged since initial commit.
- Commit 6a13ae6 "Fix role drift: assignRole now syncs users.role" — previously assignRole wrote roles collection + displayRole but NEVER users.role; 12 users drifted. Any demotion path that doesn't write users.role leaves the AI assigning from the old role indefinitely.
- Implication: the in-flight demotions MUST write both roles/{uid}.role AND users/{uid}.role, or the AI keeps picking demoted people.

Action: steered browser task to verify users/{uid}.role after demotion.
