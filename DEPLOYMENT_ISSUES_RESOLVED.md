# Firebase Deployment: Problems and Solutions

This document provides a comprehensive log of the deployment issues encountered for the SEDS Pakistan Website and the specific technical solutions implemented to resolve them.

---

## 🚀 Deployment Overview
- **Project**: SEDS Pakistan Website
- **Framework**: Next.js 15+ (App Router)
- **Deployment Platform**: Firebase Hosting (via Web Frameworks) + Cloud Functions v2
- **Status**: ✅ Successfully Deployed

---

## 🛠️ Issues Encountered & Resolved

### 1. Build Artifact Conflict (`distDir`)
**Problem:** Deployment failed with `ENOENT` or build errors because `next.config.js` had a custom `distDir: 'build'`. Firebase Hosting with Web Frameworks expects the default `.next` directory to orchestrate the SSR function and static asset deployment.
**Solution:** Removed `distDir: 'build'` from `next.config.js`. This allowed Firebase to correctly locate build outputs and handle the SSR integration.

### 2. Workspace File Locks (EPERM Errors)
**Problem:** The deployment process would hang or fail with "Permission Denied" errors when trying to overwrite files in `.next/trace` or the `build/` directory. This was caused by hung Node.js processes or the Firebase CLI analyzer holding file handles.
**Solution:**
1. Killed all background processes: `Get-Process | Where-Object { $_.ProcessName -like "*firebase*" -or $_.ProcessName -like "*node*" } | Stop-Process -Force`.
2. Manually deleted build directories: `Remove-Item -Recurse -Force build, .next, .firebase`.

### 3. Function Discovery Timeout
**Problem:** The Firebase CLI analyzer (Discovery phase) timed out while scanning Cloud Functions code. This happened because the Firebase Admin SDK and Firestore were being initialized in the global scope of `index.ts`.
**Solution:**
1. Implemented the `onInit()` hook from `firebase-functions/v2/core` to defer initialization until actual runtime.
2. Increased the CLI discovery timeout: `$env:FUNCTIONS_DISCOVERY_TIMEOUT=300`.
3. Refactored `index.ts` to use lazy-loading getters for `db`, `auth`, and `messaging`.

### 4. Function Trigger Type Conflict
**Problem:** Deployment failed for `onFormResponseSync` with the error: `Changing from an HTTPS function to a background triggered function is not allowed`. Firebase does not support changing the trigger type of an existing function in-place.
**Solution:** Manually deleted the existing function using the CLI before re-deploying the new version:
```bash
firebase functions:delete onFormResponseSync --force
```

### 5. Silent Build Failures (Output Redirection)
**Problem:** Using `> deploy.log 2>&1` in PowerShell sometimes caused the deployment process to hang or fail silently without showing the interactive progress of the Next.js build.
**Solution:** Switched to direct execution in the terminal to monitor real-time progress, ensuring the "Creating an optimized production build" step completed successfully.

### 6. Missing Dependencies (`cross-env`)
**Problem:** Scripts in `package.json` that used `cross-env` failed because the package was not installed or not in the system path.
**Solution:** Ran commands using native PowerShell environment variables (e.g., `$env:CI=1; npm run build`) or installed the missing dependency.

### 7. Next.js Config Type Conflict (`.ts` vs `.js`)
**Problem:** Having both `next.config.ts` and `next.config.js`, or using `next.config.ts` in an environment where the Firebase CLI's Next.js integration might struggle with TypeScript execution during the "discovery" phase.
**Solution:** Renamed `next.config.ts` to `next.config.ts.bak` and used a clean `next.config.js`. This ensured the Firebase CLI could reliably parse the configuration without needing a pre-compilation step.

### 8. Firebase Web Frameworks Experiment
**Problem:** Standard Firebase Hosting does not support SSR frameworks like Next.js out of the box without the `webframeworks` experiment enabled.
**Solution:** Enabled the required experiment:
```bash
firebase experiments:enable webframeworks
```

### 9. Function Dependency Sync
**Problem:** Cloud Functions were failing to deploy because of missing node_modules in the `functions/` subdirectory.
**Solution:** Ran a clean install specifically for the functions codebase:
```bash
npm --prefix functions install
```

---

## 📝 Key Files Modified
- [next.config.js](file:///e:/SEDS%20WEBSITE%20UPDATED%20SHIT/next.config.js): Removed custom build directory and standardized to JS.
- [functions/src/index.ts](file:///e:/SEDS%20WEBSITE%20UPDATED%20SHIT/functions/src/index.ts): Refactored for `onInit` and lazy initialization.
- [firebase.json](file:///e:/SEDS%20WEBSITE%20UPDATED%20SHIT/firebase.json): Verified hosting and functions configuration.
- [package.json](file:///e:/SEDS%20WEBSITE%20UPDATED%20SHIT/package.json): Verified build and deploy scripts.

---
*Date: 2026-03-02*
*System: SEDS Pakistan Website Deployment Team*
