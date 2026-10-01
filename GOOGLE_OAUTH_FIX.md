# 🚨 CRITICAL: Google OAuth 500 Error Fix Guide

## Problem Summary

Users are experiencing a **"500. That's an error"** message from Google when attempting to sign in with Google. This is a **BLOCKER** issue preventing all users from accessing the platform.

### User Reports:
- "I'm trying again n again to sign up.. But i can't login."
- "It's showing the Google email selection page over n over again."
- "I couldn't log in on my phone... please try on your laptops."

## Root Cause

The 500 error from Google indicates that **your OAuth configuration in Google Cloud Console is incorrect or incomplete**. This is NOT a code issue - it's a configuration issue in your Google Cloud project.

## Step-by-Step Fix

### Step 1: Access Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project: **seds-pakistan** (Project ID: `seds-pakistan`)
3. If you don't have access, you need to get access from the project owner

### Step 2: Check OAuth Consent Screen

1. Navigate to: **APIs & Services** → **OAuth consent screen**
2. **Critical Check #1: Publishing Status**
   - Look at the top of the page for "Publishing status"
   - If it says **"Testing"**, this is likely your problem!
   - **Solution**: 
     - Option A: Click **"PUBLISH APP"** to make it available to all users
     - Option B: If you want to keep it in testing mode, add ALL users as "Test users" (not scalable)

3. **Critical Check #2: Required Scopes**
   - Scroll down to "Scopes" section
   - Ensure these scopes are added:
     - `email`
     - `profile`
     - `openid`
   - If missing, click "ADD OR REMOVE SCOPES" and add them

4. **Critical Check #3: App Information**
   - Ensure all required fields are filled:
     - App name: "SEDS Pakistan Digital Hub" (or similar)
     - User support email: Valid email address
     - Developer contact information: Valid email address
     - App logo (optional but recommended)

### Step 3: Verify OAuth 2.0 Client ID

1. Navigate to: **APIs & Services** → **Credentials**
2. Find your **OAuth 2.0 Client ID** (should be type "Web application")
3. Click on it to edit
4. **Critical Check #4: Authorized JavaScript origins**
   - Add these origins:
     ```
     http://localhost:3000
     https://seds-pakistan.web.app
     https://seds-pakistan.firebaseapp.com
     https://your-custom-domain.com (if you have one)
     ```

5. **Critical Check #5: Authorized redirect URIs**
   - This is THE MOST IMPORTANT setting!
   - Add these exact URIs:
     ```
     http://localhost:3000/__/auth/handler
     https://seds-pakistan.web.app/__/auth/handler
     https://seds-pakistan.firebaseapp.com/__/auth/handler
     https://your-custom-domain.com/__/auth/handler (if you have one)
     ```
   - **Note**: The `/__/auth/handler` path is Firebase's OAuth callback URL
   - **Note**: Make sure there are NO trailing slashes!

6. Click **SAVE**

### Step 4: Verify Firebase Configuration

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: **seds-pakistan**
3. Navigate to: **Authentication** → **Sign-in method**
4. Find **Google** in the list
5. **Critical Check #6: Google Sign-in Enabled**
   - Ensure the toggle is **ON** (enabled)
   - Click on it to expand
   - Verify the Web SDK configuration shows your Client ID
   - The "Web client ID" should match the one from Google Cloud Console

### Step 5: Enable Required APIs

1. Back in Google Cloud Console
2. Navigate to: **APIs & Services** → **Library**
3. Search for and enable these APIs:
   - **Identity Toolkit API** (CRITICAL - this is what Firebase Auth uses)
   - **Cloud Firestore API**
   - **Firebase Management API**

### Step 6: Test the Fix

1. Clear your browser cache and cookies
2. Try signing in with Google on:
   - Desktop browser (Chrome, Firefox, Safari)
   - Mobile browser (Chrome on Android, Safari on iOS)
3. Check the browser console for any errors (F12 → Console tab)

## Common Issues and Solutions

### Issue: "Access blocked: This app's request is invalid"
**Solution**: Your OAuth consent screen is not properly configured. Go back to Step 2.

### Issue: "redirect_uri_mismatch"
**Solution**: The redirect URI in your Firebase config doesn't match Google Cloud Console. Go back to Step 3, Check #5.

### Issue: Still getting 500 error after all fixes
**Solutions**:
1. Wait 5-10 minutes for Google's servers to propagate the changes
2. Clear browser cache completely
3. Try in an incognito/private window
4. Check if you have multiple Google Cloud projects and are editing the wrong one

### Issue: Works on desktop but not mobile
**Solution**: This is likely a popup blocker issue. The code already handles this by using `signInWithRedirect` on mobile. If still failing, check mobile browser settings.

## Verification Checklist

Before considering this fixed, verify:

- [ ] OAuth Consent Screen is published (or all users are added as test users)
- [ ] All required scopes (email, profile, openid) are added
- [ ] Authorized JavaScript origins include your domains
- [ ] Authorized redirect URIs include `/__/auth/handler` for all domains
- [ ] Google sign-in is enabled in Firebase Console
- [ ] Identity Toolkit API is enabled in Google Cloud Console
- [ ] Tested on both desktop and mobile browsers
- [ ] No errors in browser console during sign-in
- [ ] Users can successfully sign in and are redirected to their profile

## Additional Resources

- [Firebase Auth Setup Guide](https://firebase.google.com/docs/auth/web/google-signin)
- [Google OAuth 2.0 Setup](https://developers.google.com/identity/protocols/oauth2)
- [Common OAuth Errors](https://developers.google.com/identity/protocols/oauth2/web-server#handlingresponse)

## Contact Information

If you continue to experience issues after following this guide:
1. Check the browser console for specific error messages
2. Check Firebase Console → Authentication → Users to see if accounts are being created
3. Contact Firebase Support with your project ID: `seds-pakistan`

---

**Last Updated**: 2025-11-11
**Priority**: CRITICAL - BLOCKER
**Estimated Fix Time**: 15-30 minutes (configuration only, no code changes needed)

