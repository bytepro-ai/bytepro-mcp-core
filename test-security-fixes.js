#!/usr/bin/env node

/**
 * Security Blocker Fixes Validation
 * Tests for the three specific security fixes applied
 */

import { validateQueryWithTables } from './src/security/queryValidator.js';

const allowedOrderByColumns = [
  'public.users.id',
  'public.users.created_at',
];

let passed = 0;
let failed = 0;

function test(name, query, options, expected) {
  try {
    const result = validateQueryWithTables(query, options);
    const success = result.valid === expected.valid;

    if (success) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}`);
      console.log(`   Expected valid: ${expected.valid}`);
      console.log(`   Got: ${JSON.stringify(result)}`);
      failed++;
    }
  } catch (error) {
    // Some tests expect exceptions (like duplicate aliases)
    if (expected.throws) {
      console.log(`✅ ${name} (threw as expected)`);
      passed++;
    } else {
      console.log(`❌ ${name} (unexpected exception)`);
      console.log(`   Error: ${error.message}`);
      failed++;
    }
  }
}

console.log('Security Blocker Fixes Validation\n');

// ===== FIX 1: Identifier Regex Safety =====
console.log('=== FIX 1: Digit-leading identifier rejection ===\n');

test(
  'Reject numeric position disguised as identifier (1.2)',
  'SELECT * FROM public.users u ORDER BY 1.2 ASC',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Reject digit-leading qualifier (0x.column)',
  'SELECT * FROM public.users u ORDER BY 0x.id ASC',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Reject digit-leading column (u.1st)',
  'SELECT * FROM public.users u ORDER BY u.1st ASC',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Accept valid identifiers starting with letter',
  'SELECT * FROM public.users u ORDER BY u.id ASC',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'Accept valid identifiers starting with underscore',
  'SELECT * FROM public._users u ORDER BY u.id ASC',
  { allowedOrderByColumns: ['public._users.id'] },
  { valid: true }
);

// ===== FIX 2: Alias Resolution Fail-Closed =====
console.log('\n=== FIX 2: Duplicate alias rejection ===\n');

test(
  'Reject duplicate alias (same alias used twice)',
  'SELECT * FROM public.users u JOIN sales.orders u ON true ORDER BY u.id ASC',
  { allowedOrderByColumns },
  { valid: false, throws: true }
);

test(
  'Accept distinct aliases',
  'SELECT * FROM public.users u JOIN sales.orders o ON u.id = o.user_id ORDER BY u.id ASC',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'Reject case-insensitive duplicate (U and u)',
  'SELECT * FROM public.users u JOIN sales.orders U ON true ORDER BY u.id ASC',
  { allowedOrderByColumns },
  { valid: false, throws: true }
);

// ===== FIX 3: MySQL # Comment Rejection =====
console.log('\n=== FIX 3: MySQL # comment rejection ===\n');

test(
  'Reject MySQL # comment in WHERE clause',
  'SELECT * FROM public.users u WHERE active = true # bypass',
  {},
  { valid: false }
);

test(
  'Reject MySQL # comment in ORDER BY',
  'SELECT * FROM public.users u ORDER BY u.id ASC # trailing comment',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Reject MySQL # comment at end of query',
  'SELECT * FROM public.users u #',
  {},
  { valid: false }
);

test(
  'Reject MySQL # comment before ORDER BY',
  'SELECT * FROM public.users u # comment\nORDER BY u.id ASC',
  { allowedOrderByColumns },
  { valid: false }
);

// ===== Additional Edge Cases =====
console.log('\n=== Edge cases for identifier regex ===\n');

test(
  'Accept identifiers with numbers in middle (u.id2)',
  'SELECT * FROM public.users u ORDER BY u.id2 ASC',
  { allowedOrderByColumns: ['public.users.id2'] },
  { valid: true }
);

test(
  'Accept identifiers with underscores (u.created_at)',
  'SELECT * FROM public.users u ORDER BY u.created_at ASC',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'Reject special characters (!@#$%)',
  'SELECT * FROM public.users u ORDER BY u.id! ASC',
  { allowedOrderByColumns },
  { valid: false }
);

// ===== SUMMARY =====
console.log('\n' + '='.repeat(50));
console.log(`Security Fixes Validation: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
