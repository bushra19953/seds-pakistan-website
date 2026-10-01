# 🔐 SEDS Pakistan - Initial Superadmin Setup Guide

## Overview

This guide provides a secure, step-by-step process for creating the initial superadmin account for your SEDS Pakistan application. This is a **critical security operation** that should only be performed by authorized personnel with direct server access.

## 🚨 Important Security Notice

- This process uses Firebase Admin SDK with elevated privileges
- Only run these commands from trusted development/production environments
- Keep your service account key secure and never commit it to version control
- This is a one-time setup process for initial system bootstrap

## 📋 Prerequisites

### 1. Firebase Service Account Key
**REQUIRED** - You must have a Firebase service account key to proceed.

**To obtain your service account key:**
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project (`min-seds`)
3. Navigate to: **Project Settings** → **Service Accounts**
4. Click **"Generate New Private Key"**
5. Save the JSON file as `service-account-key.json` in your project root directory

### 2. Node.js Environment
Ensure you have Node.js 18+ installed:
```bash
node --version
```

### 3. Install Dependencies
```bash
npm install firebase-admin
```

## 🎯 Step-by-Step Setup Process

### Step 1: Create a Regular User Account

**First, you need to create a normal user account that will become the superadmin.**

1. **Navigate to your website**: Open your SEDS Pakistan website
2. **Go to Signup**: Click "Join Us" or navigate to `/auth/signup`
3. **Register with your admin email**: Use the email address you want as superadmin
4. **Complete signup**: Fill in all required fields and submit
5. **Verify account**: Check your email and verify if email verification is enabled

**⚠️ Important**: Make sure you can successfully log in with this account before proceeding!

### Step 2: Run the Superadmin Creation Script

**Now elevate your regular account to superadmin status.**

```bash
# Navigate to your project directory
cd /path/to/seds-pakistan-website

# Run the superadmin creation script
node scripts/create-superadmin.js your-admin-email@example.com
```

**Example:**
```bash
node scripts/create-superadmin.js founder@minseds.com
```

### Step 3: Verify the Script Output

**You should see output like this:**
```
🔐 SEDS Pakistan - Superadmin Creation Script
================================================
📧 Looking for user with email: founder@minseds.com
🔍 Searching for Firebase Auth user...
✅ Found user: abc123def456 (founder@minseds.com)
📝 Creating superadmin role for user: abc123def456

🎉 SUCCESS! Superadmin role created!
======================================
User UID: abc123def456
Email: founder@minseds.com
Display Name: Founder
Role: superadmin
Created At: 2025-01-15T12:34:56.789Z

✅ The user now has full administrative privileges:
   - Access to /admin/superadmin dashboard
   - Can create and manage other admin accounts
   - Full control over all content and users
   - Can review induction applications
   - Can manage projects, events, and blogs

🔍 Verifying role creation...
✅ Role verification: PASSED

🚀 The user can now log in and access the admin dashboard!
```

### Step 4: Test Your Superadmin Access

**Log in and verify your superadmin privileges:**

1. **Log out** of your current session (if logged in)
2. **Log back in** with your superadmin account
3. **Navigate to admin dashboard**: Go to `/admin`
4. **Verify access**: You should see all admin sections available
5. **Test superadmin features**:
   - Go to `/admin/superadmin` (should be accessible)
   - Try creating another admin account
   - Check if you can view audit logs at `/admin/audit`

## 🔧 Troubleshooting

### Common Issues and Solutions

#### "Service account key not found"
```
❌ Service account key not found!

Please download your Firebase service account key from:
1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate New Private Key"
3. Save the JSON file as one of these names:
   - service-account-key.json (recommended)
   - firebase-service-account.json
   - serviceAccountKey.json
```

**Solution**: Download and save your service account key as `service-account-key.json` in the project root.

#### "No Firebase Auth user found"
```
❌ No Firebase Auth user found with email: your-email@example.com

To create a superadmin:
1. First, sign up on the website with this email address
2. Then run this script again with the same email

The user must exist in Firebase Authentication before assigning roles.
```

**Solution**: 
1. Create a user account on your website first
2. Ensure you can log in with that account
3. Run the script again with the correct email

#### "Permission denied" errors
**Solution**:
- Ensure your service account has **Editor** or **Owner** role in Firebase
- Check Firebase project settings and permissions
- Verify the service account key is valid and not expired

#### Script hangs or times out
**Solution**:
- Check your internet connection
- Verify Firebase project configuration
- Ensure Firestore is enabled in your Firebase project

## 🛡️ Security Best Practices

### 1. Service Account Key Management
- **Store securely**: Keep `service-account-key.json` in a secure location
- **Never commit**: Add to `.gitignore` immediately
- **Rotate regularly**: Generate new keys periodically
- **Limit access**: Only authorized personnel should have access

### 2. Audit Trail
The script automatically creates an audit trail:
- Role creation is logged in Firestore `roles` collection
- Includes timestamp, creator info, and user details
- Superadmins can view audit logs at `/admin/audit`

### 3. Post-Setup Security
After creating your superadmin:
1. **Remove service account key** from development machines if not needed
2. **Store key securely** in production environment (environment variables, secrets manager)
3. **Monitor access** regularly through Firebase Console
4. **Review audit logs** periodically for suspicious activity

## 🚀 Next Steps

Once your superadmin is set up:

1. **Test the induction flow** as planned:
   - Submit an application as a member
   - Review and shortlist as superadmin
   - Create an invite
   - Verify invite creation in Firestore

2. **Create additional admin accounts** if needed:
   - Use the `/admin/superadmin` dashboard
   - Assign appropriate roles (admin, team_leader, etc.)

3. **Configure production environment**:
   - Set up proper environment variables
   - Configure CI/CD for automated deployments
   - Set up monitoring and alerting

## 📞 Emergency Procedures

### Lost Superadmin Access
If you lose access to your superadmin account:
1. Create a new user account on the website
2. Run this script again with the new email
3. Use the new superadmin account to recover access

### Compromised Service Account Key
If your service account key is compromised:
1. Immediately revoke the key in Firebase Console
2. Generate a new service account key
3. Update your deployment scripts and environments
4. Review audit logs for unauthorized access

---

## ✅ Setup Completion Checklist

- [ ] Service account key downloaded and saved as `service-account-key.json`
- [ ] Regular user account created on website
- [ ] Superadmin creation script executed successfully
- [ ] Superadmin access verified in admin dashboard
- [ ] Service account key stored securely (not in version control)
- [ ] Audit logs reviewed for successful role creation
- [ ] Ready to proceed with induction system testing

---

**🎉 Congratulations!** You now have a secure superadmin account and can proceed with testing your SEDS Pakistan application. The induction system testing can now begin as planned.

**Remember**: This is a powerful administrative tool. Use it responsibly and keep your credentials secure! 🔐