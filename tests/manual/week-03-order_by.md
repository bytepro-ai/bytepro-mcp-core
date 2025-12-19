# Week 3: ORDER BY Allowlist Validation Tests

## Test Setup

```javascript
import { validateQueryWithTables } from '../../src/security/queryValidator.js';

// Example allowlist
const allowedOrderByColumns = [
  'public.users.id',
  'public.users.created_at',
  'public.users.name',
  'sales.orders.order_date',
  'sales.orders.total',
];
```

## Test Cases

### ✅ ACCEPT: Valid ORDER BY queries

#### Test 1: Two-part qualified with alias
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.id ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: true, tables: ['public.users'] }
```

#### Test 2: Three-part fully qualified
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY public.users.created_at DESC',
  { allowedOrderByColumns }
);
// Expected: { valid: true, tables: ['public.users'] }
```

#### Test 3: Two sort keys (max allowed)
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.created_at DESC, u.id ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: true, tables: ['public.users'] }
```

#### Test 4: Unambiguous table name as qualifier
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users ORDER BY users.name ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: true, tables: ['public.users'] }
```

#### Test 5: JOIN with multiple tables
```javascript
const result = validateQueryWithTables(
  `SELECT * FROM public.users u 
   JOIN sales.orders o ON u.id = o.user_id 
   ORDER BY o.order_date DESC`,
  { allowedOrderByColumns }
);
// Expected: { valid: true, tables: ['public.users', 'sales.orders'] }
```

#### Test 6: No ORDER BY (backward compatibility)
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u WHERE u.active = true',
  { allowedOrderByColumns }
);
// Expected: { valid: true, tables: ['public.users'] }
```

#### Test 7: No ORDER BY, no allowlist (backward compatibility)
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u WHERE u.active = true'
);
// Expected: { valid: true, tables: ['public.users'] }
```

---

### ❌ REJECT: Missing explicit direction

#### Test 8: No direction specified
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.id',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY must use qualified identifiers (alias.column or schema.table.column) with explicit direction (ASC or DESC)' }
```

---

### ❌ REJECT: Bare column names

#### Test 9: Unqualified column
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY id ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY must use qualified identifiers...' }
```

#### Test 10: Bare column with direction
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY created_at DESC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY must use qualified identifiers...' }
```

---

### ❌ REJECT: Numeric positions

#### Test 11: Positional ORDER BY
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY 1 ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY positional references are not allowed' }
```

#### Test 12: Positional without direction
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY 1',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY positional references are not allowed' }
```

---

### ❌ REJECT: Expressions and functions

#### Test 13: Function call
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY LOWER(u.name) ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY expressions are not allowed (parentheses forbidden)' }
```

#### Test 14: Cast expression
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.created_at::text ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'Invalid characters in ORDER BY clause (fail-closed)' }
```

#### Test 15: Arithmetic expression
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY (u.id + 1) ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY expressions are not allowed (parentheses forbidden)' }
```

---

### ❌ REJECT: Too many sort keys

#### Test 16: Three sort keys (exceeds max of 2)
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.id ASC, u.name ASC, u.created_at DESC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'Too many ORDER BY keys (maximum: 2)' }
```

---

### ❌ REJECT: Column not in allowlist

#### Test 17: Non-allowlisted column
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.password_hash ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY column not allowed: public.users.password_hash' }
```

#### Test 18: Wrong schema
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY private.users.id ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY column not allowed: private.users.id' }
```

---

### ❌ REJECT: ORDER BY without allowlist configured

#### Test 19: ORDER BY when allowlist is empty
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.id ASC',
  { allowedOrderByColumns: [] }
);
// Expected: { valid: false, reason: 'ORDER BY not permitted (no allowed columns configured)' }
```

#### Test 20: ORDER BY when allowlist not provided
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.id ASC'
  // No options parameter
);
// Expected: { valid: false, reason: 'ORDER BY not permitted (no allowed columns configured)' }
```

---

### ❌ REJECT: Unknown or ambiguous qualifiers

#### Test 21: Unknown alias
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY x.id ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'Unknown or ambiguous ORDER BY qualifier: x' }
```

#### Test 22: Ambiguous table name (appears in multiple schemas)
```javascript
const result = validateQueryWithTables(
  `SELECT * FROM public.users u1
   JOIN audit.users u2 ON u1.id = u2.user_id
   ORDER BY users.id ASC`,
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'Unknown or ambiguous ORDER BY qualifier: users' }
```

---

### ❌ REJECT: Multiple ORDER BY clauses

#### Test 23: Nested subquery with ORDER BY
```javascript
const result = validateQueryWithTables(
  `SELECT * FROM (
     SELECT * FROM public.users ORDER BY id ASC
   ) u ORDER BY u.created_at DESC`,
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'Multiple ORDER BY clauses not supported (fail-closed)' }
```

---

### ❌ REJECT: Dialect-specific extensions

#### Test 24: NULLS FIRST (Postgres extension)
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.created_at ASC NULLS FIRST',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'ORDER BY must use qualified identifiers...' }
```

#### Test 25: COLLATE clause
```javascript
const result = validateQueryWithTables(
  'SELECT * FROM public.users u ORDER BY u.name COLLATE "C" ASC',
  { allowedOrderByColumns }
);
// Expected: { valid: false, reason: 'Invalid characters in ORDER BY clause (fail-closed)' }
```

---

## Integration Test: Full adapter flow

```javascript
import { PostgresAdapter } from '../../src/adapters/postgres.js';

// Adapter currently calls validateQueryWithTables(query) without options
// This remains backward compatible - ORDER BY validation is opt-in

const adapter = new PostgresAdapter(config);
await adapter.connect();

// Without allowlist: ORDER BY queries fail if present
try {
  await adapter.executeQuery({
    query: 'SELECT * FROM public.users u ORDER BY u.id ASC'
  });
} catch (error) {
  console.log(error.code); // QUERY_REJECTED
  console.log(error.message); // ORDER BY not permitted...
}

// With allowlist: Must modify adapter to pass options
// (Future enhancement - requires adapter modification)
```

## Summary

**Enforcement:**
- Single ORDER BY clause only
- Maximum 2 sort keys
- Explicit ASC or DESC required for every key
- Only qualified identifiers (alias.column or schema.table.column)
- Bare columns rejected
- Numeric positions rejected
- Expressions/functions/operators rejected
- Parentheses rejected
- Only allowlisted columns permitted

**Backward Compatibility:**
- Queries without ORDER BY: unchanged behavior
- Existing adapter calls without options: unchanged behavior
- ORDER BY validation is opt-in via options parameter

**Security Posture:**
- Fail-closed on ambiguity
- No SQL parsing or AST required
- Adapter-agnostic (regex-only)
- Clear, explicit error messages
