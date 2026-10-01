# SEDS Pakistan - Superadmin Creation Scripts

This directory contains secure administrative scripts for managing user roles in the SEDS Pakistan application.

## 🔐 Security Notice

These scripts use the **Firebase Admin SDK** with service account credentials to bypass Firestore security rules. They should only be run from trusted development/production environments with direct server access.

## 📋 Prerequisites

1. **Firebase Service Account Key** (Required)
   - Go to [Firebase Console](https://console.firebase.google.com)
   - Navigate to: Project Settings → Service Accounts
   - Click "Generate New Private Key"
   - Save the JSON file as `service-account-key.json` in the project root

2. **Node.js Dependencies**
   ```bash
   npm install firebase-admin
   ```

## 🚀 Usage

### Create Superadmin Script (`create-superadmin.js`)

This script elevates an existing Firebase Auth user to superadmin status.

#### Step 1: Create a User Account
1. Go to your website's signup page
2. Register with the email you want to make superadmin
3. Complete the signup process

#### Step 2: Run the Script
```bash
# Basic usage
node scripts/create-superadmin.js admin@example.com

# The script will:
# - Find the user by email in Firebase Auth
# - Create/update their role document with superadmin privileges
# - Update their user document with role information
# - Verify the role was created successfully
```

#### Step 3: Verify Success
- Check the console output for success messages
- The user can now log in and access `/admin/superadmin`
- They have full administrative privileges

## 🛡️ Security Features

- **Email Validation**: Ensures the email exists in Firebase Auth
- **Atomic Operations**: Uses batch writes for consistency
- **Role Verification**: Confirms the role was created successfully
- **Audit Trail**: Includes creation metadata (who, when, how)
- **Error Handling**: Comprehensive error messages and recovery suggestions

## 📊 Superadmin Privileges

A superadmin can:
- ✅ Access all admin dashboards (`/admin/*`)
- ✅ Create and manage other admin accounts
- ✅ Review induction applications
- ✅ Manage all content (projects, events, blogs)
- ✅ View audit logs
- ✅ Control user roles and permissions
- ✅ Override any Firestore security rules

## 🔧 Troubleshooting

### "Service account key not found"
- Download your service account key from Firebase Console
- Save it as `service-account-key.json` in the project root
- Or set `GOOGLE_APPLICATION_CREDENTIALS` environment variable

### "No Firebase Auth user found"
- The user must exist in Firebase Authentication first
- Have them sign up on the website before running the script
- Check the email address for typos

### "Permission denied" errors
- Ensure your service account has Editor/Owner role
- Check Firebase project settings and permissions
- Verify the service account key is valid and not expired

### Script hangs or times out
- Check your internet connection
- Verify Firebase project configuration
- Ensure Firestore is enabled in your Firebase project

## 🚨 Important Notes

1. **One-Time Setup**: This script is designed for initial setup and emergency use
2. **Audit Trail**: All role changes are logged in the `roles` collection
3. **Backup**: Consider backing up your Firestore data before running
4. **Testing**: Test on a development project first if possible
5. **Recovery**: Keep your service account key secure and backed up

## 📞 Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review Firebase Admin SDK documentation
3. Check the application logs for detailed error messages
4. Ensure all prerequisites are met

---

**Remember**: With great power comes great responsibility. Use these scripts wisely! 🦸‍♂️

---

## 🔄 Sync Custom Claims with Firestore Roles

Storage security rules rely on `request.auth.token.role`, which comes from Firebase Auth custom claims. Use the claims sync script to mirror roles from Firestore `roles/{uid}.role` into each user's custom claims.

### Script: `sync-custom-claims.js`

#### Prerequisites
- Service account credentials configured (see Security Notice above).

#### Commands
```bash
# Sync all users (production-safe when you know roles are correct)
npm run claims:sync:all

# Dry run (shows what would change without applying)
npm run claims:sync:dry

# Sync a single user by UID
npm run claims:sync -- --uid=USER_UID

# Sync a single user by email
npm run claims:sync -- --email=user@example.com
```

#### What it does
- Reads each user's role from `roles/{uid}.role`
- Sets the Auth custom claim `role` to match the Firestore value
- Preserves any other existing custom claims

#### When to run
- After changing a user's role document
- After onboarding a new admin (president, vice_president, projects_director, chair_projects)
- After migrating roles or restoring from backup

#### Troubleshooting
- "Failed to load service account key": ensure `GOOGLE_APPLICATION_CREDENTIALS` or `service-account-key.json` exists at project root
- "No role found": verify the user's document exists under `roles/{uid}` and has a `role` field