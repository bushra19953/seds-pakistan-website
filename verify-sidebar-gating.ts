
import { adminNav } from './src/config/admin-nav';
import { hasPermission, injectRoleOverrides } from './src/config/permissions';
import { ADMIN_PERMISSIONS } from './src/config/permission-registry';

function verifySidebarGating() {
  const customRole = 'omni_manager';
  const allPerms = Object.keys(ADMIN_PERMISSIONS);
  
  console.log(`SCENARIO: Verifying Sidebar visibility for '${customRole}'`);
  injectRoleOverrides(customRole, allPerms);

  let totalItems = 0;
  let visibleItems = 0;

  adminNav.forEach(group => {
    group.items.forEach(item => {
      totalItems++;
      const isVisible = item.requiredPermission ? hasPermission(customRole, item.requiredPermission) : true;
      if (isVisible) visibleItems++;
      else console.log(`- ❌ HIDDEN: ${item.label} (${item.requiredPermission})`);
    });
  });

  console.log(`\nResults: ${visibleItems}/${totalItems} items visible.`);

  if (visibleItems !== totalItems) {
    console.error("FAIL: Omni-role should see ALL sidebar items.");
    process.exit(1);
  }

  console.log("PASS: Omni-role bypasses all navigation gates.");
}

verifySidebarGating();
