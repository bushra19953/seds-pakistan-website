# STAGE 7 — EDGE CASE & ERROR HANDLING AUDIT
## v11.0 SWARM DEPLOYED — STAGE 7/15
**AGENT 08 – EDGE CASE ENFORCER**

---

> **Thinking (COT):** Edge cases are where systems break and users lose trust. This audit covers auth failures, payment failures, rate limiting, concurrent edits, data corruption scenarios, and API error responses. Every edge case gets a diagnosis + resolution path.

---

## 🚨 Edge Case Catalog

---

### EC-001: Google OAuth Popup Blocked

**Condition:** User's browser blocks the OAuth popup  
**Symptoms:** "Sign in" button does nothing / popup flickers and closes  
**Resolution:**
1. User should allow popups for the site in browser settings
2. Or use redirect-based OAuth (alternative auth flow)
3. Chrome: Click address bar padlock → Site settings → Popups → Allow
4. Firefox: Address bar message "Firefox prevented this page from opening a popup"

---

### EC-002: Receipt Upload Failure

**Condition:** Network drops during receipt image upload to Firebase Storage  
**Symptoms:** Upload spinner hangs; "Upload failed" error  
**Impact:** User cannot submit payment  
**Resolution:**
1. User retries upload (UI has "Retry" button)
2. Firebase Storage upload is atomic — partial uploads are cleaned up
3. No partial order is created until upload succeeds
4. If persistent: Check if Firebase Storage quota exceeded (free tier: 5GB)

---

### EC-003: Duplicate Event Registration

**Condition:** User tries to register for same event twice  
**Symptoms:** API returns 409 Conflict  
**Impact:** Duplicate registration blocked  
**How Handled:** API checks if EventRegistrationDoc already exists for (uid, eventId) combination before creating  
**User Message:** "You are already registered for this event"

---

### EC-004: Invite Link Expired

**Condition:** User clicks invite link after `expiresAt` timestamp  
**Symptoms:** `/invite/[token]` shows error page  
**Resolution:** Admin must generate a new invite from `/admin/applications`

---

### EC-005: Event Published but No Store Product Configured

**Condition:** Admin sets isPaid=true but forgets to create/link Store product  
**Symptoms:** User clicks Register → gets redirected to /checkout?productId=undefined  
**Error:** 404 Not Found for product  
**Resolution:** Admin must create product in `/admin/store` and set `productId` on the event

---

### EC-006: Firestore Rules Return PERMISSION_DENIED

**Condition:** Client-side code tries to read/write without proper auth  
**Symptoms:** Console error "PERMISSION_DENIED: Missing or insufficient permissions"  
**Root Cause:** Firebase token expired, role check failed, or rule gap  
**Resolution:**
1. Sign out and sign back in (refreshes token)
2. Check `firestore.rules` for the collection in question
3. Admin: Check if role has been changed (signs out + back in required for role refresh)

---

### EC-007: User Role Not Refreshed After Change

**Condition:** Admin changes user's role → user is still on site  
**Symptoms:** User still sees old permissions  
**Reason:** Firebase ID token caches role for up to 1 hour  
**Resolution:** User must sign out and sign back in to get new token with updated role claim  
**Admin Note:** Always inform user to re-login after role change

---

### EC-008: Task Point Calculation Mismatch

**Condition:** Admin approves task but points not added  
**Symptoms:** Member's leaderboard score doesn't update  
**Root Cause:** Race condition in points update, or server-side function failed  
**Resolution:**
1. Admin manually adjusts points in `/admin/users/[uid]` → edit points field
2. Check Firestore `users/{uid}.points` value directly

---

### EC-009: Push Notification Not Received

**Condition:** FCM push not reaching user's browser  
**Possible Causes:**
| Cause | Check |
|---|---|
| Browser notifications blocked | User's browser settings |
| Service Worker not registered | Check browser DevTools → Application → Service Workers |
| VAPID key mismatch | Check `.env` NEXT_PUBLIC_FIREBASE_VAPID_KEY |
| FCM token expired | Re-subscribe on next site visit |
| User offline when sent | Push queued — delivered when back online (within 28 days) |

---

### EC-010: Full Site 500 Error (Firebase Functions)

**Condition:** All pages return 500  
**Possible Causes:**
- Firebase Cloud Functions cold start failure
- Admin SDK not initialized (missing service account env)
- Firestore quota exceeded  
**Resolution:**
1. Check Firebase Console → Functions → Logs
2. Check `.env.production` has all required values
3. Run `firebase deploy --only functions` if function code changed
4. Check Firestore usage in Firebase Console

---

### EC-011: Chapter Registration Form Not Appearing

**Condition:** Product has `formId` set but form doesn't appear in checkout  
**Root Cause:** Form document may be deleted or formId is incorrect  
**Resolution:** Admin checks `/admin/forms` to verify formId exists and is active

---

### EC-012: Audit Log Not Updating in Real-Time

**Condition:** Admin's audit log section shows stale data  
**Root Cause:** Firestore WebSocket connection dropped  
**Resolution:**
1. Refresh the page to re-establish connection
2. Check browser network tab for WebSocket errors
3. Ensure Firebase Firestore indexes exist for `audit_logs` ordered by `timestamp`

---

### EC-013: Banner/Announcement Persists After Expiry

**Condition:** Old announcement still showing in ticker after `broadcastUntil` date passed  
**Root Cause:** Client-side filter might use cached data  
**Resolution:** Hard refresh page (Ctrl+Shift+R). Admin can also toggle `showInTicker = false` manually.

---

### EC-014: User Cannot Access Profile After Ban Reversal

**Condition:** Admin unbans user but user still gets redirected to /banned  
**Root Cause:** Old Firebase ID token still has ban metadata cached  
**Resolution:** User must sign out completely, clear browser storage for the site, then sign back in

---

## 🛡️ Error Response Reference

| HTTP Status | Meaning | Typical Cause |
|---|---|---|
| 400 | Bad Request | Missing required fields, invalid data format |
| 401 | Unauthorized | No or invalid auth token |
| 403 | Forbidden | Valid token but insufficient role/permission |
| 404 | Not Found | Document doesn't exist in Firestore |
| 409 | Conflict | Duplicate record (e.g., already registered) |
| 429 | Too Many Requests | Rate limiter triggered (src/lib/rate-limiter.ts) |
| 500 | Server Error | Firebase Admin SDK failure, unhandled exception |

---

*AGENT 08 sign-off: 14 edge cases documented with diagnosis and resolution paths.*
