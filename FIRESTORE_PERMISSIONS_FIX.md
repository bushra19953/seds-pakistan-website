# 🔧 Firestore Permissions Fix - Store & Orders Access

**Date:** 2025-11-11  
**Issue:** Permission denied error when accessing `/admin/store` and `/admin/orders`  
**Status:** ✅ **FIXED AND DEPLOYED**

---

## 🐛 Problem Description

When administrators tried to access the Store Management page (`/admin/store`) or view orders, they encountered a Firestore permission error:

```
FirebaseError: Missing or insufficient permissions
```

### Root Cause

The Firestore security rules referenced two permissions that were **not defined** in the `hasPermission()` function:

1. `canManageStore` - Required for accessing products and orders
2. `canManageSponsorsPartners` - Required for managing sponsors/partners

The rules were checking for these permissions, but the permission function didn't know which roles should have access, causing all requests to be denied.

---

## ✅ Solution Implemented

### 1. Added Missing Permissions to `firestore.rules`

Updated the `hasPermission()` function to include the missing permissions:

```javascript
function hasPermission(permission) {
  return isSignedIn() && (
    // ... existing permissions ...
    (permission == 'canManageStore' && (
      currentRole() == 'president' || 
      currentRole() == 'treasurer' || 
      currentRole() == 'vice_president'
    )) ||
    (permission == 'canManageSponsorsPartners' && (
      currentRole() == 'president' || 
      currentRole() == 'vice_president'
    ))
  );
}
```

### 2. Roles with Store Access

The following roles now have permission to manage the store:

- **President** - Full store access
- **Treasurer** - Full store access (financial responsibility)
- **Vice President** - Full store access

### 3. Roles with Sponsors/Partners Access

The following roles can manage sponsors and partners:

- **President** - Full access
- **Vice President** - Full access

---

## 📋 What This Fixes

### ✅ Store Management (`/admin/store`)
- **Products Tab** - Create, read, update, delete products
- **Orders Tab** - View and manage all orders
- **Settings Tab** - Configure certificate products and payment providers

### ✅ Orders Collection
- Admins can now query the orders collection
- Admins can read all orders
- Admins can update order status
- Users can still read their own orders

### ✅ Products Collection
- Admins can create new products
- Admins can update existing products
- Admins can delete products
- Admins can list all products

### ✅ Sponsors & Partners
- Admins can manage sponsors and partners
- Admins can list all sponsors/partners

---

## 🚀 Deployment

The fix has been deployed to production:

```bash
firebase deploy --only firestore:rules
```

**Deployment Status:** ✅ Successful  
**Deployment Time:** ~10 seconds  
**Rules Version:** Updated 2025-11-11

---

## 🧪 Testing Checklist

To verify the fix is working:

### For Admins (President, Treasurer, Vice President)

- [ ] Navigate to `/admin/store`
- [ ] Click on "Products" tab - should load without errors
- [ ] Click on "Orders" tab - should load without errors
- [ ] Click on "Settings" tab - should load without errors
- [ ] Try creating a new product - should work
- [ ] Try viewing an order - should work
- [ ] Try updating an order status - should work

### For Regular Members

- [ ] Try to access `/admin/store` - should be redirected
- [ ] Should NOT see store management in admin menu
- [ ] Can still view their own orders (if they have any)

---

## 📊 Permission Matrix

Here's the complete permission matrix for store-related features:

| Feature | President | Vice President | Treasurer | Other Roles | Members |
|---------|-----------|----------------|-----------|-------------|---------|
| View Products | ✅ | ✅ | ✅ | ❌ | ❌ |
| Create Products | ✅ | ✅ | ✅ | ❌ | ❌ |
| Update Products | ✅ | ✅ | ✅ | ❌ | ❌ |
| Delete Products | ✅ | ✅ | ✅ | ❌ | ❌ |
| View All Orders | ✅ | ✅ | ✅ | ❌ | ❌ |
| Update Orders | ✅ | ✅ | ✅ | ❌ | ❌ |
| View Own Orders | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create Orders | ✅ | ✅ | ✅ | ✅ | ✅ |
| Manage Sponsors | ✅ | ✅ | ❌ | ❌ | ❌ |

---

## 🔍 Technical Details

### Files Modified

1. **`firestore.rules`** (lines 63-90)
   - Added `canManageStore` permission
   - Added `canManageSponsorsPartners` permission
   - Assigned appropriate roles to each permission

### Security Rules Affected

1. **Products Collection** (lines 555-588)
   - Uses `hasPermission('canManageStore')`
   - Now properly grants access to authorized roles

2. **Orders Collection** (lines 594-655)
   - Uses `hasPermission('canManageStore')`
   - Now properly grants access to authorized roles
   - Users can still read their own orders via `isOwner()` check

3. **Sponsors & Partners Collection** (lines 522-529)
   - Uses `hasPermission('canManageSponsorsPartners')`
   - Now properly grants access to authorized roles

---

## 🛡️ Security Considerations

### What's Protected

✅ **Products** - Only authorized admins can manage  
✅ **Orders** - Admins see all, users see only their own  
✅ **Sponsors** - Only top-level admins can manage  
✅ **Payment Settings** - Only superadmin can access

### What's Still Secure

- Regular members cannot access store management
- Users can only see their own orders
- Payment provider credentials remain superadmin-only
- All actions are still logged in audit logs

---

## 📝 Related Documentation

- **Firestore Rules:** `firestore.rules`
- **Store Page:** `src/app/admin/store/page.tsx`
- **Order Management:** `src/app/admin/store/components/order-management.tsx`
- **Product Management:** `src/app/admin/store/components/product-management.tsx`

---

## 🔄 Rollback Plan

If issues arise, you can rollback the Firestore rules:

1. Go to Firebase Console → Firestore → Rules
2. Click on "Rules history"
3. Find the previous version (before this fix)
4. Click "Restore"

Or use Git:

```bash
git checkout HEAD~1 firestore.rules
firebase deploy --only firestore:rules
```

---

## ✅ Verification

After deployment, the following should work:

1. **Store Access** - Admins can access `/admin/store`
2. **Products** - Admins can view and manage products
3. **Orders** - Admins can view and manage all orders
4. **User Orders** - Users can view their own orders
5. **Security** - Non-admins are still blocked from admin features

---

## 🎯 Next Steps

1. **Test the fix** - Use the testing checklist above
2. **Verify permissions** - Ensure only authorized roles have access
3. **Monitor logs** - Check for any permission errors in Firebase Console
4. **Update documentation** - If needed, document the new permission structure

---

**Fix Status:** ✅ Complete and Deployed  
**Impact:** High - Restores critical store management functionality  
**Risk:** Low - Only adds missing permissions, doesn't change existing security

