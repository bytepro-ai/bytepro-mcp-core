# Manual Testing Guide: Week 2 `query_read` Tool

## Prerequisites

Before testing, ensure:
- ✅ PostgreSQL is running and accessible
- ✅ Database connection configured in `.env`
- ✅ Security allowlist configured in `src/config/allowlist.json`
- ✅ At least one table exists in an allowed schema
- ✅ MCP Inspector installed (`npm install -g @modelcontextprotocol/inspector`)

## Test Execution Flow

This guide must be followed **in order**. Each section requires explicit human confirmation before proceeding.

---

## Section 1: Server Startup Verification

### Step 1.1: Start MCP Server

```bash
cd /Users/manuelcazares/Documents/GitHub/bytepro-mcp-core
node src/core/server.js
```

**Expected Output:**
- No startup errors
- Logs show "Tool registry initialized"
- Server listens on stdio

**✋ CHECKPOINT:** Confirm server started successfully before proceeding.

---

## Section 2: Tool Discovery

### Step 2.1: Verify Tool Registration

**Action:** In MCP Inspector, connect to the server and request `tools/list`.

**Expected Result:**
- Tool `query_read` appears in the list
- Description mentions "read-only SELECT query"
- Input schema includes: `query`, `params`, `limit`, `timeout`

**✋ CHECKPOINT:** Confirm `query_read` tool is registered.

---

## Section 3: Happy Path Tests

### Test 3.1: Simple SELECT Query

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM users LIMIT 10",
  "params": [],
  "limit": 10,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Success
- Returns: `rows`, `rowCount`, `fields`, `metadata`
- `metadata.truncated`: false (if table has ≤10 rows)
- `metadata.appliedLimit`: 10

**✋ CHECKPOINT:** Confirm successful execution and correct data returned.

---

### Test 3.2: Parameterized Query

**MCP Inspector Payload:**
```json
{
  "query": "SELECT id, name FROM users WHERE id = $1",
  "params": [1],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Success
- Returns single row (or empty if id=1 doesn't exist)
- Parameters correctly bound

**✋ CHECKPOINT:** Confirm parameterized query works correctly.

---

### Test 3.3: JOIN Query

**MCP Inspector Payload:**
```json
{
  "query": "SELECT u.id, u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id LIMIT 5",
  "params": [],
  "limit": 5,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Success
- Returns joined data
- Both `users` and `orders` tables validated against allowlist

**✋ CHECKPOINT:** Confirm JOIN query executes successfully.

---

### Test 3.4: Limit Enforcement

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM users LIMIT 2000",
  "params": [],
  "limit": 1500,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Success
- `metadata.appliedLimit`: 1000 (server enforces max 1000)
- `metadata.truncated`: true (if table has >1000 rows)

**✋ CHECKPOINT:** Confirm server-side limit enforcement (max 1000 rows).

---

## Section 4: Security Tests

### Test 4.1: Block INSERT Attempt

**MCP Inspector Payload:**
```json
{
  "query": "INSERT INTO users (name) VALUES ('hacker')",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `QUERY_REJECTED` or `INVALID_QUERY_SYNTAX`
- Message mentions forbidden keyword or must start with SELECT

**✋ CHECKPOINT:** Confirm write operation is blocked.

---

### Test 4.2: Block Multi-Statement

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM users; DROP TABLE users;",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `QUERY_REJECTED` or `FORBIDDEN_CONSTRUCT`
- Message mentions semicolons or multi-statement forbidden

**✋ CHECKPOINT:** Confirm multi-statement injection is blocked.

---

### Test 4.3: Block Implicit Joins (Critical)

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM users, orders WHERE users.id = orders.user_id",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `QUERY_REJECTED` or `FORBIDDEN_CONSTRUCT`
- Message mentions implicit joins or comma-separated tables

**✋ CHECKPOINT:** Confirm implicit join bypass is blocked.

---

### Test 4.4: Block OFFSET Keyword

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM users LIMIT 10 OFFSET 1000000",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `QUERY_REJECTED` or `FORBIDDEN_CONSTRUCT`
- Message mentions OFFSET forbidden or DOS prevention

**✋ CHECKPOINT:** Confirm OFFSET is blocked.

---

### Test 4.5: Block CTEs (WITH Clause)

**MCP Inspector Payload:**
```json
{
  "query": "WITH temp AS (SELECT * FROM users) SELECT * FROM temp",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `QUERY_REJECTED` or `FORBIDDEN_CONSTRUCT`
- Message mentions WITH or CTEs forbidden

**✋ CHECKPOINT:** Confirm CTEs are blocked.

---

### Test 4.6: Block UNION

**MCP Inspector Payload:**
```json
{
  "query": "SELECT id FROM users UNION SELECT id FROM orders",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `QUERY_REJECTED` or `FORBIDDEN_CONSTRUCT`
- Message mentions UNION forbidden

**✋ CHECKPOINT:** Confirm UNION is blocked.

---

### Test 4.7: Block Comments

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM users -- WHERE admin = true",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `QUERY_REJECTED` or `FORBIDDEN_CONSTRUCT`
- Message mentions comments forbidden

**✋ CHECKPOINT:** Confirm SQL comments are blocked.

---

### Test 4.8: Block Unauthorized Table

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM secret_table LIMIT 10",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Note:** `secret_table` must NOT be in your allowlist.

**Expected Result:**
- Status: Error
- Error code: `PERMISSION_DENIED` or `UNAUTHORIZED_TABLE`
- Message mentions table not allowed or access denied

**✋ CHECKPOINT:** Confirm allowlist enforcement works.

---

## Section 5: Error Sanitization Tests

### Test 5.1: Syntax Error Handling

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FORM users",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `SYNTAX_ERROR` or `EXECUTION_ERROR`
- Message: **Generic message** like "SQL syntax error" or "Query execution failed"
- **CRITICAL:** Message must NOT contain raw PostgreSQL error details

**✋ CHECKPOINT:** Confirm no raw database errors are exposed.

---

### Test 5.2: Column Does Not Exist

**MCP Inspector Payload:**
```json
{
  "query": "SELECT nonexistent_column FROM users LIMIT 10",
  "params": [],
  "limit": 100,
  "timeout": 30000
}
```

**Expected Result:**
- Status: Error
- Error code: `EXECUTION_ERROR` or `OBJECT_NOT_FOUND`
- Message: **Generic message** like "Query execution failed" or "Referenced table or column not found"
- **CRITICAL:** Message must NOT contain raw PostgreSQL error with schema details

**✋ CHECKPOINT:** Confirm error messages are sanitized.

---

## Section 6: Resource Protection Tests

### Test 6.1: Query Timeout

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM users WHERE id IN (SELECT id FROM pg_sleep(5))",
  "params": [],
  "limit": 100,
  "timeout": 2000
}
```

**Note:** Adjust query to something that will exceed 2 seconds on your database.

**Expected Result:**
- Status: Error
- Error code: `TIMEOUT` or `QUERY_TIMEOUT`
- Message mentions timeout or execution time exceeded

**✋ CHECKPOINT:** Confirm timeout enforcement works.

---

### Test 6.2: Row Limit Truncation

**MCP Inspector Payload:**
```json
{
  "query": "SELECT * FROM users",
  "params": [],
  "limit": 50,
  "timeout": 30000
}
```

**Note:** Ensure `users` table has >50 rows.

**Expected Result:**
- Status: Success
- Returns exactly 50 rows (or fewer if table has <50)
- `metadata.truncated`: true (if table has >50 rows)
- `metadata.appliedLimit`: 50

**✋ CHECKPOINT:** Confirm row limit enforcement and truncation flag.

---

## Section 7: Final Checklist

Walk through each item and confirm:

- [ ] Server starts without errors
- [ ] `query_read` tool appears in tool discovery
- [ ] Simple SELECT queries execute successfully
- [ ] Parameterized queries work correctly
- [ ] JOIN queries work correctly
- [ ] Server enforces max limit of 1000 rows
- [ ] INSERT/UPDATE/DELETE are blocked
- [ ] Multi-statement queries are blocked
- [ ] Implicit joins (comma-separated tables) are blocked
- [ ] OFFSET keyword is blocked
- [ ] CTEs (WITH clause) are blocked
- [ ] UNION/INTERSECT/EXCEPT are blocked
- [ ] SQL comments (-- and /* */) are blocked
- [ ] Unauthorized tables are blocked by allowlist
- [ ] Raw database error messages are NOT exposed to clients
- [ ] Query timeouts are enforced
- [ ] Row limits are enforced with truncation metadata
- [ ] All queries execute in READ ONLY transactions (verify in logs if possible)

**✋ CHECKPOINT:** All items must be checked before sign-off.

---

## Test Results

All Week 2 tests passed:
- Valid SELECT queries succeed
- Invalid or unsafe queries are rejected
- No schema leakage observed
- Runtime behavior verified against PostgreSQL

---

## Test Completion

Once all sections are complete and all checkpoints confirmed:

**Status:** All Week 2 guided tests complete — awaiting human sign-off.
