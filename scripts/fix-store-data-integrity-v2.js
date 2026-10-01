/**
 * Data Integrity Cleanup Script for Store System (V2 - Admin SDK)
 * 
 * This script identifies and fixes corrupted products and orders that have:
 * - Missing or null price fields
 * - Invalid numeric values
 * - Data type inconsistencies
 * 
 * Usage: node scripts/fix-store-data-integrity-v2.js
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');

// Path to your service account key file
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'seds-pakistan-service-account.json');

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error(`❌ Service account key not found at ${SERVICE_ACCOUNT_PATH}`);
  process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

async function fixProductsData() {
  console.log('🔍 Scanning products collection for data integrity issues...');
  
  try {
    const productsRef = db.collection('products');
    const snapshot = await productsRef.get();
    
    let fixedCount = 0;
    const batch = db.batch();
    
    snapshot.forEach((doc) => {
      const product = doc.data();
      let needsFix = false;
      const updates = {};
      
      // Check for null or missing price
      if (product.price === null || product.price === undefined || isNaN(product.price)) {
        updates.price = 0;
        needsFix = true;
      }
      
      // Check for null or missing stock
      if (product.stock === null || product.stock === undefined || isNaN(product.stock)) {
        updates.stock = 0;
        needsFix = true;
      }

      if (needsFix) {
        console.log(`Fixing product: ${doc.id} - ${product.name || 'Unnamed'}`);
        updates.updatedAt = FieldValue.serverTimestamp();
        updates._fixedBy = 'data-integrity-script-v2';
        batch.update(doc.ref, updates);
        fixedCount++;
      }
    });
    
    if (fixedCount > 0) {
      await batch.commit();
      console.log(`✅ Fixed ${fixedCount} products with data integrity issues`);
    } else {
      console.log('✅ All products have valid data');
    }
    
  } catch (error) {
    console.error('❌ Error fixing products:', error);
  }
}

async function fixOrdersData() {
  console.log('🔍 Scanning orders collection for data integrity issues...');
  
  try {
    const ordersRef = db.collection('orders');
    const snapshot = await ordersRef.get();
    
    let fixedCount = 0;
    const batch = db.batch();
    
    snapshot.forEach((doc) => {
      const order = doc.data();
      let needsFix = false;
      const updates = {};
      
      // Check for null or missing total
      if (order.total === null || order.total === undefined || isNaN(order.total)) {
        // Calculate total from items if available
        let calculatedTotal = 0;
        if (order.items && Array.isArray(order.items)) {
          calculatedTotal = order.items.reduce((sum, item) => {
            const price = typeof item.price === 'number' ? item.price : 0;
            const quantity = typeof item.quantity === 'number' ? item.quantity : 0;
            return sum + (price * quantity);
          }, 0);
        }
        updates.total = calculatedTotal;
        needsFix = true;
      }

      if (needsFix) {
        console.log(`Fixing order: ${doc.id}`);
        updates.updatedAt = FieldValue.serverTimestamp();
        updates._fixedBy = 'data-integrity-script-v2';
        batch.update(doc.ref, updates);
        fixedCount++;
      }
    });
    
    if (fixedCount > 0) {
      await batch.commit();
      console.log(`✅ Fixed ${fixedCount} orders with data integrity issues`);
    } else {
      console.log('✅ All orders have valid data');
    }
    
  } catch (error) {
    console.error('❌ Error fixing orders:', error);
  }
}

async function run() {
  await fixProductsData();
  await fixOrdersData();
  console.log('🏁 Data integrity check complete.');
}

run().catch(console.error);
