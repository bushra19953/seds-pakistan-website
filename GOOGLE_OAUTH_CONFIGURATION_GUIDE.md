# 🚨 Google OAuth 500 Error - Configuration Guide

## **CRITICAL: This is the #1 cause of the "500. That's an error" issue**

The Google OAuth 500 error is almost always caused by **incorrect configuration in Google Cloud Console**. Follow these steps exactly:

## **Step 1: Google Cloud Console Configuration**

### 1.1 Navigate to Google Cloud Console
- Go to [Google Cloud Console](https://console.cloud.google.com/)
- Select your project (should be the same project as your Firebase project)
- Navigate to **"APIs & Services" → "OAuth consent screen"**

### 1.2 Configure OAuth Consent Screen
**Status Check:**
- ✅ **CORRECT**: Status shows "In production"
- ❌ **WRONG**: Status shows "Testing" (this causes 500 errors for non-whitelisted users)

**If "Testing":**
- Option A: Add all users as "Test users" in the "Test users" section
- Option B: Click "Publish App" to make it publicly available

**Required Scopes:**
Add these scopes:
- `email`
- `profile` 
- `openid`

**Application Information:**
- Application name: Your app name
- User support email: Your email
- Authorized domains: Add your domain (e.g., `yoursite.com`)
- Developer contact information: Your email

### 1.3 Navigate to Credentials
- Go to **"APIs & Services" → "Credentials"**

### 1.4 Check OAuth 2.0 Client ID
- Find your "OAuth 2.0 Client ID" (Web client type)
- Click on it to edit

**Authorized Redirect URIs (CRITICAL):**
- ✅ Must include: `https://YOUR_PROJECT_ID.firebaseapp.com/__/auth/handler`
- ✅ Must include: `http://localhost:3000/__/auth/handler` (for local development)

**To find the correct URI:**
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to **"Authentication" → "Sign-in method"**
4. Click on "Google"
5. Copy the "Authorized redirect URI"

## **Step 2: Firebase Console Verification**

### 2.1 Check Authentication Settings
- Go to [Firebase Console](https://console.firebase.google.com/)
- Select your project
- Go to **"Authentication" → "Settings" → "Authorized domains"**
- Ensure your domain is listed

### 2.2 Verify Google Sign-in Method
- Go to **"Authentication" → "Sign-in method"**
- Click on "Google"
- Ensure it's enabled
- Check the redirect URI matches Google Cloud Console

## **Step 3: Required APIs**

Ensure these APIs are enabled in Google Cloud Console:
- **Identity and Access Management (IAM) API**
- **Google Identity API**
- **Identity Toolkit API**

To enable:
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. **"APIs & Services" → "Library"**
3. Search for each API and click "Enable"

## **Step 4: Test the Configuration**

### 4.1 Clear Browser Cache
- Clear all cookies and cache for your site
- Test in incognito/private mode

### 4.2 Test Flow
1. Go to your site
2. Click "Continue with Google"
3. Should redirect to Google sign-in (no 500 error)
4. Should return to your site successfully

## **Common Configuration Mistakes**

### ❌ **Mistake 1: Testing Mode**
- **Problem**: OAuth consent screen in "Testing" mode
- **Solution**: Publish the app or add users as test users

### ❌ **Mistake 2: Wrong Redirect URI**
- **Problem**: Redirect URI doesn't match Firebase configuration
- **Solution**: Copy exact URI from Firebase Console

### ❌ **Mistake 3: Missing Scopes**
- **Problem**: Missing required scopes
- **Solution**: Add `email`, `profile`, `openid` scopes

### ❌ **Mistake 4: Disabled APIs**
- **Problem**: Required APIs not enabled
- **Solution**: Enable all required APIs listed above

### ❌ **Mistake 5: Wrong Project**
- **Problem**: Google Cloud project doesn't match Firebase project
- **Solution**: Ensure both are the same project

## **Verification Checklist**

- [ ] Google Cloud Console project matches Firebase project
- [ ] OAuth consent screen status is "In production"
- [ ] Required scopes added: `email`, `profile`, `openid`
- [ ] OAuth 2.0 Client ID has correct redirect URIs
- [ ] Required APIs are enabled
- [ ] Domain authorized in Firebase Authentication
- [ ] Test in incognito mode

## **If Problems Persist**

### Error: "redirect_uri_mismatch"
- **Cause**: Redirect URI in Google Cloud Console doesn't match Firebase
- **Fix**: Update redirect URI in Google Cloud Console to match Firebase exactly

### Error: "access_denied"
- **Cause**: User denied permission
- **Fix**: This is normal user behavior, not a configuration error

### Error: "invalid_client"
- **Cause**: Wrong Client ID or Client Secret
- **Fix**: Check OAuth 2.0 Client ID configuration

## **Testing URLs**

Use these to test your configuration:
- **Production**: `https://yourdomain.com/auth`
- **Development**: `http://localhost:3000/auth`

## **Emergency Contact**

If you continue to get 500 errors after following this guide:
1. Double-check all steps above
2. Test with a different Google account
3. Check browser console for detailed error messages
4. Verify your Firebase project settings match your Google Cloud project

**Remember**: The 500 error is **always** a Google Cloud Console configuration issue, not a code problem.