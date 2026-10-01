
import { hasPermission, injectRoleOverrides } from './src/config/permissions';
import { ADMIN_PERMISSIONS } from './src/config/permission-registry';

async function verifyOmniRole() {
  const customRole = 'omni_manager';
  const allPerms = Object.keys(ADMIN_PERMISSIONS);
  
  console.log(`SCENARIO: Verifying '${customRole}' with ALL permissions granted.`);
  
  // 1. Initial State (Expect failure for sensitive perms)
  const initialCheck = hasPermission(customRole, 'canManagePermissions');
  console.log(`Initial canManagePermissions: ${initialCheck} (Expect: false)`);
  
  if (initialCheck) {
    console.error("FAIL: Role should not have permissions before injection.");
    process.exit(1);
  }

  // 2. Simulate Firestore Injection (What happens after RolePrivilegesDrawer save)
  console.log("Injecting 100% permissions map...");
  injectRoleOverrides(customRole, allPerms);

  // 3. Verify System-Wide Access
  console.log("Verifying access to critical modules...");
  
  const testCases = [
    'canManagePermissions', // System
    'canManageBlogs',       // Content
    'canManageTasks',       // Operations
    'canManageStore',       // Organization
    'canViewAuditLogs'      // Oversight
  ];

  let allPassed = true;
  testCases.forEach(perm => {
    const result = hasPermission(customRole, perm);
    console.log(`- ${perm}: ${result ? '✅ GRANTED' : '❌ DENIED'}`);
    if (!result) allPassed = false;
  });

  if (!allPassed) {
    console.error("FAIL: Omni-role failed to resolve all permissions.");
    process.exit(1);
  }

  console.log("\nPASS: Frontend logic correctly resolves dynamic Omni-Roles.");
}

verifyOmniRole();
