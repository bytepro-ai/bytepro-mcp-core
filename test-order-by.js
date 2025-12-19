#!/usr/bin/env node

/**
 * ORDER BY Allowlist Validation Test Suite
 * Run: node test-order-by.js
 */

import { validateQueryWithTables } from './src/security/queryValidator.js';

const allowedOrderByColumns = [
  'public.users.id',
  'public.users.created_at',
  'public.users.name',
  'sales.orders.order_date',
  'sales.orders.total',
];

let passed = 0;
let failed = 0;

function test(name, query, options, expected) {
  const result = validateQueryWithTables(query, options);
  const success = result.valid === expected.valid;

  if (success) {
    console.log(`✅ ${name}`);
    passed++;
  } else {
    console.log(`❌ ${name}`);
    console.log(`   Expected: ${JSON.stringify(expected)}`);
    console.log(`   Got: ${JSON.stringify(result)}`);
    failed++;
  }
}

console.log('ORDER BY Allowlist Validator Test Suite\n');

// ===== ACCEPT CASES =====
console.log('=== ACCEPT: Valid ORDER BY queries ===\n');

test(
  'Two-part qualified with alias',
  'SELECT * FROM public.users u ORDER BY u.id ASC',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'Three-part fully qualified',
  'SELECT * FROM public.users u ORDER BY public.users.created_at DESC',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'Two sort keys',
  'SELECT * FROM public.users u ORDER BY u.created_at DESC, u.id ASC',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'Unambiguous table name',
  'SELECT * FROM public.users ORDER BY users.name ASC',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'JOIN with ORDER BY',
  'SELECT * FROM public.users u JOIN sales.orders o ON u.id = o.user_id ORDER BY o.order_date DESC',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'No ORDER BY (backward compat)',
  'SELECT * FROM public.users u WHERE u.active = true',
  { allowedOrderByColumns },
  { valid: true }
);

test(
  'No ORDER BY, no allowlist',
  'SELECT * FROM public.users u WHERE u.active = true',
  {},
  { valid: true }
);

// ===== REJECT CASES =====
console.log('\n=== REJECT: Missing explicit direction ===\n');

test(
  'No direction specified',
  'SELECT * FROM public.users u ORDER BY u.id',
  { allowedOrderByColumns },
  { valid: false }
);

console.log('\n=== REJECT: Bare column names ===\n');

test(
  'Unqualified column',
  'SELECT * FROM public.users u ORDER BY id ASC',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Bare column with direction',
  'SELECT * FROM public.users u ORDER BY created_at DESC',
  { allowedOrderByColumns },
  { valid: false }
);

console.log('\n=== REJECT: Numeric positions ===\n');

test(
  'Positional ORDER BY with direction',
  'SELECT * FROM public.users u ORDER BY 1 ASC',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Positional without direction',
  'SELECT * FROM public.users u ORDER BY 1',
  { allowedOrderByColumns },
  { valid: false }
);

console.log('\n=== REJECT: Expressions and functions ===\n');

test(
  'Function call',
  'SELECT * FROM public.users u ORDER BY LOWER(u.name) ASC',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Cast expression',
  'SELECT * FROM public.users u ORDER BY u.created_at::text ASC',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Arithmetic expression',
  'SELECT * FROM public.users u ORDER BY (u.id + 1) ASC',
  { allowedOrderByColumns },
  { valid: false }
);

console.log('\n=== REJECT: Too many sort keys ===\n');

test(
  'Three sort keys (max is 2)',
  'SELECT * FROM public.users u ORDER BY u.id ASC, u.name ASC, u.created_at DESC',
  { allowedOrderByColumns },
  { valid: false }
);

console.log('\n=== REJECT: Column not in allowlist ===\n');

test(
  'Non-allowlisted column',
  'SELECT * FROM public.users u ORDER BY u.password_hash ASC',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'Wrong schema',
  'SELECT * FROM public.users u ORDER BY private.users.id ASC',
  { allowedOrderByColumns },
  { valid: false }
);

console.log('\n=== REJECT: ORDER BY without allowlist ===\n');

test(
  'Empty allowlist',
  'SELECT * FROM public.users u ORDER BY u.id ASC',
  { allowedOrderByColumns: [] },
  { valid: false }
);

test(
  'No allowlist provided',
  'SELECT * FROM public.users u ORDER BY u.id ASC',
  {},
  { valid: false }
);

console.log('\n=== REJECT: Unknown qualifiers ===\n');

test(
  'Unknown alias',
  'SELECT * FROM public.users u ORDER BY x.id ASC',
  { allowedOrderByColumns },
  { valid: false }
);

console.log('\n=== REJECT: Multiple ORDER BY ===\n');

test(
  'Nested ORDER BY',
  'SELECT * FROM (SELECT * FROM public.users ORDER BY id ASC) u ORDER BY u.created_at DESC',
  { allowedOrderByColumns },
  { valid: false }
);

console.log('\n=== REJECT: Dialect extensions ===\n');

test(
  'NULLS FIRST',
  'SELECT * FROM public.users u ORDER BY u.created_at ASC NULLS FIRST',
  { allowedOrderByColumns },
  { valid: false }
);

test(
  'COLLATE clause',
  'SELECT * FROM public.users u ORDER BY u.name COLLATE "C" ASC',
  { allowedOrderByColumns },
  { valid: false }
);

// ===== SUMMARY =====
console.log('\n' + '='.repeat(50));
console.log(`Test Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
