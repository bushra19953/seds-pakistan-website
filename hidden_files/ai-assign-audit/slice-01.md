## Slice 01/20 DONE — subordinates staleness BUG CONFIRMED

- task-form.tsx:350-365: roles+users via useCollection; use-collection.tsx:48 defaults options={listen:false} => one-time getDocs, NOT onSnapshot. Neither call passes listen:true.
- Fetch fires once per TaskForm mount (dialog open; TaskForm key='new-task-form' remounts each open at admin/tasks/page.tsx:1329). While dialog open: no listener, no refetch. Only periodic refresh (165-178) reloads Gemini key, not roles/users.
- Registry: rolesMap from roles snapshot (463-473); users mapped {uid,displayName,email,role,chapterId}, member/none filtered (482); chapter-scoped (487-495); sent as subordinates (528). Server interpolates blindly (route.ts:116,162), no re-fetch.
- Extra stale layer: getAllRoleDefinitionsCached 5-min TTL (role-definitions.ts:29-36).
- Concrete bug: demotion while dialog open (or after open, before Generate click) => registry carries stale role; member filter can't exclude; AI assigns with stale rationale; API accepts. EXACTLY the live Eman Shah incident.
- Fix directions: listen:true on the two useCollection calls; or re-fetch roles inside generateWithAI before building subordinates; strongest: server-side verify assignees via Admin SDK. Note: closing/reopening the dialog DOES refetch (fresh mount).
