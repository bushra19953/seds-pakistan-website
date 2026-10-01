# Fix Issue Hub Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve "Missing or insufficient permissions" on the Issue Hub page by updating Firestore security rules.

**Architecture:** Add missing collection matches to `firestore.rules` for `bug_reports` and `organizations`. Ensure `canManageBugReports` permission is respected. Use the existing `deploy_firebase_config.js` to push rules to production.

**Tech Stack:** Firebase Firestore Security Rules, Node.js (for deployment script).

---

### Task 1: Audit and Update Firestore Rules

**Files:**
- Modify: `firestore.rules`

- [ ] **Step 1: Add bug_reports and organizations matches to firestore.rules**

Add the following rules to the end of the `service cloud.firestore { match /databases/{database}/documents { ... } }` block:

```javascript
    // BUG REPORTS COLLECTION - PRIVATE BY DEFAULT
    match /bug_reports/{reportId} {
      allow read, write: if isSuperAdmin() || hasPermission('canManageBugReports');
      allow create: if isSignedIn(); // Allow any signed in user to report bugs
    }

    // ORGANIZATIONS COLLECTION - PUBLIC READ
    match /organizations/{organizationId} {
      allow get, list: if true;
      allow write: if isSuperAdmin() || hasPermission('canManageOrganizations');
    }
```

- [ ] **Step 2: Verify firestore.rules syntax**
Ensure the matches are correctly nested inside the documents block and don't duplicate existing entries.

### Task 2: Deploy Updated Rules

**Files:**
- Run: `node deploy_firebase_config.js`
- Check: `deploy_firebase_config.log`

- [ ] **Step 1: Execute deployment script**

Run: `node deploy_firebase_config.js`
Expected: "Deployment successful." in the console output.

- [ ] **Step 2: Verify deployment log**
Check `deploy_firebase_config.log` to ensure "firestore:rules" were uploaded.

### Task 3: Verification

- [ ] **Step 1: Test with Chrome DevTools**
Use `chrome-devtools-mcp` to navigate to `/admin/bugs` and check if the error is gone.
Since I am an AI, I will check the network logs or page content via MCP if needed.

- [ ] **Step 2: Final Commit**
```bash
git add firestore.rules
git commit -m "fix(security): add bug_reports and organizations to firestore rules"
```
