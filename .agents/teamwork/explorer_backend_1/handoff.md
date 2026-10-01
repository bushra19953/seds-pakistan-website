# Backend Infrastructure, Auth, Firestore, Storage & Security Handoff Report

**Agent**: explorer_backend_1  
**Working Directory**: `c:\SEDS Pakistan Website\SEDS WEBSITE UPDATED SHIT\.agents\teamwork\explorer_backend_1`  
**Date**: 2026-09-26  
**Scope**: Backend infrastructure, Firebase Authentication, RBAC, Firestore database & rules, Storage pipelines & rules, External Services, and Security Vulnerability Audit.

---

## 1. Observation

### 1.1 Authentication & RBAC Ground Truth

#### A. Firebase Client & Admin SDK Initialization
- **Client Initialization**: Located at `src/firebase/core.ts` (lines 11–18) and `src/firebase/config.ts` (lines 2–10).
  - Uses `initializeApp(firebaseConfig)` with hardcoded config in `config.ts`:
    - `projectId`: `"seds-pakistan"`
    - `storageBucket`: `"seds-pakistan.appspot.com"`
    - `authDomain`: `"v0-seds-pakistan.vercel.app"`
    - `apiKey`: `"AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg"`
  - Core services exported: `auth`, `firestore`, `storage`, `functions`.
- **Server/Admin SDK Initialization**: Located at `src/lib/server/firebase-admin.ts` (lines 12–180).
  - Employs a multi-tier fallback strategy:
    1. Local file detection (`seds-pakistan-service-account.json`, `firebase-service-account.json` — verified to be a dummy stub with `private_key_id: "local-development-key"`).
    2. `process.env.FIREBASE_SERVICE_ACCOUNT` (JSON string or base64).
    3. `process.env.FIREBASE_CONFIG` (Hosting SSR).
    4. Google Cloud Application Default Credentials (ADC) with `projectId`.
    5. Default auto-discovery.
- **Cloud Functions SDK Initialization**: Located at `functions/src/index.ts` (lines 16–51).
  - Lazy-initializes `firebase-admin/app`, `firebase-admin/firestore`, `firebase-admin/auth`, and `firebase-admin/messaging` to prevent cold-start deploy timeouts.

#### B. Auth Providers & Session Handling
- **Supported Providers**:
  - Email/Password: Supported via Firebase Auth (`signInWithEmailAndPassword`, `createUserWithEmailAndPassword`).
  - Google OAuth: Configured in `src/components/auth/google-only-auth-form.tsx` (lines 5, 377) and `src/hooks/use-user.ts` (lines 21, 151) using `GoogleAuthProvider`.
- **Session Token & SSR Synchronization**:
  - `src/firebase/user-provider.tsx` (lines 83–98) listens to `onIdTokenChanged(auth, ...)`. When an authenticated user is detected, it syncs the Firebase ID token into a browser cookie:
    ```typescript
    document.cookie = `__session=${token}; path=/; max-age=3600; secure; samesite=strict`;
    ```
  - When the user signs out, the `__session` cookie is cleared (`max-age=0`).
  - `src/lib/auth-middleware.ts` (lines 35–49) extracts tokens either from the HTTP `Authorization: Bearer <token>` header or from `request.cookies.get('__session')?.value`.
- **Development Token Bypass**:
  - `src/lib/auth-middleware.ts` (lines 75–117): When `token === 'dev_token'` and `process.env.NODE_ENV === 'development'`, it mocks an authenticated user (`uid: 'dev_user'`, `role: 'member'`).

#### C. Custom Claims & Role Architecture
- **Role Hierarchy**: Defined in `src/lib/roles.ts` (lines 15–28):
  - `superadmin`: Level 11
  - `president_national`: Level 10
  - Other roles operate as dynamic string slugs (e.g., `projects_director`, `vice_president`, `chair_marketing`, `member`, `guest`).
- **Hardcoded Founder UID**:
  - `FOUNDER_UID = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1'` is hardcoded in:
    - `src/lib/roles.ts` (line 44)
    - `src/firebase/user-provider.tsx` (line 144)
    - `firestore.rules` (lines 34, 122)
    - `storage.rules` (line 7)
  - Anyone signed in with this UID is unconditionally granted `superadmin` role, bypasses permissions, and has write access everywhere.
- **Custom Claims Sync Triggers**:
  - `functions/src/index.ts` trigger `onRoleWritten` (`roles/{userId}`): Automatically calls `auth.setCustomUserClaims(userId, { role: newRole, chapter_id: chapterId })`.
  - `functions/src/index.ts` trigger `onUserChangedSyncClaims` (`users/{userId}`): Updates `claims.chapter_id` when `chapterId` changes.

#### D. Route Guard Mechanics (Real vs Mock)
- **Next.js Edge Middleware**: **DOES NOT EXIST**. There is NO `middleware.ts` in the repository root or `src/`. Server-side edge request interception does not occur.
- **Client Route Guards**:
  - `src/app/admin/layout.tsx` (lines 18–46): Client component calling `useAuthorization('canAccessAdmin')`. If unauthorized, executes `router.replace('/auth/login')` and returns `null`.
  - `src/components/admin/AuthorizationGate.tsx` (lines 13–38): HOC checking `useAuthorization(permission)`.
  - `src/hooks/use-authorization.ts` (lines 15–29): Checks dynamic matrix from `src/config/permissions.ts`.
  - *Finding*: Because route guards are purely client-side React components without Edge Middleware, static assets and JavaScript bundles for `/admin/*` pages are publicly accessible without authentication.
- **Backend API Route Guards**:
  - `src/lib/auth-middleware.ts` exports `verifyAuthentication`, `withAuth`, `requireAuth`, `requireRole`.
  - **Critical Gap**: Out of 88 API route files in `src/app/api/`, ONLY 3 routes use `withAuth`:
    1. `src/app/api/blogs/route.ts` (line 149)
    2. `src/app/api/admin/blogs/[id]/route.ts` (lines 11, 63, 131)
    3. `src/app/api/admin/users/route.ts` (line 44)
  - Other admin routes (e.g., `src/app/api/admin/role-permissions/route.ts`, `src/app/api/admin/roles/[slug]/route.ts`, `src/app/api/admin/universal-review/route.ts`) manually call `await verifyAuthentication(request)`.
  - However, **42 mutating API routes** (POST, PUT, PATCH, DELETE) have NO authentication or token verification whatsoever (detailed below).

---

### 1.2 Firestore Collections & Schema Ground Truth

The automated harness and code inspection cataloged 224 collection references and subcollections across the codebase.

#### Primary Firestore Collections & Document Schemas

| Collection Name | Key Schema Fields & Data Types | Operations Observed | Client Access (`firestore.rules`) |
|---|---|---|---|
| `users` | `uid` (string), `email` (string), `displayName` (string), `points` (number), `upvotes` (number), `downvotes` (number), `badges` (string[]), `chapterId` (string), `displayRole` (string), `isBlacklisted` (boolean), `isBanned` (boolean), `fcmTokens` (string[]), `pushEnabled` (boolean) | Read, Query, Update, Transaction increment | **Public Read (`get, list: if true`)**; Create by auth user; Update by owner/admin |
| `users/{uid}/notifications` | `userId` (string), `type` (string), `title` (string), `body` (string), `link` (string), `priority` ('P0'\|'P1'\|'P2'\|'P3'), `isRead` (boolean), `createdAt` (timestamp) | Listen, Create, Update | Owner read (`isOwner(userId)`); Superadmin write |
| `users/{uid}/warnings` | `reason` (string), `type` (string), `severity` (string), `createdBy` (string), `createdAt` (timestamp), `expiresAt` (timestamp), `isActive` (boolean) | Read, Create, Update | Owner or admin read; Superadmin or `canManageDefaulters` write |
| `users/{uid}/activity` | `type` (string), `taskId` (string), `taskTitle` (string), `createdAt` (timestamp) | Add (via Cloud Functions) | **NO RULE DEFINED** (Default Deny to clients) |
| `users/{uid}/rewards` | `taskId` (string), `pointsAwarded` (number), `hoursAwarded` (number), `badgeId` (string), `createdAt` (timestamp), `onTime` (boolean) | Set (via Cloud Functions transaction) | **NO RULE DEFINED** (Default Deny to clients) |
| `roles` | Document ID = `userId`; `role` (string), `updatedAt` (timestamp) | Read, Listen, Set, Delete | **Public Read (`get, list: if true`)**; Write by `isSuperAdmin()` or `canManageRoles` |
| `roleDefinitions` | `role` (string), `name`/`label` (string), `allowedPaths` (string[]), `canAccessAdmin` (boolean), `permissions` (string[]), `createdAt`, `updatedAt` | Read, Set, Delete | Auth read; Write by Executive or `canManagePermissions` |
| `role_permissions` | `role` (string), `label` (string), `allowedPaths` (string[]), `canAccessAdmin` (boolean), `createdAt` (timestamp) | Read, Set, Delete | Auth read; Write by Executive or `canManagePermissions` |
| `permissions` | Document ID = `role`; permission flags (boolean mapping, e.g. `canManageTasks: true`) | Read, Set | Exec or role owner read; Write by Exec or `canManagePermissions` |
| `tasks` | `title` (string), `description` (string), `status` ('pending'\|'in_progress'\|'pending_review'\|'completed'\|'overdue'), `points` (number), `hoursWorked` (number), `assigneeId` (string), `assigneeIds` (string[]), `workflowId` (string), `sequenceIndex` (number), `deadline` (timestamp), `rewardApplied` (boolean) | Listen, Query, Create, Update, Delete | Read by Superadmin, `canManageTasks`, `resource.data.assigneeId == auth.uid`, or `workflowId != null`; Write by Superadmin or `canManageTasks` |
| `events` | `title` (string), `slug` (string), `status` ('draft'\|'scheduled'\|'published'\|'archived'), `startAt` (timestamp), `endAt` (timestamp), `capacity` (number), `registrationOpen` (boolean), `attendeeIds` (string[]), `paymentDetails` ({ isPaid, amount, currency, method }), `ticketConfig` (object) | Read, Listen, Query, Create, Update | **Public Read (`get, list: if true`)**; Write by Superadmin or `canManageEvents` |
| `events/{id}/registrations` | Document ID = `uid`; `uid`, `eventId`, `displayName`, `email`, `whatsappE164`, `status`, `paymentStatus`, `paymentMethod` | Set (Cloud Function `registerForEvent`) | **NO SUBCOLLECTION RULE** (Default Deny to client) |
| `orders` | `userId` (string), `buyer` ({ fullName, email, phone }), `items` (array), `total` (number), `currency` (string), `status` ('pending'\|'processing'\|'shipped'\|'delivered'\|'cancelled'), `paymentMethod` (string), `proofOfPaymentUrl` (string) | Create, Read, Query, Update | Read by Superadmin, `canManageStore`, or buyer; Create by signed in; Update by admin |
| `products` | `name` (string), `description` (string), `price` (number), `currency` (string), `stock` (number), `category` (string), `isActive` (boolean), `imageUrl` (string) | Read, Query, Create, Update | **Public Read (`get, list: if true`)**; Write by Superadmin or `canManageStore` |
| `blogs` | `title` (string), `slug` (string), `content` (string), `author` (object), `status` ('draft'\|'published'), `publishedAt` (timestamp) | Read, Query, Create, Update | **Public Read (`get, list: if true`)**; Write by Superadmin or `canManageBlogs` |
| `submissions` | `type` ('competition'\|'project'\|'inquiry'), `title` (string), `url` (string), `userId` (string), `userDisplayName` (string), `status` ('pending'\|'approved'\|'rejected') | Create, Query, Update | Read/Write by Admin/Inbox; **Public Create allowed (`allow create: if true`)** |
| `universal_submissions` | `global_id` (string), `original_ref` (string), `type` (string), `status` (string), `user_id` (string), `summary_text` (string), `created_at` (timestamp) | Set, Delete (Cloud Functions & Webhook) | **NO RULE DEFINED** (Default Deny to clients; API access only) |
| `leave_requests` | `userId` (string), `startDate` (string), `endDate` (string), `reason` (string), `status` ('PENDING'\|'APPROVED'\|'REJECTED') | Create, Query, Update | **NO RULE DEFINED** (Default Deny in `firestore.rules`; handled via API) |
| `applications` | `userId` (string), `roleAppliedFor` (string), `status` (string), `createdAt` (timestamp) | Create, Query, Update | **NO RULE DEFINED** (Default Deny in `firestore.rules`) |
| `form_responses` | `formId` (string), `formTitle` (string), `userId` (string), `responses` (object) | Create, Query, Update | **NO RULE DEFINED** (Default Deny in `firestore.rules`) |
| `points_ledger` | `user_id` (string), `task_id` (string), `points_awarded` (number), `timestamp` (timestamp), `status` ('PROCESSED') | Create (via API `/api/admin/universal-review`) | **NO RULE DEFINED** |
| `competitions` | `title` (string), `url` (string), `description` (string), `deadline` (timestamp), `organization` (string), `tags` (string[]), `status` ('active') | Create, Query | **NO RULE DEFINED** |
| `dlq_points_retry` | `action` (string), `ids` (string[]), `error` (string), `status` ('PENDING_RETRY') | Create (Dead Letter Queue on failure) | **NO RULE DEFINED** |
| `email_logs` | `to` (string), `from` (string), `template` (string), `subject` (string), `htmlPreview` (string), `success` (boolean), `sentAt` (timestamp) | Create (via `src/lib/mailer.ts`) | **NO RULE DEFINED** |
| `audit_logs` | `type` (string), `actorId` (string), `targetId` (string), `timestamp` (timestamp) | Read, Create | Read by Superadmin or `canViewAuditLogs`; **Create by ANY signed-in user (`allow create: if isSignedIn();`)** |
| `bug_reports` | `title` (string), `description` (string), `reporterUid` (string), `screenshotUrl` (string) | Read, Create | Read/Write by Superadmin/Admin; Create by signed in |
| `pageVisits` | `path` (string), `timestamp` (timestamp), `userAgent` (string) | Create | **Public Create (`allow create: if true;`)**; Admin read |
| `analyticsEvents` | `event` (string), `properties` (object), `timestamp` (timestamp) | Create | **Public Create (`allow create: if true;`)**; Admin read |
| `warningConfig` | Document `global`: `WarningSettings` | Read, Update | Signed-in read; Write by Superadmin or `canManageDefaulters` |
| `settings` | Document `workflow`: `releaseOnOverdue` (boolean), trust bar metrics | Read, Write | **Public Read (`allow read: if true;`)**; Write by Superadmin |
| `positions` | `role` (string), `userId` (string), `startDate` (timestamp), `endDate` (timestamp), `continuityUpdated` (boolean) | Read, Create, Update | **Public Read (`allow read: if true;`)**; Write by Superadmin or `canManagePositions` |
| `chapters` | `name` (string), `slug` (string), `city` (string), `isActive` (boolean) | Read, Query, Write | **Public Read (`allow read: if true;`)**; Write by Superadmin or `canManageChapters` |
| `badges` | `slug` (string), `name` (string), `imageUrl` (string), `pointsRequired` (number), `isActive` (boolean) | Read, Query, Write | **Public Read (`allow read: if true;`)**; Write by Superadmin or `canManageBadges` |

#### Detailed Analysis of `firestore.rules`
1. **Critical Privilege Flaw in `users/{userId}` Update**:
   - `firestore.rules` lines 113–115:
     ```javascript
     allow update: if isOwner(userId) || isSuperAdmin() || isRoleManagementUpdate() || 
                      (hasPermission('canManageUsers') && isValidUserData());
     ```
   - Notice the boolean logic: `isOwner(userId)` is checked with an `||` BEFORE `isValidUserData()`.
   - `isValidUserData()` is ONLY required if updating via `canManageUsers`. A normal authenticated user updating their own profile document (`isOwner(userId)`) is NOT subject to `isValidUserData()`.
   - As a result, **any authenticated user can write directly to their Firestore user document to modify `points: 99999`, `upvotes: 50000`, `badges: ['all']`, `displayRole: 'superadmin'`, or `isBlacklisted: false`**.
2. **Hardcoded Founder UID**:
   - Lines 34 and 122 hardcode `'pLW0PuQCTAQHCNK1SfllVhPZdMz1'` as absolute Super Admin.
3. **Data Exposure on `users` and `roles`**:
   - Line 99: `match /users/{userId} { allow get, list: if true; }`
   - Line 120: `match /roles/{userId} { allow get, list: if true; }`
   - The entire user registry, including email addresses, display names, points, vacation status, and internal role assignments, is readable by unauthenticated anonymous web visitors.
4. **Task Array-Containment Bug**:
   - `firestore.rules` line 232: `resource.data.assigneeId == request.auth.uid`.
   - In Cloud Functions (`functions/src/index.ts` line 97) and frontend components, tasks use `assigneeIds: string[]`. If a task only populates `assigneeIds` and leaves `assigneeId` undefined, non-superadmin assignees cannot read the task.
5. **Audit Log Spoofing**:
   - `firestore.rules` line 283: `match /audit_logs/{id} { allow create: if isSignedIn(); }`.
   - Any authenticated user can create arbitrary audit log documents with fake timestamps and spoofed actor data.
6. **Missing Rules for Backend Collections**:
   - Collections like `universal_submissions`, `leave_requests`, `applications`, `form_responses`, `points_ledger`, `competitions`, `dlq_points_retry`, `email_logs`, and `cache` have NO match blocks in `firestore.rules`. Firestore v2 enforces default-deny, preventing direct client tampering but requiring all client interactions to go through API routes.

---

### 1.3 Storage Pipelines & Rules

#### A. Storage Configuration & Buckets
- **Bucket**: `seds-pakistan.appspot.com` (configured in `src/firebase/config.ts` and `storage.rules`).
- **Second Bucket Reference**: `https://storage.sedspakistan.org/cad-uploads/` referenced in `src/app/api/get-upload-url/route.ts` line 18.

#### B. Storage Security Rules (`storage.rules`)
- **Admin Function**: Lines 5–14 check token custom claims:
  ```javascript
  function isProjectAdmin() {
    return request.auth != null && (
      request.auth.uid == 'pLW0PuQCTAQHCNK1SfllVhPZdMz1' ||
      request.auth.token.role == 'superadmin' ||
      request.auth.token.role == 'president' ||
      request.auth.token.role == 'vice_president' ||
      request.auth.token.role == 'projects_director' ||
      request.auth.token.role == 'chair_projects'
    );
  }
  ```
- **Defined Storage Paths**:
  1. `/project-images/{allPaths=**}`: Public read; Write restricted to `isProjectAdmin()`; size < 2MB; MIME `image/.*`.
  2. `/badge-images/{allPaths=**}`: Public read; Write restricted to `isProjectAdmin()`; size < 2MB; MIME `image/.*`.
  3. `/avatars/{userId}/{fileName}`: Public read; Write restricted to `request.auth.uid == userId`.
     - **Vulnerability**: **NO size limit check** and **NO MIME type check**. An authenticated user can upload arbitrary 100MB+ binary or HTML/SVG files.
  4. `/orders/{buyerId}/{orderId}/{fileName}`: Read restricted to buyer or `isProjectAdmin()`; Write restricted to buyer; size < 4MB; MIME `image/.*` or `application/pdf`.
  5. `/bug-reports/{reportId}/{fileName}`: Read restricted to `isProjectAdmin()`; Write restricted to authenticated users; size < 500KB; MIME `image/.*`.

#### C. CAD Dropzones & Sourcing Reality
- **Client Form Behavior**: In `src/components/sourcing-bridge/EngineeringIntakeForm.tsx` (lines 101–104, 605):
  - The form explicitly instructs users:
    > "Upload your 3D models (.STEP / .IGES), 2D technical drawings (.PDF), and BOM (.XLSX) to a Google Drive, OneDrive, GrabCAD, or GitHub folder and paste the share link with 'Anyone with link can view' enabled."
  - Field: `cadDriveLink: string`. It requires an `https://` URL.
  - **There is NO active frontend drag-and-drop file upload to Firebase Storage for CAD models**.
- **Mock Pre-Signed URL Generator**:
  - `src/app/api/get-upload-url/route.ts` (lines 18–25):
    ```typescript
    const uploadUrl = `https://storage.sedspakistan.org/cad-uploads/${uniqueFilename}`;
    return NextResponse.json({
      success: true,
      uploadUrl,
      downloadUrl: uploadUrl,
      filename: uniqueFilename,
    });
    ```
  - This is a stub/mock URL generator. It does not integrate with AWS S3, Google Cloud Storage, or Firebase Storage SDK to generate authentic presigned PUT/POST URLs.
- **ImageUploader Path Mismatch**:
  - `src/components/admin/image-uploader.tsx` (line 17) defines default path: `path = 'uploads/general'`.
  - In `storage.rules`, there is NO rule for `/uploads/**` or `/uploads/general/**`.
  - Any upload using the default path fails with `storage/unauthorized`.

---

### 1.4 External Services & APIs

#### A. Mailers & SMTP Services
1. **`src/lib/mailer.ts`**:
   - Transporter: Uses `nodemailer.createTransport` with Gmail service.
   - Fallback: Pool of Resend API keys rotated on failure.
   - **Secret Leakage**:
     - Line 11: `GMAIL_USER = 'salanaghazan@gmail.com'`
     - Line 12: `GMAIL_PASS = 'wnynspryimuatlvw'` (Plaintext Gmail 16-character App Password committed in clear text).
     - Lines 5–7: Three live Resend API keys hardcoded:
       - `re_gFB22PTt_...` (labeled Zubair Mongol)
       - `re_1oE3EdL3_...` (labeled Zubair Trading)
       - `re_cWrPM9sb_...` (labeled Fozeen)
   - **Insecure TLS**: Line 28 specifies `tls: { rejectUnauthorized: false }`, disabling certificate validation for SMTP.
2. **`src/lib/server/email-service.ts`**:
   - Supports `process.env.RESEND_API_KEY` and standard SMTP via environment variables (`EMAIL_SERVER_HOST`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`).
   - If credentials are not set, falls back to mock console output (`--- MOCK EMAIL LOG ---`).

#### B. Push Notifications & Messaging
- Client: Service Worker registered at `public/firebase-messaging-sw.js` with Firebase messaging background handlers.
- Token subscription: `src/lib/push-notifications.ts` using `getToken(messaging, { vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY })`.
- Server dispatch: `src/lib/server/push-server.ts` and `functions/src/index.ts` trigger `onNotificationCreatedDispatchPush` using `admin.messaging().sendEachForMulticast()`.

#### C. AI Integrations (Google Genkit & Gemini)
- **Genkit Framework**: `src/ai/genkit.ts` configures `googleai/gemini-2.5-flash` with `GOOGLE_GENAI_API_KEY`. Flows exist in `src/ai/flows/` (`research-copilot-flow.ts`, `study-guide-flow.ts`, `welcome-email-flow.ts`).
- **Gemini Key Rotation**: `src/lib/ai/key-manager.ts` pools `GEMINI_API_KEY`, `GEMINI_API_KEY_1` .. `GEMINI_API_KEY_10` with automatic 60-second cooldown on 429 throttling.
- **Unauthenticated AI Endpoints**:
  - `src/app/api/ai-task-generator/route.ts`: Public POST endpoint calling Gemini 1.5 Flash to generate mission step breakdowns. No auth check.
  - `src/app/api/ai/headquarters-advisor/route.ts`: Public POST endpoint calling Gemini 1.5 Pro to execute Machiavellian power analysis. No auth check.

#### D. Payment Gateway (Stripe)
- Integrated via `src/services/payment/providers/StripeProvider.ts`.
- Uses `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
- **Checkout Route Flaw**: `src/app/api/payments/checkout/route.ts` line 34: For store purchases, `amount = body.amount || 0`. Amount is unverified and controlled by the client.
- **Webhook Route**: `src/app/api/payments/webhook/route.ts` verifies `stripe-signature` via `paymentService.handleWebhook()`. Upon `checkout.session.completed`, updates `events/{id}.attendeeIds` and creates `orders` document.

#### E. Environment Variables Inventory
A total of **56 distinct `process.env.*` variables** were extracted from `src/` and `functions/src/`:
1. `ADMIN_NOTIFICATION_EMAIL`
2. `CONTACT_FROM_EMAIL`
3. `CONTACT_TO_EMAIL`
4. `CRON_SECRET`
5. `CSRF_SECRET`
6. `EMAIL_DAILY_LIMIT`
7. `EMAIL_FROM`
8. `EMAIL_SERVER_HOST`
9. `EMAIL_SERVER_PASSWORD`
10. `EMAIL_SERVER_PORT`
11. `EMAIL_SERVER_USER`
12. `FIREBASE_CLIENT_EMAIL`
13. `FIREBASE_CONFIG`
14. `FIREBASE_PRIVATE_KEY`
15. `FIREBASE_PROJECT_ID`
16. `FIREBASE_SERVICE_ACCOUNT`
17. `FIRESTORE_EMULATOR_HOST`
18. `GCLOUD_PROJECT`
19. `GEMINI_API_KEY`
20. `GEMINI_MODEL`
21. `GOOGLE_APPLICATION_CREDENTIALS`
22. `GOOGLE_CLOUD_PROJECT`
23. `GOOGLE_GENAI_API_KEY`
24. `NEXT_PUBLIC_APP_URL`
25. `NEXT_PUBLIC_BASE_URL`
26. `NEXT_PUBLIC_DEBUG_AUTH`
27. `NEXT_PUBLIC_DEBUG_FIRESTORE_HOOKS`
28. `NEXT_PUBLIC_ENABLE_ANALYTICS`
29. `NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS`
30. `NEXT_PUBLIC_ENABLE_PERFORMANCE`
31. `NEXT_PUBLIC_ENABLE_VISIT_TRACKING`
32. `NEXT_PUBLIC_FIREBASE_FOUNDER_UID`
33. `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
34. `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
35. `NEXT_PUBLIC_FIREBASE_VAPID_KEY`
36. `NEXT_PUBLIC_GEMINI_API_KEY`
37. `NEXT_PUBLIC_REALTIME_ENABLED`
38. `NEXT_PUBLIC_SITE_URL`
39. `NODE_ENV`
40. `PORT`
41. `RESEND_API_KEY`
42. `REVALIDATE_TOKEN`
43. `SMTP_FROM`
44. `SMTP_HOST`
45. `SMTP_PASS`
46. `SMTP_PORT`
47. `SMTP_USER`
48. `SOURCING_ADMIN_EMAIL`
49. `SOURCING_WEBHOOK_URL`
50. `STRIPE_SECRET_KEY`
51. `STRIPE_WEBHOOK_SECRET`
52. `SUPERADMIN_SETUP_TOKEN`
53. `SUPERADMIN_TARGET_UID`
54. `TELEGRAM_WEBHOOK_URL`
55. `VERCEL_ENV`
56. `VERCEL_URL`

---

### 1.5 Security Vulnerability & Risk Matrix

| Finding ID | Severity | File & Location | Vulnerability Description |
|---|---|---|---|
| **SEC-01** | **CRITICAL** | `src/app/api/webhooks/firestore/route.ts` (lines 8–24, 238–258) | **Remote Privilege Escalation via Unrestricted Webhook**: Webhook accepts any valid user ID token and processes client-supplied `after.role` without verifying database state, directly invoking `admin.auth().setCustomUserClaims(userId, { role: 'superadmin' })`. Any registered user can grant themselves Superadmin privileges. |
| **SEC-02** | **CRITICAL** | `src/lib/mailer.ts` (lines 5–12) | **Hardcoded Plaintext Credentials & Secret Leakage**: Gmail username, plaintext 16-character App Password, and 3 live Resend API keys are committed directly in source code. |
| **SEC-03** | **HIGH** | `firestore.rules` (lines 113–115) | **Direct User Document Points & Role Tampering**: `isOwner(userId)` update permission is not constrained by `isValidUserData()`, allowing any authenticated user to directly overwrite their `points`, `upvotes`, `downvotes`, `badges`, and `displayRole`. |
| **SEC-04** | **HIGH** | `src/app/api/payments/checkout/route.ts` (lines 11–37) | **Unauthenticated Checkout & Client-Controlled Price**: No user authentication; store purchase `amount` is taken directly from request body `body.amount` without server-side validation against product prices in Firestore. |
| **SEC-05** | **HIGH** | `src/lib/mailer.ts` (line 28) | **TLS Certificate Validation Disabled**: `rejectUnauthorized: false` allows Man-In-The-Middle (MITM) attacks during outbound SMTP communications. |
| **SEC-06** | **HIGH** | `firestore.rules` (lines 99, 120) | **Unauthenticated Public Read of User Directory & Roles**: Full `users` and `roles` collections are readable by anyone on the public internet, exposing member emails, university affiliations, and roles. |
| **SEC-07** | **HIGH** | `src/app/api/set-superadmin-claim/route.ts` (lines 19–85) | **Backdoor Claim Setter in Production**: Temporary UAT route granting superadmin claims remains active in the deployed codebase. |
| **SEC-08** | **HIGH** | `src/app/api/ai-task-generator/route.ts`, `src/app/api/ai/headquarters-advisor/route.ts` | **Unauthenticated Quota Drain on AI Endpoints**: Anyone can send infinite POST requests to invoke Gemini 1.5 Pro/Flash, consuming organization API quotas. |
| **SEC-09** | **MEDIUM** | Root repository (`middleware.ts` missing) | **Absence of Edge Route Protection**: Admin layout `/admin/*` relies entirely on client-side JS redirects; unauthenticated clients receive HTML and bundle code. |
| **SEC-10** | **MEDIUM** | `storage.rules` (line 35–38) | **Unrestricted Avatar Uploads**: `/avatars/{userId}/{fileName}` has no size cap or MIME filter, enabling denial-of-service via storage quota exhaustion. |
| **SEC-11** | **MEDIUM** | `src/app/api/cron/overdue/route.ts` (lines 13–17) | **Cron Auth Header Bypass**: Bypasses token verification if `x-vercel-cron` header is set or if `VERCEL_ENV !== 'production'`. |
| **SEC-12** | **MEDIUM** | `src/components/admin/image-uploader.tsx` (line 17) | **Storage Rules Path Mismatch**: Default upload path `uploads/general` is omitted from `storage.rules`, triggering upload failures. |
| **SEC-13** | **MEDIUM** | `src/app/api/get-upload-url/route.ts` (lines 18–25) | **Mock CAD Upload URL**: Generates non-functional URL string without real S3/GCS pre-signed URL integration. |
| **SEC-14** | **LOW** | `firestore.rules` (line 283) | **Unrestricted Audit Log Insertion**: Any authenticated user can create arbitrary audit log entries. |

---

## 2. Logic Chain

1. **Premise**: In modern web architectures, security boundaries must be enforced at the server or database rules level, not solely in frontend components.
   - **Observation 1.1.D**: Next.js Edge `middleware.ts` is absent. `src/app/admin/layout.tsx` enforces `canAccessAdmin` in a React `useEffect`.
   - **Deduction**: The client-side guard only prevents UI rendering in compliant browsers. If an attacker disables JS or inspects network responses, the entire admin page payload is delivered.
2. **Premise**: Database rules must enforce authorization and validate modified fields on every write.
   - **Observation 1.2**: `firestore.rules` line 113 states: `allow update: if isOwner(userId) || isSuperAdmin() || isRoleManagementUpdate() || (hasPermission('canManageUsers') && isValidUserData());`.
   - **Deduction**: Because `isOwner(userId)` is evaluated first with logical OR (`||`), any authenticated user is granted unrestricted update rights over their own user document, bypassing `isValidUserData()`. Users can trivially overwrite `points`, `badges`, and `isBlacklisted`.
3. **Premise**: Webhooks that trigger server-side Admin SDK operations must verify origin authenticity via cryptographic signatures or shared secrets.
   - **Observation 1.1.C & 1.4.C**: `/api/webhooks/firestore` accepts any Firebase Auth token (`if (!uid) return 401`). It extracts `after.role` directly from the request JSON and passes it to `admin.auth().setCustomUserClaims(userId, { role: newRole })`.
   - **Deduction**: A normal user with UID `XYZ` can send an HTTP POST request to `/api/webhooks/firestore` with `collection: "roles"`, `docId: "XYZ"`, `eventType: "update"`, and `after: { role: "superadmin" }`. The server unconditionally executes `setCustomUserClaims("XYZ", { role: "superadmin" })`. This constitutes an immediate remote privilege escalation to full Superadmin authority.
4. **Premise**: Source code committed to version control must be free of live secrets.
   - **Observation 1.4.A**: `src/lib/mailer.ts` contains literal strings for `GMAIL_PASS` and `RESEND_API_KEYS`.
   - **Deduction**: Clear-text secrets committed in the repository compromise both the organization's primary Gmail inbox and the Resend email delivery accounts.
5. **Premise**: Storage pipelines must match security rules and client capabilities.
   - **Observation 1.3.C**: The sourcing bridge form asks for external links; `/api/get-upload-url` returns a synthetic string; `image-uploader.tsx` uses `uploads/general` which has no storage rule.
   - **Deduction**: The "Hardware Pipeline" CAD upload dropzone is a mock capability (Tier 3) rather than a production-grade binary ingestion pipeline.

---

## 3. Caveats

1. **Live Cloud Network Isolation**:
   - In accordance with the non-destructive inspection mandate, no network requests were sent to live Firebase databases, Google Cloud APIs, or Stripe servers. All findings are derived from static source code analysis, AST inspection, and local harness verification.
2. **Runtime Deployment Environment Differences**:
   - Certain routes check `process.env.VERCEL_ENV === 'production'`. Behavior on preview branches or local development was verified via code paths and mock tokens (`dev_token`).
3. **Cloud Functions Deployment Status**:
   - `functions/src/index.ts` contains all Firestore reactive triggers. While the source code is present and builds to `functions/lib/index.js`, live verification of deployed Cloud Functions triggers in Google Cloud was not performed.
4. **No Caveats Beyond Stated Scope**:
   - The analysis covers 100% of routes, rules, configs, and backend services in the repository.

---

## 4. Conclusion

The SEDS Pakistan website exhibits a hybrid architecture with significant production-grade backend features alongside severe architectural vulnerabilities and mock stubs:

1. **Authentication & RBAC**: Real Firebase Auth is integrated with multi-channel session persistence (`__session` cookies for SSR). However, **RBAC enforcement is severely broken** due to:
   - Remote privilege escalation in `/api/webhooks/firestore`.
   - Client-only route guards for the `/admin` portal (lack of Next.js edge middleware).
   - Absolute bypass hardcoded to Founder UID `pLW0PuQCTAQHCNK1SfllVhPZdMz1`.
2. **Firestore Schema & Rules**: 224 collections and subcollections were mapped. Content collections (`blogs`, `events`, `projects`, `products`) have working Firestore persistence. However, `firestore.rules` has critical loopholes allowing owner document tampering (points/badges) and public exfiltration of the entire user registry. Over 12 backend collections lack rules entirely.
3. **Storage & Hardware Pipelines**: Storage rules exist for images, receipts, and bug reports, but lack avatar size limits. The CAD Dropzone is **non-functional/mock** (Tier 3): users are directed to paste external drive links, and the upload URL API returns a fake hardcoded URL.
4. **External Services**: Emailing uses an insecure setup in `src/lib/mailer.ts` with hardcoded credentials and disabled TLS verification. AI endpoints and the Stripe payment checkout route are unauthenticated and allow client-side tampering.
5. **Overall Maturity Tier**:
   - Core Content & Registration: **Tier 1 (Production Ready)**
   - Admin RBAC & Store Checkout: **Tier 2 (Impaired / Security Critical)**
   - CAD Sourcing Pipeline: **Tier 3 (Mock / Stub)**

---

## 5. Verification Method

To independently verify these findings, perform the following non-destructive checks:

### 1. Verify Hardcoded Secrets in Mailer
```bash
grep -n "GMAIL_PASS" src/lib/mailer.ts
grep -n "RESEND_API_KEYS" src/lib/mailer.ts
grep -n "rejectUnauthorized: false" src/lib/mailer.ts
```
*Expected Result*: Lines 5–8 show hardcoded Resend keys, line 12 shows plaintext Gmail pass, line 28 shows disabled TLS certificate validation.

### 2. Verify Privilege Escalation Vector in Webhook
Inspect `src/app/api/webhooks/firestore/route.ts`:
- Check lines 22–24: Any signed-in user passes auth.
- Check lines 48–50: `case 'roles': await handleRoleWritten(...)`.
- Check lines 246–252: Directly executes `auth.setCustomUserClaims(userId, claims)` using payload `after.role`.

### 3. Verify Client-Controlled Checkout Amount
Inspect `src/app/api/payments/checkout/route.ts`:
- Line 34: `amount = body.amount || 0;`
- Note the complete absence of `withAuth` or token verification.

### 4. Verify Firestore Rules Loopholes
Inspect `firestore.rules`:
- Line 99: `match /users/{userId} { allow get, list: if true; }` (Public read of user registry).
- Line 113: `allow update: if isOwner(userId) ...` (Owner updates without `isValidUserData()` validation).
- Line 34: Hardcoded UID `'pLW0PuQCTAQHCNK1SfllVhPZdMz1'`.

### 5. Verify Mock CAD Pre-Signed URL Generator
Inspect `src/app/api/get-upload-url/route.ts`:
- Line 18: `const uploadUrl = 'https://storage.sedspakistan.org/cad-uploads/${uniqueFilename}';`
- Returns static URL string without invoking any cloud storage SDK.

### 6. Verify Automated Harness Results
Inspect the generated audit inventories in `./audit_output/`:
- `audit_output/rbac_auth_inventory.json`
- `audit_output/storage_schemas.json`
- `audit_output/external_services.json`
- `audit_output/firestore_schema_inventory.json`
