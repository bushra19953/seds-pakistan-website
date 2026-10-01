/**
 * Utility functions for safe number formatting
 * Prevents crashes from undefined/null values in toFixed() calls
 */

/**
 * Safely formats a price with currency
 * @param price - The price value (can be undefined, null, or number)
 * @param currency - The currency code (default: 'USD')
 * @returns Formatted price string
 */
export const formatPrice = (price: any, currency: string = 'USD'): string => {
  if (typeof price === 'number' && !isNaN(price)) {
    return `${currency} ${price.toFixed(2)}`;
  }
  return `${currency} 0.00`;
};

/**
 * Safely formats a number to 2 decimal places
 * @param value - The value to format (can be undefined, null, or number)
 * @param fallback - The fallback value if the input is invalid (default: '0.00')
 * @returns Formatted number string
 */
export const formatNumber = (value: any, fallback: string = '0.00'): string => {
  if (typeof value === 'number' && !isNaN(value)) {
    return value.toFixed(2);
  }
  return fallback;
};

/**
 * Safely formats a total amount
 * @param total - The total value (can be undefined, null, or number)
 * @param currency - The currency code
 * @returns Formatted total string
 */
export const formatTotal = (total: any, currency: string = 'USD'): string => {
  return formatPrice(total, currency);
};

/**
 * Safely formats item subtotal
 * @param subtotal - The subtotal value (can be undefined, null, or number)
 * @param currency - The currency code
 * @returns Formatted subtotal string
 */
export const formatSubtotal = (subtotal: any, currency: string = 'USD'): string => {
  return formatPrice(subtotal, currency);
};

/**
 * Type guard to check if a value is a valid number
 * @param value - The value to check
 * @returns True if the value is a valid number
 */
export const isValidNumber = (value: any): value is number => {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
};

/**
 * Safely converts a value to number with fallback
 * @param value - The value to convert
 * @param fallback - The fallback value if conversion fails (default: 0)
 * @returns A valid number
 */
export const safeNumber = (value: any, fallback: number = 0): number => {
  if (isValidNumber(value)) {
    return value;
  }
  const parsed = parseFloat(value);
  return isValidNumber(parsed) ? parsed : fallback;
};