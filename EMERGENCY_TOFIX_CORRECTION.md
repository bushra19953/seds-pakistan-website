# Emergency Fix: toFixed() Crash Correction

## Critical Bug Location
**File**: `src/app/admin/store/components/product-management.tsx` and `order-management.tsx`

## Problem
The page crashes when trying to format undefined prices or totals with `.toFixed(2)`.

## Immediate Solution

### 1. Product Management Component Fix

**Current Code (CRASHES)**:
```typescript
// Line 506 - Product list display
{product.currency} {product.price.toFixed(2)}

// Line 672 - Product details dialog
{selectedProduct.currency} {selectedProduct.price.toFixed(2)}
```

**Fixed Code (SAFE)**:
```typescript
// Line 506 - Product list display
{product.currency} {typeof product.price === 'number' ? product.price.toFixed(2) : '0.00'}

// Line 672 - Product details dialog  
{selectedProduct.currency} {typeof selectedProduct.price === 'number' ? selectedProduct.price.toFixed(2) : '0.00'}
```

### 2. Order Management Component Fix

**Current Code (CRASHES)**:
```typescript
// Line 500 - Order list display
{order.currency} {order.total.toFixed(2)}

// Line 649 - Order details dialog
{selectedOrder.currency} {selectedOrder.total.toFixed(2)}

// Line 721 - Order item display
{item.subtotal.toFixed(2)}

// Line 724 - Order item price display
{item.price.toFixed(2)} each
```

**Fixed Code (SAFE)**:
```typescript
// Line 500 - Order list display
{order.currency} {typeof order.total === 'number' ? order.total.toFixed(2) : '0.00'}

// Line 649 - Order details dialog
{selectedOrder.currency} {typeof selectedOrder.total === 'number' ? selectedOrder.total.toFixed(2) : '0.00'}

// Line 721 - Order item display
{typeof item.subtotal === 'number' ? item.subtotal.toFixed(2) : '0.00'}

// Line 724 - Order item price display
{typeof item.price === 'number' ? item.price.toFixed(2) : '0.00'} each
```

## Alternative: Utility Function Approach

Create a utility function for consistent number formatting:

```typescript
// src/lib/utils/number.ts
export const formatPrice = (price: any, currency: string = 'USD'): string => {
  if (typeof price === 'number' && !isNaN(price)) {
    return `${currency} ${price.toFixed(2)}`;
  }
  return `${currency} 0.00`;
};

export const formatTotal = (total: any): string => {
  if (typeof total === 'number' && !isNaN(total)) {
    return total.toFixed(2);
  }
  return '0.00';
};
```

Then use it in components:
```typescript
import { formatPrice, formatTotal } from '@/lib/utils/number';

// Instead of: {product.price.toFixed(2)}
{formatPrice(product.price, product.currency)}

// Instead of: {order.total.toFixed(2)}  
{formatTotal(order.total)}
```

## Data Integrity Check Script

Run this once to clean up corrupted data:

```javascript
// In Firebase Console > Firestore > Run in Web Shell
// Fix products with missing price
db.collection('products').where('price', '==', null).get().then(snapshot => {
  const batch = db.batch();
  snapshot.forEach(doc => {
    batch.update(doc.ref, { price: 0 });
  });
  return batch.commit();
});

// Fix orders with missing total
db.collection('orders').where('total', '==', null).get().then(snapshot => {
  const batch = db.batch();
  snapshot.forEach(doc => {
    batch.update(doc.ref, { total: 0 });
  });
  return batch.commit();
});
```

## Firestore Rules Enhancement

Add this to `firestore.rules` to prevent future issues:

```typescript
// In products collection rules
function isValidProductData() {
  return request.resource.data.name is string &&
         request.resource.data.name.size() > 0 &&
         request.resource.data.price is number &&
         request.resource.data.price >= 0 &&
         request.resource.data.price != null &&  // ADD THIS LINE
         // ... other validations
}
```

## Implementation Steps

1. **Immediate (5 minutes)**: Apply the type checking fixes shown above
2. **Short-term (1 day)**: Run the data cleanup script
3. **Long-term (1 week)**: Add the utility functions and update Firestore rules

This fix will resolve the "Cannot read properties of undefined (reading 'toFixed')" error immediately.