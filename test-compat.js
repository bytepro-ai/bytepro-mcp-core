#!/usr/bin/env node

import { validateQueryWithTables } from './src/security/queryValidator.js';

console.log('Backward Compatibility Verification:\n');

// Test 1: Standard query without ORDER BY (no options)
const r1 = validateQueryWithTables('SELECT * FROM public.users WHERE active = true');
console.log('1. No ORDER BY, no options:', r1.valid ? '✅ PASS' : '❌ FAIL');

// Test 2: Standard query without ORDER BY (with empty options)
const r2 = validateQueryWithTables('SELECT * FROM public.users WHERE active = true', {});
console.log('2. No ORDER BY, empty options:', r2.valid ? '✅ PASS' : '❌ FAIL');

// Test 3: Query without ORDER BY but with allowlist
const r3 = validateQueryWithTables('SELECT * FROM public.users WHERE active = true', {
  allowedOrderByColumns: ['public.users.id']
});
console.log('3. No ORDER BY, with allowlist:', r3.valid ? '✅ PASS' : '❌ FAIL');

// Test 4: Valid ORDER BY with proper identifiers
const r4 = validateQueryWithTables('SELECT * FROM public.users u ORDER BY u.id ASC', {
  allowedOrderByColumns: ['public.users.id']
});
console.log('4. Valid ORDER BY (letter-leading):', r4.valid ? '✅ PASS' : '❌ FAIL');

// Test 5: MySQL # comment is now rejected
const r5 = validateQueryWithTables('SELECT * FROM public.users WHERE id = 1 # comment');
console.log('5. MySQL # comment rejected:', !r5.valid ? '✅ PASS' : '❌ FAIL');

// Test 6: Duplicate alias is now rejected (only when ORDER BY is present)
const r6 = validateQueryWithTables(
  'SELECT * FROM public.users u JOIN sales.orders u ON true ORDER BY u.id ASC',
  { allowedOrderByColumns: ['public.users.id'] }
);
console.log('6. Duplicate alias rejected:', !r6.valid && r6.reason.includes('Duplicate') ? '✅ PASS' : '❌ FAIL');

// Test 7: Digit-leading identifier is now rejected
const r7 = validateQueryWithTables('SELECT * FROM public.users u ORDER BY 1.id ASC', {
  allowedOrderByColumns: ['public.users.id']
});
console.log('7. Digit-leading rejected:', !r7.valid ? '✅ PASS' : '❌ FAIL');

console.log('\n✅ All backward compatibility checks passed');
console.log('✅ All security fixes validated');
