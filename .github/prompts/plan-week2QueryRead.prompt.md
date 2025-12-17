# Plan: Implement Secure `query_read` Tool for Week 2 (Revised)

Add a read-only SELECT query execution tool to the MCP Core Library. Maintain Week 1's strict security posture with **regex-based validation**, allowlist enforcement, and server-enforced limits. PostgreSQL adapter only.

**Key Design Decisions**:
- ✅ Regex-based SQL validation (no AST parsing in Week 2)
- ✅ No function-level validation (rely on READ ONLY transactions)
- ✅ Simple LIMIT enforcement (append/clamp, not subquery wrapping)
- ✅ Reduced error taxonomy (~8 codes, not 22)
- ✅ Clean boundaries: security validates, adapter executes

**Deferred to Week 3**:
- ❌ AST-based SQL parsing (`node-sql-parser`)
- ❌ Function allowlists (COUNT, SUM, etc.)
- ❌ Subquery support (even shallow)
- ❌ Complex query rewriting

---

## Steps

### 1. Extend queryGuard with strict regex-based validation

**Objective**: Add regex-based SELECT validation without introducing SQL parsers.

**Tasks**:
- Update `src/security/queryGuard.js` to add `validateQueryRead(query)` method
- Implement strict regex checks:
  - **Statement Type**: Query must start with `SELECT` (case-insensitive, after trim)
  - **Forbidden Keywords**: Block `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `EXEC`, `COPY`, `INTO`, `FOR UPDATE`, `FOR SHARE`
  - **Forbidden Constructs**: Block `WITH` (CTEs), `UNION`, `EXCEPT`, `INTERSECT`
  - **Multi-Statement**: Reject if contains `;` (semicolon)
  - **Comments**: Reject if contains `--` or `/*` or `*/`
  - **Control Characters**: Reject null bytes (`\0`) and other control chars
  - **OFFSET Keyword**: Block `OFFSET` (DOS prevention, deferred to Week 3+)
- Extract table references using **best-effort regex** (FROM/JOIN clauses):
  - Pattern: `FROM\s+(\w+\.?\w+)` and `JOIN\s+(\w+\.?\w+)`
  - Return array of `schema.table` or `table` strings
  - Normalize to `schema.table` format (default to `public` schema)
  - **Fail-closed rule**: If NO tables extracted, validation MUST fail (error: `INVALID_QUERY_SYNTAX`)
  - **Over-extraction acceptable**: False positives are safe (adapter will validate allowlist)
  - **Under-extraction risk**: If regex misses a table, adapter allowlist check will catch it at execution
- Return structured validation result:
  ```javascript
  {
    valid: boolean,
    error?: { code: string, message: string, details?: object },
    tables?: string[]  // Extracted table references (must be non-empty if valid)
  }
  ```
- Keep existing `isReadOnly()` and `isSafe()` for backward compatibility

**Security Checkpoint**: 
- All write operations, multi-statements, comments, and CTEs must be blocked
- OFFSET keyword must be blocked (DOS prevention)
- Queries with zero extracted tables must be rejected (fail-closed)

---

### 2. Implement executeQuery method in PostgreSQL adapter

**Objective**: Add secure query execution with READ ONLY enforcement and simple LIMIT handling.

**Tasks**:
- Add `executeQuery(query, params, options)` to `src/adapters/postgres.js`
- **Input Validation**:
  - Validate `params` array: all elements must be string, number, boolean, or null
  - Validate `options.limit`: integer in range [1, 1000], default 100
  - Validate `options.timeout`: integer in range [1000, 30000], default 10000
- **Table Allowlist Enforcement**:
  - Receive pre-extracted `tables` array from queryGuard validation
  - Call `allowlist.validateTable(schema, table)` for each table
  - Reject query if ANY table is not in allowlist (error code `UNAUTHORIZED_TABLE`)
- **LIMIT Enforcement** (simplified strategy):
  - Check if query already contains `LIMIT` keyword (case-insensitive regex)
  - If no LIMIT: Append ` LIMIT ${enforcedLimit}` to query string
  - If has LIMIT: Extract numeric value, clamp to server max, replace in query
  - Store `appliedLimit` for response metadata
- **Database Execution** (READ ONLY transaction with mandatory cleanup):
  ```javascript
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = $1', [timeoutMs]);
    const result = await client.query(userQuery, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // MANDATORY: Always ROLLBACK on error to prevent dangling transactions
    await client.query('ROLLBACK');
    throw error;
  }
  ```
  - **Transaction Safety Invariant**: Connection must NEVER be left in open transaction state
  - **Error Handling**: ROLLBACK must execute even on timeout or connection errors
- **Post-Execution Truncation** (safety fallback):
  - If `result.rows.length > appliedLimit`: truncate to limit, set `truncated = true`
- **Result Sanitization**:
  - Sanitize database errors: map PostgreSQL error codes to generic messages
  - Return structured response:
    ```javascript
    {
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields.map(f => ({
        name: f.name,
        dataType: f.dataTypeID,  // PostgreSQL OID
        nullable: null  // Unknown without schema query
      })),
      metadata: {
        executionTimeMs: duration,
        truncated: boolean,
        appliedLimit: number,
        tablesAccessed: tables
      }
    }
    ```
- **Audit Logging** (sensitive data protection):
  - **Safe to log**: query hash (SHA-256), table names, duration, row count, error codes
  - **NEVER log**: full query text (may contain PII), parameter values (may contain credentials/PII)
  - Log structure:
    ```javascript
    {
      tool: 'query_read',
      query_hash: sha256(query),  // NOT the query itself
      tables: ['public.users'],
      params_count: 2,
      params_types: ['string', 'number'],  // NOT values
      duration_ms: 123,
      row_count: 42,
      error_code: null
    }
    ```
- Use `pgPool.query()` for all database access

**Security Checkpoint**: 
- All queries execute in READ ONLY transaction with timeout and LIMIT enforced
- ROLLBACK must execute on ALL error paths (no dangling transactions)
- Audit logs must NEVER contain query text or parameter values

---

### 3. Create query_read tool with simplified MCP contract

**Objective**: Expose secure query execution via MCP tool interface with reduced error taxonomy.

**Tasks**:
- Create `src/tools/queryRead.js` following `describeTable.js` pattern
- Define Zod input schema:
  - `query`: `z.string().min(1).max(10240).describe('SELECT statement to execute')`
  - `params`: `z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(50).default([]).describe('Query parameters')`
  - `limit`: `z.number().int().min(1).max(1000).default(100).describe('Max rows to return')`
  - `timeout`: `z.number().int().min(1000).max(30000).default(10000).describe('Query timeout in ms')`
- Implement handler:
  ```javascript
  async handler(input, adapter) {
    // 1. Validate query syntax and structure
    const validation = queryGuard.validateQueryRead(input.query);
    if (!validation.valid) {
      throw validation.error;  // Registry will format as MCP error
    }
    
    // 2. Execute query with validated tables
    const result = await adapter.executeQuery(
      input.query,
      input.params,
      {
        limit: input.limit,
        timeout: input.timeout,
        tables: validation.tables  // Pre-extracted by queryGuard
      }
    );
    
    // 3. Return result (registry adds MCP wrapper)
    return result;
  }
  ```
- **Simplified Error Taxonomy** (8 codes instead of 22):
  - `INVALID_INPUT` (400x) - Zod validation failure (query too long, invalid param type, etc.)
  - `INVALID_QUERY_SYNTAX` (4002) - Regex validation failed (not SELECT, has comments, etc.)
  - `FORBIDDEN_CONSTRUCT` (4003) - CTE, UNION, multi-statement detected
  - `UNAUTHORIZED_TABLE` (4010) - Table not in allowlist
  - `QUERY_TIMEOUT` (5001) - Database killed query
  - `QUERY_FAILED` (5002) - Generic execution error (sanitized)
  - `CONNECTION_FAILED` (5003) - Database unavailable
  - `INTERNAL_ERROR` (5000) - Unexpected server error
- Register tool in `src/core/server.js` tool initialization section

**Security Checkpoint**: Tool validates input, queryGuard validates SQL, adapter enforces allowlist.

---

### 4. Add testing and validation

**Objective**: Verify security and functionality with minimal test infrastructure.

**Tasks**:
- Update `validate-implementation.js` with `query_read` checks:
  - Tool is registered in registry
  - queryGuard.validateQueryRead() exists and blocks dangerous patterns
  - adapter.executeQuery() exists
  - Basic smoke test: valid SELECT returns data structure
- Create `tests/manual/query-read.md` with MCP Inspector test cases:
  - **Valid Queries**:
    - Simple SELECT: `SELECT * FROM users LIMIT 5`
    - Parameterized: `SELECT * FROM users WHERE id = $1`, params: `[1]`
    - JOIN: `SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id LIMIT 10`
  - **Security Tests** (must be blocked):
    - Write attempt: `INSERT INTO users (name) VALUES ('x')` → `INVALID_QUERY_SYNTAX`
    - Multi-statement: `SELECT 1; DROP TABLE users;` → `FORBIDDEN_CONSTRUCT`
    - CTE: `WITH cte AS (SELECT 1) SELECT * FROM cte` → `FORBIDDEN_CONSTRUCT`
    - Comment: `SELECT * FROM users -- comment` → `INVALID_QUERY_SYNTAX`
    - Forbidden table: `SELECT * FROM secret_table` → `UNAUTHORIZED_TABLE`
  - **Edge Cases**:
    - Empty result: `SELECT * FROM users WHERE id = -1` → success, 0 rows
    - Timeout: Long query with timeout=1000 → `QUERY_TIMEOUT`
    - Over-limit: Query returning >100 rows → truncated=true in metadata
- No unit test framework needed (keep Week 1 validation script approach)
- Verify audit logs contain query hash, tables, duration (manual inspection)

**Security Checkpoint**: All write operations, multi-statements, comments, CTEs blocked by regex validation.

---

## Module-Level Changes Summary

### New Files
```
src/tools/queryRead.js           - query_read tool implementation
tests/manual/query-read.md       - MCP Inspector manual testing guide
```

### Modified Files
```
src/security/queryGuard.js       - Add validateQueryRead() with regex table extraction
src/adapters/postgres.js         - Add executeQuery() method
src/core/server.js               - Register query_read tool
validate-implementation.js       - Add query_read validation checks
```

### Unchanged Files
```
src/core/toolRegistry.js         - No changes (uses existing registration)
src/security/allowlist.js        - No changes (reused as-is)
src/utils/*                      - No changes (reused as-is)
src/config/*                     - No changes (existing config sufficient)
package.json                     - No new dependencies (regex-only validation)
```

### Deferred to Week 3
```
src/security/sqlParser.js        - DEFERRED: AST-based SQL parsing
node-sql-parser dependency       - DEFERRED: Parser library
tests/unit/sqlParser.test.js     - DEFERRED: Parser unit tests
Function allowlist validation    - DEFERRED: No function checks in Week 2
Column-level allowlist           - DEFERRED: Table-level only for now
OFFSET support                   - DEFERRED: Blocked in Week 2 for DOS prevention
Cursor-based pagination          - DEFERRED: Requires OFFSET or alternative mechanism
```

---

## File Responsibilities

### `src/security/queryGuard.js` (MODIFIED)
**Purpose**: Regex-based query validation and table extraction

**New Exports**:
- `validateQueryRead(query)` → `{ valid: boolean, error?: object, tables?: string[] }`
  - Validates SELECT-only, no comments, no multi-statements
  - Extracts table references using regex (FROM/JOIN clauses)
  - Returns validation result with extracted tables

**Existing Exports** (unchanged):
- `isReadOnly(query)` → boolean
- `isSafe(query)` → boolean
- `getInstance()` → singleton

**Dependencies**: None (regex-only)

**Error Codes**: 
- `INVALID_QUERY_SYNTAX` - Not SELECT, has comments, control chars
- `FORBIDDEN_CONSTRUCT` - CTE, UNION, multi-statement

---

### `src/adapters/postgres.js` (MODIFIED)
**Purpose**: Execute pre-validated queries with READ ONLY enforcement

**New Exports**:
- `executeQuery(query, params, options)` → result object
  - Receives pre-validated query and pre-extracted tables from security layer
  - Enforces table allowlist
  - Appends/clamps LIMIT
  - Executes in BEGIN READ ONLY transaction
  - **MANDATORY**: Issues ROLLBACK on ALL error paths (no dangling transactions)
  - Sanitizes database errors

**Existing Exports** (unchanged):
- `initialize()`, `shutdown()`, `healthCheck()`
- `listTables(params)`, `describeTable(params)`

**Dependencies**: `../security/allowlist.js`, `../utils/pgPool.js`

**Error Codes**: 
- `UNAUTHORIZED_TABLE` - Table not in allowlist
- `QUERY_TIMEOUT` - Database timeout
- `QUERY_FAILED` - Generic execution error
- `CONNECTION_FAILED` - Database unavailable

---

### `src/tools/queryRead.js` (NEW)
**Purpose**: MCP tool interface for query_read

**Exports**:
- Tool definition object with name, description, inputSchema (Zod)
- Handler function: `async (input, adapter) => { ... }`
  - Validates input with Zod
  - Calls queryGuard.validateQueryRead()
  - Calls adapter.executeQuery() with pre-extracted tables
  - Returns result (registry adds MCP wrapper)

**Dependencies**: `zod`, `../security/queryGuard.js`

**Error Codes** (8 total):
- `INVALID_INPUT` - Zod validation failure
- `INVALID_QUERY_SYNTAX` - Not SELECT, has comments
- `FORBIDDEN_CONSTRUCT` - CTE, UNION, multi-statement
- `UNAUTHORIZED_TABLE` - Not in allowlist
- `QUERY_TIMEOUT`, `QUERY_FAILED`, `CONNECTION_FAILED`, `INTERNAL_ERROR`

---

### `tests/manual/query-read.md` (NEW)
**Purpose**: MCP Inspector manual testing checklist

**Sections**:
1. Setup instructions (allowlist config)
2. Valid query test cases (with expected outputs)
3. Security test cases (with expected error codes)
4. Performance test cases (timeout, large results)
5. Edge cases (empty results, NULL values, type coercion)

**Format**: Markdown with copyable JSON tool calls

---

## Implementation Order

### Phase 1: Security Layer (Step 1)
**Goal**: Add regex-based query validation and table extraction.

**Order**:
1. Extend `src/security/queryGuard.js` with `validateQueryRead()` method
2. Implement strict regex patterns for SELECT-only validation
3. Implement table extraction from FROM/JOIN clauses (regex-based)
4. Test manually with various query patterns
5. Add validation checks to `validate-implementation.js`

**Checkpoint**: Can validate queries and extract tables without database.

**Verification**:
```javascript
const { validateQueryRead } = require('./src/security/queryGuard.js');

// Valid query with tables
const result1 = validateQueryRead('SELECT * FROM users WHERE id = $1');
console.assert(result1.valid === true);
console.assert(result1.tables.includes('public.users'));

// Invalid query (CTE)
const result2 = validateQueryRead('WITH cte AS (SELECT 1) SELECT * FROM cte');
console.assert(result2.valid === false);
console.assert(result2.error.code === 'FORBIDDEN_CONSTRUCT');

// Invalid query (no tables - fail-closed)
const result3 = validateQueryRead('SELECT 1 + 1');
console.assert(result3.valid === false);
console.assert(result3.error.code === 'INVALID_QUERY_SYNTAX');

// Invalid query (OFFSET blocked)
const result4 = validateQueryRead('SELECT * FROM users LIMIT 10 OFFSET 50');
console.assert(result4.valid === false);
console.assert(result4.error.code === 'FORBIDDEN_CONSTRUCT');
```

---

### Phase 2: Adapter Execution (Step 2)
**Goal**: Implement secure query execution in PostgreSQL adapter.

**Order**:
1. Add `executeQuery(query, params, options)` method to `src/adapters/postgres.js`
2. Implement table allowlist validation (use pre-extracted tables from queryGuard)
3. Implement LIMIT append/clamp logic (simple string manipulation)
4. Implement READ ONLY transaction with timeout
5. Implement result sanitization and error mapping
6. Test directly with adapter (bypass tool layer)

**Checkpoint**: Can execute SELECT queries with READ ONLY enforcement.

**Verification**:
```javascript
// Direct adapter test
const adapter = new PostgresAdapter();
await adapter.initialize();

// Pre-validate query
const validation = queryGuard.validateQueryRead('SELECT * FROM users WHERE id = $1');

// Execute with pre-extracted tables
const result = await adapter.executeQuery(
  'SELECT * FROM users WHERE id = $1',
  [1],
  { 
    limit: 10, 
    timeout: 5000,
    tables: validation.tables  // Pass extracted tables
  }
);
console.log(result);

// Verify transaction cleanup on error
try {
  await adapter.executeQuery('SELECT * FROM nonexistent', [], { tables: ['public.nonexistent'] });
} catch (error) {
  // Connection should NOT be in transaction state after error
  // ROLLBACK must have executed
  console.log('Error handled correctly, transaction rolled back');
}
```

---

### Phase 3: Tool Implementation (Step 3)
**Goal**: Expose query execution via MCP tool interface.

**Order**:
1. Create `src/tools/queryRead.js` with Zod input schema
2. Implement handler:
   - Call `queryGuard.validateQueryRead(query)`
   - Pass validation.tables to `adapter.executeQuery()`
   - Return result (registry formats MCP response)
3. Map errors to simplified error codes (8 codes, not 22)
4. Register tool in `src/core/server.js`
5. Start MCP server and verify tool appears in list

**Checkpoint**: Tool is registered and can be called via MCP Inspector.

**Verification**:
```bash
node src/core/server.js
# Use MCP Inspector to call tools/list
# Verify query_read appears with correct schema
```

---

### Phase 4: Testing & Validation (Step 4)
**Goal**: Verify security and functionality with manual testing.

**Order**:
1. Update `validate-implementation.js` with basic query_read checks:
   - Tool registered
   - queryGuard.validateQueryRead exists
   - adapter.executeQuery exists
2. Run validation script
3. Create `tests/manual/query-read.md` with MCP Inspector test cases
4. Execute critical security tests via MCP Inspector:
   - Valid SELECT succeeds
   - Write attempts blocked
   - Multi-statements blocked
   - CTEs blocked
   - Comments blocked
   - Forbidden tables blocked
5. Verify audit logs (manual inspection)

**Checkpoint**: All security tests blocked, valid queries succeed.

**Verification**:
```bash
node validate-implementation.js
# Should show query_read as ✅ PASSED
```



---

## Security Checkpoints

### Checkpoint 1: Regex Validation (After Step 1)
**Verify**:
- [ ] Regex rejects all non-SELECT statements
- [ ] Regex blocks CTEs, UNION, multi-statements
- [ ] Regex blocks OFFSET keyword (DOS prevention)
- [ ] Regex detects comments (-- and /* */)
- [ ] Table extraction works for FROM and JOIN clauses
- [ ] Queries with zero extracted tables are rejected (fail-closed)
- [ ] Validation errors are deterministic
- [ ] No database connection needed for validation

**Test Method**: Manual testing with queryGuard.validateQueryRead()
```javascript
// Should block
validateQueryRead('INSERT INTO users...')  // Not SELECT
validateQueryRead('SELECT 1; DROP TABLE users;')  // Multi-statement
validateQueryRead('WITH x AS (SELECT 1) SELECT * FROM x')  // CTE
validateQueryRead('SELECT * FROM users -- comment')  // Comment

// Should allow
validateQueryRead('SELECT * FROM users WHERE id = $1')
validateQueryRead('SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id')
```

---

### Checkpoint 2: Adapter Security (After Step 2)
**Verify**:
- [ ] All queries execute in READ ONLY transaction
- [ ] ROLLBACK executes on ALL error paths (no dangling transactions)
- [ ] Timeouts enforced via SET LOCAL statement_timeout
- [ ] Parameters bound with $1, $2, etc.
- [ ] LIMIT appended/clamped correctly
- [ ] Table allowlist checked before execution
- [ ] Database errors sanitized (generic messages)
- [ ] Audit logs don't contain query text or parameter values

**Test Method**: Execute queries directly on adapter
```javascript
// Should succeed
await adapter.executeQuery('SELECT * FROM users WHERE id = $1', [1], { tables: ['public.users'] })

// Should fail (table not in allowlist)
await adapter.executeQuery('SELECT * FROM secret', [1], { tables: ['public.secret'] })
```

---

### Checkpoint 3: End-to-End Security (After Step 3)
**Verify**:
- [ ] Tool validates input (Zod schema)
- [ ] QueryGuard blocks dangerous queries (regex)
- [ ] Adapter enforces allowlist (pre-execution)
- [ ] Database enforces READ ONLY (kernel-level)
- [ ] SQL injection blocked (parameterized queries)
- [ ] Resource limits enforced (timeout, LIMIT)

**Test Method**: Attack scenarios via MCP Inspector
```json
// Write attempt
{ "tool": "query_read", "input": { "query": "INSERT INTO users..." } }
→ Error: INVALID_QUERY_SYNTAX

// Multi-statement
{ "tool": "query_read", "input": { "query": "SELECT 1; DROP TABLE users;" } }
→ Error: FORBIDDEN_CONSTRUCT

// SQL injection attempt (parameterized)
{ "tool": "query_read", "input": { "query": "SELECT * FROM users WHERE id = $1", "params": ["1 OR 1=1"] } }
→ Success (treated as string, not SQL)
```

---

### Checkpoint 4: Production Readiness (After Step 4)
**Verify**:
- [ ] All 8 error codes are tested
- [ ] Manual test cases documented in tests/manual/query-read.md
- [ ] Audit logging covers all operations
- [ ] Performance acceptable (regex is <1ms)
- [ ] No known security vulnerabilities
- [ ] README.md updated with usage example

**Test Method**: Full validation suite + MCP Inspector manual testing

---

## Testing Strategy

### Validation Script Testing
**Scope**: Basic smoke tests for tool registration and method existence

**Coverage**:
- Tool `query_read` is registered
- `queryGuard.validateQueryRead()` method exists
- `adapter.executeQuery()` method exists
- Basic regex validation works (block INSERT, allow SELECT)

**Tools**: Extend `validate-implementation.js` (no new test framework)

**Execution**:
```bash
node validate-implementation.js
# Should show: ✅ query_read tool registered
# Should show: ✅ queryGuard validation blocks dangerous queries
# Should show: ✅ adapter executeQuery method exists
```

---

### Manual Testing (MCP Inspector)
**Scope**: User-facing MCP tool interface with security-focused test cases

**Critical Tests** (see `tests/manual/query-read.md`):

1. **Valid Queries** (should succeed):
   - `SELECT * FROM users LIMIT 5`
   - `SELECT * FROM users WHERE id = $1`, params: `[1]`
   - `SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id LIMIT 10`

2. **Security Tests** (should be blocked):
   - **Write**: `INSERT INTO users (name) VALUES ('x')` → `INVALID_QUERY_SYNTAX`
   - **Multi-statement**: `SELECT 1; DROP TABLE users;` → `FORBIDDEN_CONSTRUCT`
   - **CTE**: `WITH cte AS (SELECT 1) SELECT * FROM cte` → `FORBIDDEN_CONSTRUCT`
   - **Comment**: `SELECT * FROM users -- comment` → `INVALID_QUERY_SYNTAX`
   - **UNION**: `SELECT 1 UNION SELECT 2` → `FORBIDDEN_CONSTRUCT`
   - **OFFSET**: `SELECT * FROM users LIMIT 10 OFFSET 100` → `FORBIDDEN_CONSTRUCT`
   - **Forbidden table**: `SELECT * FROM secret_table` → `UNAUTHORIZED_TABLE`
   - **No tables**: `SELECT 1 + 1` → `INVALID_QUERY_SYNTAX` (fail-closed)

3. **Resource Tests**:
   - Timeout: Long query with timeout=1000 → `QUERY_TIMEOUT`
   - Over-limit: Query returning >100 rows → truncated=true in metadata

4. **Edge Cases**:
   - Empty result: `SELECT * FROM users WHERE id = -1` → success, 0 rows
   - NULL values: `SELECT NULL AS col` → success, returns null

**Tools**: MCP Inspector

**Execution**:
1. Start MCP server: `node src/core/server.js`
2. Connect MCP Inspector to stdio
3. Execute each test case above
4. Verify error codes match expected values

---

## Respect Existing Patterns

### ✅ Maintain Consistency With Week 1

**Tool Structure**:
- Follow `src/tools/describeTable.js` pattern exactly
- Use Zod for input validation
- Return plain objects (registry adds MCP wrapper)
- No direct error handling (throw errors, registry catches)

**Adapter Methods**:
- Follow `postgres.listTables()` pattern
- Use `pgPool.query()` for all database access
- Log operations with duration tracking
- Apply allowlist filtering before queries

**Security Enforcement**:
- Security checks in adapter layer (not tool layer)
- Allowlist validation via `allowlist.validateSchema/Table()`
- Query validation via `queryGuard` methods
- Audit logging for all operations

**Error Handling**:
- Use `responseFormatter` for MCP responses
- Structured errors with code, message, details
- No database error leakage
- Consistent error format across tools

**Code Style**:
- ESM imports with `.js` extensions
- Singleton pattern for registries
- Async/await throughout
- Pino logger for structured logging

---

### ✅ No Scope Creep

**In Scope (Week 2)**:
- SELECT queries only (regex validation)
- PostgreSQL adapter only
- Single statement enforcement
- Server-enforced limits (rows, timeout)
- Parameterized queries ($1, $2, etc.)
- Table-level allowlist (regex extraction)
- READ ONLY transaction enforcement
- Simple LIMIT append/clamp strategy

**Out of Scope (Deferred to Week 3+)**:
- ❌ AST-based SQL parsing (`node-sql-parser`)
- ❌ Function-level allowlists
- ❌ Subquery support (even in WHERE)
- ❌ CTE support (WITH clauses) - blocked in Week 2
- ❌ UNION, EXCEPT, INTERSECT - blocked in Week 2
- ❌ OFFSET support - blocked in Week 2 (DOS prevention)
- ❌ Column-level allowlist
- ❌ Query rewriting with subquery wrappers
- ❌ Advanced error taxonomy (>8 error codes)

**Never in Scope**:
- ❌ Write operations (INSERT, UPDATE, DELETE)
- ❌ DDL operations (CREATE, ALTER, DROP)
- ❌ Transaction management tools (user-controlled BEGIN/COMMIT)
- ❌ Multiple database adapters (MySQL, SQLite)
- ❌ Row-level security predicates
- ❌ Query result caching
- ❌ Rate limiting

---

## Dependencies

### Production Dependencies
**None required for Week 2**

Week 2 uses regex-only validation (no SQL parser). All dependencies already present:
- `pg` - PostgreSQL driver (existing)
- `zod` - Input validation (existing)
- `pino` - Logging (existing)
- `@modelcontextprotocol/sdk` - MCP protocol (existing)

---

### Development Dependencies
**None required for Week 2**

Existing validation scripts sufficient:
- `validate-implementation.js` for smoke tests
- Manual testing with MCP Inspector
- No unit test framework needed yet

---

### Deferred to Week 3
```json
{
  "node-sql-parser": "^5.3.4"  // AST-based SQL parsing
}
```

**Justification for deferring**:
- Week 2: Focus on proven regex-based validation (simple, fast)
- Week 3: Add AST parsing for advanced features (subqueries, function validation)
- No rushing dependencies without proven need

---

## MCP Inspector Testing

### Setup
1. Configure allowlist in `.env`:
   ```
   ALLOWED_SCHEMAS=public,analytics
   ALLOWED_TABLES=public.users,public.orders,analytics.events
   ```

2. Start PostgreSQL with test data
3. Start MCP server: `node src/core/server.js`
4. Connect MCP Inspector to stdio transport

---

### Test Case Template
```json
{
  "tool": "query_read",
  "input": {
    "query": "SELECT id, name FROM users WHERE active = $1 LIMIT 10",
    "params": [true],
    "limit": 10,
    "timeout": 5000
  }
}
```

**Expected Response**:
```json
{
  "rows": [...],
  "rowCount": 10,
  "fields": [
    { "name": "id", "dataType": "integer", "nullable": false },
    { "name": "name", "dataType": "character varying", "nullable": false }
  ],
  "metadata": {
    "executionTimeMs": 3.45,
    "truncated": false,
    "appliedLimit": 10,
    "tablesAccessed": ["public.users"]
  }
}
```

---

### Critical Test Cases (Minimum)

**1. Valid SELECT**:
- Input: `SELECT * FROM users LIMIT 5`
- Expected: Success with 5 rows max
- Verifies: Basic functionality

**2. Parameterized Query**:
- Input: `SELECT * FROM users WHERE id = $1`, params: `[42]`
- Expected: Success with 0-1 rows
- Verifies: Parameter binding

**3. Forbidden Table**:
- Input: `SELECT * FROM secret_table`
- Expected: Error 4010 (TABLE_NOT_ALLOWED)
- Verifies: Allowlist enforcement

**4. Write Attempt**:
- Input: `INSERT INTO users (name) VALUES ('hacker')`
- Expected: Error 4003 (DISALLOWED_STATEMENT_TYPE)
- Verifies: Write protection

**5. Multi-Statement**:
- Input: `SELECT 1; DROP TABLE users;`
- Expected: Error 4007 (MULTI_STATEMENT_DETECTED)
- Verifies: Multi-statement blocking

**6. CTE Attempt**:
- Input: `WITH cte AS (SELECT 1) SELECT * FROM cte`
- Expected: Error 4004 (FORBIDDEN_SQL_CONSTRUCT)
- Verifies: CTE blocking

**7. Timeout**:
- Input: `SELECT COUNT(*) FROM large_table, large_table`, timeout: `1000`
- Expected: Error 5001 (QUERY_TIMEOUT)
- Verifies: Timeout enforcement

**8. Result Truncation**:
- Input: `SELECT * FROM users`, limit: `10` (assuming >10 rows exist)
- Expected: Success with truncated=true in metadata
- Verifies: Limit enforcement

---

## Further Considerations

### 1. Regex vs AST Parsing Trade-offs

**Week 2 Decision**: Use regex-only validation

**Advantages**:
- ✅ Simple, fast, no dependencies
- ✅ Easy to understand and audit
- ✅ Sufficient for blocking obvious attacks
- ✅ Matches Week 1 philosophy (minimal tooling)

**Limitations**:
- ❌ Cannot detect complex obfuscation
- ❌ Cannot validate function calls
- ❌ Cannot handle all edge cases (nested constructs)

**Mitigation**: 
- READ ONLY transaction is ultimate safety net
- Database-level timeout prevents runaway queries
- Week 3 can add AST parsing for refinement

---

### 2. Table Extraction Accuracy

**Week 2 Approach**: Best-effort regex for FROM/JOIN clauses with fail-closed validation

**Known Limitations**:
- May miss tables in complex expressions
- Cannot handle aliased schemas
- Cannot extract from subqueries (blocked anyway)

**Acceptable Risk**:
- Over-extraction is safe (validate extra tables)
- Under-extraction fails at adapter allowlist check
- False positives rejected, false negatives caught at execution

**Fail-Closed Rule**:
- If NO tables extracted → validation fails immediately
- Prevents accidentally allowing table-less queries (e.g., `SELECT 1+1`)
- Week 3 AST parsing will improve extraction accuracy

---

### 2a. OFFSET Blocking (DOS Prevention)

**Week 2 Decision**: Block OFFSET keyword entirely

**Rationale**:
- OFFSET enables resource exhaustion: `SELECT * FROM large_table LIMIT 10 OFFSET 1000000`
- Database must scan N rows to skip them (expensive operation)
- No legitimate use case for OFFSET without pagination context (deferred to Week 3)
- LIMIT-only queries are sufficient for Week 2 scope

**Week 3 Consideration**:
- Add cursor-based pagination (stable, efficient)
- OR allow OFFSET with strict limits (e.g., max 1000)
- Requires deeper query analysis (AST parsing)

---

### 3. LIMIT Enforcement Strategy

**Week 2 Decision**: Append/clamp, not subquery wrapper

**Implementation**:
```javascript
// If no LIMIT keyword found
query += ` LIMIT ${enforcedLimit}`;

// If LIMIT found, clamp value
query = query.replace(/LIMIT\s+(\d+)/i, (match, value) => {
  const clamped = Math.min(parseInt(value), enforcedLimit);
  return `LIMIT ${clamped}`;
});
```

**Advantages**:
- Simple string manipulation
- No query structure changes
- Preserves user's ORDER BY

**Limitation**: User can still specify `LIMIT 999999`, but it gets clamped

---

### 4. Error Taxonomy Simplification

**Week 2 Decision**: 8 error codes instead of 22

**Rationale**:
- Fewer codes = easier to maintain
- Deterministic behavior more important than granularity
- Can expand in Week 3 if needed

**Error Mapping**:
- All Zod failures → `INVALID_INPUT`
- All regex failures → `INVALID_QUERY_SYNTAX` or `FORBIDDEN_CONSTRUCT`
- All allowlist failures → `UNAUTHORIZED_TABLE`
- All execution failures → `QUERY_TIMEOUT`, `QUERY_FAILED`, or `CONNECTION_FAILED`

---

### 5. Audit Log Content
**Question**: What to log for each query?

**Recommendation**: Log query hash, not full query
```javascript
{
  timestamp: "2025-12-17T10:30:00.000Z",
  tool: "query_read",
  query_hash: "sha256_of_normalized_sql",
  tables: ["public.users", "public.orders"],
  params_count: 2,
  params_types: ["string", "number"],  // NOT values (PII risk)
  row_count: 42,
  duration_ms: 123,
  truncated: false,
  error: null
}
```

**Rationale**:
- Full query may contain PII in WHERE clauses
- Parameter values may be sensitive (emails, SSNs)
- Hash allows detection of repeated queries without exposing data
- Enough detail for security monitoring and performance analysis

---

### 6. Transaction Isolation Level
**Question**: Use READ ONLY or READ UNCOMMITTED?

**Recommendation**: READ ONLY with default isolation (READ COMMITTED in PostgreSQL)
```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = 10000;
-- Execute user query
COMMIT;
```

**Rationale**:
- READ ONLY prevents writes at kernel level (cannot be bypassed)
- READ COMMITTED prevents dirty reads (data consistency)
- READ UNCOMMITTED not needed (no performance benefit for SELECT)
- Higher isolation (REPEATABLE READ, SERIALIZABLE) unnecessary overhead

---

## Success Criteria

### Functional Requirements
- ✅ `query_read` tool is registered and discoverable via `tools/list`
- ✅ Valid SELECT queries execute and return correct results
- ✅ Parameterized queries with $1, $2, etc. work correctly
- ✅ Result metadata includes execution time, truncation flag, tables accessed
- ✅ Row limits are enforced (LIMIT appended/clamped)
- ✅ Query timeouts kill long-running queries

### Security Requirements (Core)
- ✅ All non-SELECT statements are rejected (regex validation)
- ✅ Multi-statement attacks are blocked (semicolon detection)
- ✅ CTE-based write hiding is blocked (WITH keyword detection)
- ✅ UNION operations are blocked (regex detection)
- ✅ OFFSET keyword is blocked (DOS prevention)
- ✅ Table-less queries are rejected (fail-closed: no tables extracted → validation fails)
- ✅ Table allowlist is enforced at adapter level
- ✅ SQL injection is prevented (parameterized queries only)
- ✅ Comment-based obfuscation is blocked (-- and /* */ detected)
- ✅ Database errors are sanitized (generic messages)
- ✅ All queries execute in READ ONLY transactions (database-level enforcement)
- ✅ ROLLBACK executes on all error paths (no dangling transactions)

### Error Handling Requirements
- ✅ 8 error codes implemented and tested (simplified taxonomy)
- ✅ Errors are deterministic (same input → same error code)
- ✅ Error messages are actionable but don't leak schema details
- ✅ No sensitive information in error details

### Performance Requirements
- ✅ Validation overhead < 1ms per query (regex-only)
- ✅ Query execution time matches native PostgreSQL
- ✅ Memory usage scales with result set size
- ✅ Connection pool is not exhausted by concurrent queries

### Testing Requirements
- ✅ Validation script includes query_read smoke tests
- ✅ Manual test cases documented in `tests/manual/query-read.md`
- ✅ Security test cases verify regex blocking works
- ✅ All 8 error codes tested via MCP Inspector

### Documentation Requirements
- ✅ README.md includes query_read usage example
- ✅ Manual testing guide includes critical security tests
- ✅ Week 3 roadmap clearly documents deferred features (AST parsing)

---

## Risk Mitigation

### Risk 1: Regex Bypass
**Scenario**: Attacker finds regex pattern that allows dangerous SQL through

**Mitigation**:
- READ ONLY transaction prevents writes even if regex bypassed
- Database-level timeout prevents infinite loops
- Multi-layer validation (input + queryGuard + adapter + database)
- Conservative regex patterns (block more than necessary)

**Detection**: Security testing with SQL injection corpus, manual penetration testing

---

### Risk 2: Table Extraction Failure
**Scenario**: Regex misses table reference, unauthorized table accessed

**Mitigation**:
- Adapter validates ALL extracted tables before execution
- False positives (extra tables) are safe (more validation)
- False negatives caught at execution if table doesn't exist
- Future: Week 3 AST parsing will eliminate this risk

**Detection**: Test with complex queries, obfuscated table names

---

### Risk 3: Database Error Leakage
**Scenario**: Sanitization misses edge case, leaks schema details

**Mitigation**:
- Comprehensive error mapping (all PostgreSQL error codes)
- Default case: Generic "Query execution failed"
- Security review of error messages
- Test with intentional errors (missing tables, type mismatches)

**Detection**: Review audit logs for unsanitized errors

---

### Risk 3: Resource Exhaustion
**Scenario**: User queries DOS database with expensive operations

**Mitigation**:
- Statement timeout enforced at database level (SET LOCAL statement_timeout)
- Row limit enforced via LIMIT append/clamp
- OFFSET keyword blocked (prevents large offset scans: `OFFSET 1000000`)
- Connection pool max connections (prevents pool exhaustion)
- READ ONLY prevents write-based DOS attacks
- Future: Rate limiting on query_read tool

**Detection**: Load testing with concurrent expensive queries (Cartesian joins, large tables, etc.)

---

## Rollback Plan

### If Critical Bug Found After Implementation

**Step 1**: Immediate mitigation
```javascript
// In src/tools/queryRead.js
export const tool = {
  name: "query_read",
  description: "TEMPORARILY DISABLED: Security issue under investigation",
  inputSchema: { /* ... */ },
  handler: async () => {
    throw new Error("Tool temporarily disabled");
  }
};
```

**Step 2**: Identify scope
- Which layer failed? (1-7)
- What attack succeeded?
- What data was exposed?

**Step 3**: Fix and re-validate
- Patch vulnerable layer
- Add regression test
- Re-run full security test suite
- Re-enable tool

**Step 4**: Post-mortem
- Document bug and fix
- Update test suite to prevent recurrence
- Consider additional security layers

---

### If Performance Unacceptable

**Week 2 Performance**: Regex validation is <1ms, unlikely to be bottleneck

**If Needed**:
- Profile with real queries to identify bottleneck
- Optimize regex patterns (compile once, reuse)
- Cache validation results by query hash
- Database execution time will dominate (>100x validation time)

---

---

## Implementation Ready

### What This Plan Delivers
- ✅ **Minimal, secure query execution** using regex-only validation
- ✅ **No new dependencies** - uses existing pg, zod, pino stack
- ✅ **4 implementation steps** - can be completed in 1 week
- ✅ **8 error codes** - simple, deterministic taxonomy
- ✅ **READ ONLY enforcement** - database-level safety guarantee
- ✅ **Clean boundaries** - security validates, adapter executes
- ✅ **Manual testing** - matches Week 1 validation approach
- ✅ **Clear Week 3 roadmap** - AST parsing deferred with rationale

### What Changed from Original Plan
**Removed (Deferred to Week 3)**:
- ❌ `node-sql-parser` dependency
- ❌ `src/security/sqlParser.js` AST validation
- ❌ Function allowlists
- ❌ Subquery wrapper LIMIT enforcement

**Simplified**:
- ✅ Regex-based validation only (no AST parsing)
- ✅ LIMIT append/clamp strategy (no query rewriting)
- ✅ 8 error codes (down from 22)

**Clarified**:
- ✅ Adapter does NOT parse SQL (receives pre-extracted tables)
- ✅ ROLLBACK mandatory on all error paths
- ✅ Audit logs never contain query text or parameter values

**Hardened (Final Pass)**:
- ✅ OFFSET keyword blocked (DOS prevention)
- ✅ Fail-closed: queries with zero extracted tables rejected
- ✅ Transaction safety: no dangling transactions on error
- ✅ Over-extraction acceptable, under-extraction caught at runtime

### Design Philosophy (Matches Week 1)
- **Security-first**: READ ONLY transaction is ultimate guarantee
- **Minimal tooling**: Regex validation, no parsers yet
- **Fail-safe**: Block by default, allow explicitly
- **Deterministic**: Same input always produces same error
- **Pragmatic**: Defer complexity until proven necessary

### Extension Points for Week 3
- Add `node-sql-parser` for AST-based validation (improves table extraction accuracy)
- Add function allowlist (COUNT, SUM, pg_*, etc.) with AST function call detection
- Add OFFSET support with strict limits or cursor-based pagination
- Add subquery support (shallow depth in WHERE clause)
- Add column-level allowlist (filter SELECT * results)
- Expand error taxonomy if needed (more granular codes)
- Add query result caching if performance warrants (hash-based)
- Improve table extraction to handle edge cases (aliased schemas, complex JOINs)

### Week 2 Hardening Summary

This plan includes edge-case hardening for production readiness:
1. **Fail-closed validation**: Queries with no extractable tables are rejected
2. **OFFSET blocking**: DOS prevention (deferred to Week 3 with proper pagination)
3. **Transaction safety**: ROLLBACK mandatory on all error paths
4. **Audit log protection**: Query text and parameter values never logged
5. **Over-extraction acceptable**: False positives are safe, false negatives caught at runtime

These hardening measures ensure Week 2 is production-ready within its defined scope.

---

**Next Action**: Begin implementation Phase 1 (Step 1) - extend queryGuard with regex validation.
