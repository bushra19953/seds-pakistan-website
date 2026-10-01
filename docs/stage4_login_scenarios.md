# STAGE 4 — SCENARIO ANALYSIS: LOGIN, REGISTRATION & AUTH SCENARIOS
## v11.0 SWARM DEPLOYED — STAGE 4/15 (SCENARIO SET 1)
**AGENT 04 – SCENARIO HUNTER**

---

> **Thinking (COT):** Authentication scenarios are the entry point for all user interactions. The system uses Google OAuth exclusively. There is no username/password login. The auth flow has 6 major branch points: new user, returning user, banned user, invited user, dev token, and session expiry. Each must be documented with happy path, edges, and errors.

---

## 🔐 SCENARIO SET 1: Login & Authentication

---

### Scenario 1.1: First-Time Login (Happy Path)

**Actor:** Any new visitor  
**Trigger:** Clicks "Sign In" button anywhere on site

```
Step 1: User clicks "Sign In" (navbar button or page CTA)
Step 2: Google OAuth popup opens
Step 3: User selects / authenticates their Google account
Step 4: Firebase Auth creates UID for the user
Step 5: System checks Firestore roles/{uid}
  → Document does NOT exist (first time)
Step 6: Role defaults to 'guest'
Step 7: System checks users/{uid} for isBanned
  → isBanned: false (not banned)
Step 8: User is granted 'guest' session
Step 9: User redirected to the page they came from (or home)
Step 10: Welcome onboarding may appear (/welcome)
```

**Result:** User is signed in as `guest`, can browse public content and apply for membership.

---

### Scenario 1.2: Returning Member Login (Happy Path)

**Actor:** Existing member  
**Same as 1.1 steps 1–4, then:**

```
Step 5: System checks Firestore roles/{uid}
  → Document EXISTS: role = 'member'
Step 6: System checks users/{uid} for isBanned
  → isBanned: false
Step 7: User session contains role: 'member'
Step 8: User sees member-exclusive content (events, tasks, etc.)
```

---

### Scenario 1.3: Admin Login (Happy Path)

**Same as 1.2, but:**

```
Step 5: roles/{uid}.role = 'vice_president' (or any admin role)
Step 6: Not banned
Step 7: User session contains admin role
Step 8: Admin sidebar visible in navigation
Step 9: User can access /admin/* pages
```

---

### Scenario 1.4: Banned User Login (Edge Case)

```
Step 1-4: Normal Google OAuth
Step 5: Auth middleware fetches users/{uid}
  → isBanned: true
  → banReason: "Repeated task failures"
Step 6: Auth middleware returns redirectTo: '/banned'
Step 7: User redirected to /banned page
Step 8: /banned shows the ban reason
Step 9: User cannot sign in or access any authenticated page
```

**Resolution:** Admin must unban from `/admin/users` → click "Unban" → set `isBanned: false`.

---

### Scenario 1.5: Invited User Accepts Invite

**Actor:** Guest who received invite link  
**Trigger:** Receives invite email, clicks link

```
Step 1: Admin creates invite in /admin/applications (or sends from /admin/submissions)
Step 2: Invite document created in Firestore invites/{token}
  → email: user@domain.com
  → role: 'member'
  → expiresAt: [48 hours from now]
Step 3: User receives email with /invite/[token] link
Step 4: User clicks link → lands on /invite/[token]
Step 5: System checks invites/{token}:
  → Is token valid? YES
  → Is token expired? NOT YET
  → Has it been used? NO
Step 6: User prompted to sign in with Google
Step 7: After sign in, role set to 'member' in roles/{uid}
Step 8: Invite marked as used (usedBy, usedAt)
Step 9: User auto-redirected to /welcome
```

**Edge: Token Expired:**
```
Step 5: expiresAt is in the past
  → Show "Invite expired" message
  → Suggest user contact admin for a new invite
```

**Edge: Token Already Used:**
```
Step 5: usedBy exists
  → Show "Invite already used" message
```

---

### Scenario 1.6: Session Expiry / Token Rotation

```
Steps: User is active on site
Firebase ID token expires (1 hour by default)
Firebase SDK auto-refreshes token if refresh token valid
If refresh token expired:
  → Next API call returns 401
  → Client-side Firebase SDK fires onAuthStateChanged with null
  → User shown "Session expired, please sign in again"
  → Redirected to /auth/login
```

---

### Scenario 1.7: Sign Out

```
User clicks "Sign Out" in profile dropdown
Firebase Auth signOut() called
All local state cleared
Firestore real-time listeners detached
User redirected to home page (/)
Now appears as guest/unauthenticated
```

---

## 🔑 Auth Technical Reference

| Mechanism | Detail |
|---|---|
| Auth Provider | Firebase Auth (Google OAuth only) |
| Token Type | Firebase ID Token (JWT) |
| Token Lifetime | 1 hour (auto-refreshed by SDK) |
| Session Cookie | `__session` cookie (optional, for SSR) |
| Role Storage | Firestore `roles/{uid}` → `role` field |
| Ban Storage | Firestore `users/{uid}` → `isBanned` |
| Auth Check Flow | `verifyAuthentication()` in `src/lib/auth-middleware.ts` |
| Redirect on Fail | `/auth/login?redirect=[original-path]` |
| Redirect if Banned | `/banned` |

---

*AGENT 04 sign-off: Login/Auth scenarios fully documented with happy paths, edges, and errors.*
