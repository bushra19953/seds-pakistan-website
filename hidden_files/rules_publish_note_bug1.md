# Firestore Rules Publish Note, Bug 1 (role 403 + custom title)

Date: 2026-10-20
Branch: fix/cron-get-and-exemption-argshape

## Why this note exists

`firestore.rules` cannot be deployed through Vercel. It lives in the
Firebase project (`seds-pakistan`), not in the web app. It must be published
by hand in the Firebase Console. Until that is done, the rule changes below
are code-only and NOT live.

## What changed in firestore.rules

1. New helper (Core Helper Functions section):
   `function isFounder() { return isSignedIn() && request.auth.uid == 'pLW0PuQCTAQHCNK1SfllVhPZdMz1'; }`
   The founder UID is now a peer of superadmin for role gates, independent of
   any role doc.

2. `match /roles/{userId}` create/update/delete gate widened to:
   `(isSuperAdmin() || isPresident() || isFounder() || hasPermission('canManageRoles'))`
   The target-superadmin guard (`!isTargetSuperAdmin(userId)`) and the
   reserved-string guards (`role != 'superadmin'`, `role != 'president_national'`)
   are unchanged.

3. `match /users/{userId}` role-mirror branch (`isRoleManagementUpdate`)
   widened to the same four-way gate, and its field allow-list now includes
   `customTitle` (display-only title, never feeds permission checks, never
   written into `roles/{uid}.role`).

4. `customTitle` added to `privilegedFieldsUnchanged`, so a user cannot
   grant themselves an official-looking title through the owner update path.
   Only the role-management and admin branches may set it.

5. `isValidUserData` now requires `customTitle` to be a string when present.

## How to publish

1. Open the Firebase Console: https://console.firebase.google.com/project/seds-pakistan/firestore/rules
2. Copy the full contents of `firestore.rules` from this branch into the
   editor (replace everything).
3. Click Publish. Wait for the "Rules published successfully" confirmation
   and note the timestamp.

## Verify after publishing

1. As the founder account (or president_national), change a test user's role
   in /admin/users and confirm no 403.
2. Set a custom title from the Change Role submenu ("Set custom title"),
   confirm it shows under the role badge and in the Authority Inspector.
3. Confirm the title is NOT present in the `roles/{uid}` doc (check the
   Firestore Console): it lives only on `users/{uid}.customTitle`.
4. As a plain member, try to write `customTitle` to your own user doc from
   the client (or just confirm the rules simulator denies it): must be denied.
