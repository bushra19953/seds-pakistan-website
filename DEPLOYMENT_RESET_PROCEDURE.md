# 🔥 CRITICAL DEPLOYMENT RESET PROCEDURE 🔥

## **Instruction for the Coder**

Run this single command immediately to force redeploy the Firestore rules:

```bash
firebase deploy --only firestore:rules
```

---

## **CRITICAL INSTRUCTIONS FOR YOU (THE PROJECT OWNER)**

### **BROWSER CACHE CLEARING - REQUIRED STEPS:**

**Step 1: Hard Refresh with Cache Clear**
1. Press `F12` to open Developer Tools
2. **Right-click** on the browser refresh button (not left-click!)
3. Select **"Empty Cache and Hard Reload"** from the menu

**Step 2: Clear Site Data (if Step 1 doesn't work)**
1. Press `F12` to open Developer Tools
2. Go to **Application** tab (Chrome) or **Storage** tab (Firefox)
3. Click **"Clear site data"** or **"Clear all"**
4. Close and reopen browser

**Step 3: Nuclear Option (if still failing)**
1. Press `Ctrl + Shift + Delete`
2. Select **"All time"** for time range
3. Check **"Cached images and files"**
4. Click **"Clear data"**
5. Restart browser completely

### **⚠️ CRITICAL WARNING ⚠️**
**BOTH steps must be completed:**
- First, the coder MUST run the deployment command
- Second, YOU must perform the cache clearing steps above

**The permission error will NOT resolve until BOTH actions are completed.**