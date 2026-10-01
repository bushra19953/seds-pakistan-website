/**
 * Data Integrity Cleanup Script for Store System
 * 
 * This script identifies and fixes corrupted products and orders that have:
 * - Missing or null price fields
 * - Invalid numeric values
 * - Data type inconsistencies
 * 
 * Run this script once to clean up existing data issues
 * 
 * Usage: node scripts/fix-store-data-integrity.js
 */

const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, updateDoc, doc, writeBatch, query, where } = require('firebase/firestore');
const { getFirebaseApp } = require('../src/firebase/provider');

// Initialize Firebase
const app = getFirebaseApp();
const db = getFirestore(app);

async function fixProductsData() {
  console.log('🔍 Scanning products collection for data integrity issues...');
  
  try {
    // Find products with missing or invalid prices
    const problematicProductsQuery = query(
      collection(db, 'products'),
      where('price', '==', null)
    );
    
    const snapshot = await getDocs(problematicProductsQuery);
    console.log(`Found ${snapshot.size} products with null price fields`);
    
    const batch = writeBatch(db);
    let fixedCount = 0;
    
    snapshot.forEach((productDoc) => {
      const product = productDoc.data();
      console.log(`Fixing product: ${productDoc.id} - ${product.name || 'Unnamed'}`);
      
      // Set default price to 0 for missing prices
      batch.update(productDoc.ref, {
        price: 0,
        updatedAt: new Date(),
        _fixedBy: 'data-integrity-script'
      });
      
      fixedCount++;
    });
    
    if (fixedCount > 0) {
      await batch.commit();
      console.log(`✅ Fixed ${fixedCount} products with missing price fields`);
    } else {
      console.log('✅ All products have valid price fields');
    }
    
  } catch (error) {
    console.error('❌ Error fixing products:', error);
  }
}

async function fixOrdersData() {
  console.log('🔍 Scanning orders collection for data integrity issues...');
  
  try {
    // Find orders with missing or invalid totals
    const problematicOrdersQuery = query(
      collection(db, 'orders'),
      where('total', '==', null)
    );
    
    const snapshot = await getDocs(problematicOrdersQuery);
    console.log(`Found ${snapshot.size} orders with null total fields`);
    
    const batch = writeBatch(db);
    let fixedCount = 0;
    
    snapshot.forEach((orderDoc) => {
      const order = orderDoc.data();
      console.log(`Fixing order: ${orderDoc.id}`);
      
      // Calculate total from items if available, otherwise set to 0
      let calculatedTotal = 0;
      if (order.items && Array.isArray(order.items)) {
        calculatedTotal = order.items.reduce((sum, item) => {
          const price = typeof item.price === 'number' ? item.price : 0;
          const quantity = typeof item.quantity === 'number' ? item.quantity : 0;
          return sum + (price * quantity);
        }, 0);
      }
      
      batch.update(orderDoc.ref, {
        total: calculatedTotal,
        updatedAt: new Date(),
        _fixedBy: 'data-integrity-script'
      });
      
      fixedCount++;
    });
    
    if (fixedCount > 0) {
      await batch.commit();
      console.log(`✅ Fixed ${fixedCount} orders with missing total fields`);
    } else {
      console.log('✅ All orders have valid total fields');
    }
    
  } catch (error) {
    console.error('❌ Error fixing orders:', error);
  }
}

async function fixOrderItems() {
  console.log('🔍 Scanning order items for data integrity issues...');
  
  try {
    // Get all orders to check item prices
    const allOrdersSnapshot = await getDocs(collection(db, 'orders'));
    const batch = writeBatch(db);
    let fixedItemCount = 0;
    let fixedOrderCount = 0;
    
    for (const orderDoc of allOrdersSnapshot.docs) {
      const order = orderDoc.data();
      let needsUpdate = false;
      
      if (order.items && Array.isArray(order.items)) {
        const fixedItems = order.items.map((item, index) => {
          let fixedItem = { ...item };
          
          // Fix missing or invalid prices
          if (typeof item.price !== 'number' || isNaN(item.price)) {
            fixedItem.price = 0;
            needsUpdate = true;
            fixedItemCount++;
          }
          
          // Fix missing or invalid quantities
          if (typeof item.quantity !== 'number' || isNaN(item.quantity) || item.quantity < 0) {
            fixedItem.quantity = 1;
            needsUpdate = true;
          }
          
          // Fix missing or invalid subtotals
          const expectedSubtotal = (fixedItem.price || 0) * (fixedItem.quantity || 1);
          if (typeof item.subtotal !== 'number' || isNaN(item.subtotal) || Math.abs(item.subtotal - expectedSubtotal) > 0.01) {
            fixedItem.subtotal = expectedSubtotal;
            needsUpdate = true;
          }
          
          return fixedItem;
        });
        
        if (needsUpdate) {
          // Recalculate total from fixed items
          const newTotal = fixedItems.reduce((sum, item) => sum + (item.subtotal || 0), 0);
          
          batch.update(orderDoc.ref, {
            items: fixedItems,
            total: newTotal,
            updatedAt: new Date(),
            _fixedBy: 'data-integrity-script'
          });
          
          fixedOrderCount++;
          console.log(`Fixed items in order: ${orderDoc.id} (new total: ${newTotal.toFixed(2)})`);
        }
      }
    }
    
    if (fixedOrderCount > 0) {
      await batch.commit();
      console.log(`✅ Fixed ${fixedItemCount} individual items across ${fixedOrderCount} orders`);
    } else {
      console.log('✅ All order items have valid data');
    }
    
  } catch (error) {
    console.error('❌ Error fixing order items:', error);
  }
}

async function generateReport() {
  console.log('📊 Generating data integrity report...');
  
  try {
    // Count all products
    const allProductsSnapshot = await getDocs(collection(db, 'products'));
    console.log(`Total products: ${allProductsSnapshot.size}`);
    
    // Count all orders
    const allOrdersSnapshot = await getDocs(collection(db, 'orders'));
    console.log(`Total orders: ${allOrdersSnapshot.size}`);
    
    // Check for products with valid prices
    let productsWithValidPrices = 0;
    allProductsSnapshot.forEach(doc => {
      const data = doc.data();
      if (typeof data.price === 'number' && !isNaN(data.price)) {
        productsWithValidPrices++;
      }
    });
    
    // Check for orders with valid totals
    let ordersWithValidTotals = 0;
    allOrdersSnapshot.forEach(doc => {
      const data = doc.data();
      if (typeof data.total === 'number' && !isNaN(data.total)) {
        ordersWithValidTotals++;
      }
    });
    
    console.log(`Products with valid prices: ${productsWithValidPrices}/${allProductsSnapshot.size}`);
    console.log(`Orders with valid totals: ${ordersWithValidTotals}/${allOrdersSnapshot.size}`);
    
    if (productsWithValidPrices === allProductsSnapshot.size && ordersWithValidTotals === allOrdersSnapshot.size) {
      console.log('🎉 All data integrity checks passed!');
    } else {
      console.log('⚠️  Some data integrity issues remain. Consider running this script again.');
    }
    
  } catch (error) {
    console.error('❌ Error generating report:', error);
  }
}

async function main() {
  console.log('🚀 Starting Store Data Integrity Cleanup...\n');
  
  try {
    await fixProductsData();
    console.log('');
    
    await fixOrdersData();
    console.log('');
    
    await fixOrderItems();
    console.log('');
    
    await generateReport();
    
    console.log('\n✅ Data integrity cleanup completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Review the changes made');
    console.log('2. Test the admin store interface');
    console.log('3. Consider implementing stricter data validation rules');
    
  } catch (error) {
    console.error('\n❌ Data integrity cleanup failed:', error);
    process.exit(1);
  }
}

// Run the cleanup script
if (require.main === module) {
  main();
}

module.exports = {
  fixProductsData,
  fixOrdersData,
  fixOrderItems,
  generateReport
};