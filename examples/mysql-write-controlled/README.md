# MySQL Write-Controlled Example

## ⚠️ Critical Understanding

**This example demonstrates tool-level write capability.**

### What This Means

- **Write safety is NOT a core library guarantee**
- The core library **CAN execute database writes** if tools are implemented to do so
- **Operators are fully responsible** for:
  - Credential isolation (dedicated MySQL user with minimal INSERT-only privileges)
  - Policy enforcement (capability grants, read-only mode)
  - Audit retention and monitoring
  - Production deployment decisions

**DO NOT deploy this example to production without:**
1. Dedicated database credentials with INSERT-only access to specific tables
2. Comprehensive monitoring and alerting
3. Security review of your specific use case
4. Clear incident response procedures

---

## What This Example Demonstrates

This example shows how to implement a **controlled mutation tool** within the BytePro MCP Core security framework.

The core library provides enforcement primitives (execution boundary, authorization, quotas, read-only mode), but **write safety is a property of specific tool implementations**, not a global guarantee.

---

## Safety Controls (Defense in Depth)

This example demonstrates **multiple layers of defense** for mutation operations:

### 1. Execution Boundary Enforcement (Core Library)
- Uses [`executeToolBoundary`](../../src/core/executeToolBoundary.js) (no bypass)
- Read-only mode (`mode.readOnly = true`) **blocks execution** before any side effects
- Session context validation (bound, branded, authentic)
- Tool lookup (unknown tools denied before side effects)

### 2. Authorization (Core Library)
- Requires explicit capability: `TOOL_INVOKE` on `add_customer`
- Enforced via [`evaluateCapability`](../../src/security/capabilities.js)
- Default deny (no grant = no execution)
- Capability expiration honored

### 3. Quota Enforcement (Core Library)
- Rate limits (per-minute, per-10-seconds)
- Concurrency limits (semaphore-based)
- Cost-based limits (mutation operations can be assigned higher costs)
- Enforced via [`QuotaEngine`](../../src/security/quotas.js)

### 4. Tool-Specific Controls (This Example)
- **Single operation only:** `INSERT INTO sakila.customer`
- **Parameterized query:** No SQL injection possible
- **Database allowlist:** Only operates on `sakila` database (hard-coded check in tool)
- **Input validation:** Zod schema with strict constraints (store_id range, name length, email format)
- **No arbitrary SQL:** Query is fixed, only values are parameterized
- **Defensive assertions:** Validates session context at tool entry

### 5. Audit Logging (Core Library + Tool)
- Logs mutation initiation (identity, tenant, parameters - no sensitive data)
- Logs mutation completion (customer_id, execution time)
- Logs mutation failure (error details, no data leakage)
- Uses existing [`logger`](../../src/utils/logger.js) infrastructure

---

## What Is NOT Safe (Intentional Limitations)

This example **intentionally does NOT provide:**

- ❌ Generic query execution (no `INSERT ... WHERE user_input`)
- ❌ Dynamic table targeting (only `sakila.customer`)
- ❌ Arbitrary SQL construction from user input
- ❌ Cross-database mutations
- ❌ Batch operations
- ❌ Transaction management exposed to callers
- ❌ Cascade deletes or foreign key manipulation
- ❌ Schema modifications (DDL)

**If you need these capabilities, they require separate security design and review.**

---

## Setup

### 1. Prerequisites
- MySQL server (version 5.7+ or 8.0+)
- Sakila sample database installed
- Node.js 18+ installed
- BytePro MCP Core dependencies installed (`npm install` from repository root)

### 2. Install Sakila Database

```bash
# Download Sakila sample database
wget https://downloads.mysql.com/docs/sakila-db.tar.gz
tar -xzf sakila-db.tar.gz

# Import schema and data
mysql -u root -p < sakila-db/sakila-schema.sql
mysql -u root -p < sakila-db/sakila-data.sql

# Verify installation
mysql -u root -p -e "USE sakila; SHOW TABLES;"
```

### 3. Create Dedicated MySQL User (CRITICAL)

**DO NOT use root or admin credentials in production.**

```sql
-- Create dedicated user with INSERT-only access
CREATE USER 'mcp_writer'@'localhost' IDENTIFIED BY 'secure_password_here';

-- Grant INSERT only on sakila.customer table
GRANT INSERT ON sakila.customer TO 'mcp_writer'@'localhost';

-- Verify grants (should show only INSERT on sakila.customer)
SHOW GRANTS FOR 'mcp_writer'@'localhost';

-- Test connection
mysql -u mcp_writer -p sakila
```

### 4. Configure Environment

```bash
# Copy example environment file
cp examples/mysql-write-controlled/.env.example examples/mysql-write-controlled/.env
```

Edit `examples/mysql-write-controlled/.env`:

- Set `MYSQL_USER` to your dedicated user (`mcp_writer`)
- Set `MYSQL_PASSWORD` to the secure password
- Set `READ_ONLY=false` (CRITICAL for writes)
- Configure capabilities with explicit `tool.invoke` grant for `add_customer`
- Generate `AUDIT_SECRET` with `openssl rand -hex 32`

### 5. Run the Server

```bash
# From repository root
node examples/mysql-write-controlled/server.js
```

**Expected startup logs:**
```
INFO: MySQL adapter connected
INFO: Capabilities attached (capSetId: write-example, grants: 2)
INFO: Tool registry initialized
INFO: Write-enabled tool registered (tool: add_customer)
INFO: Write-enabled MCP server example running on stdio
```

---

## Testing

### Test 1: Verify Read-Only Mode Blocks Writes

**Purpose:** Prove the execution boundary denies writes **before execution** when read-only mode is enabled.

**Environment:** Set `READ_ONLY=true` in `.env`

**Restart server**, then use MCP Inspector:

**Tool:** `add_customer`

**Payload:**
```json
{
  "store_id": 1,
  "first_name": "Alice",
  "last_name": "Smith",
  "email": "alice@example.com",
  "address_id": 1
}
```

**Expected Result:**
- Status: **Error**
- Error code: `READ_ONLY`
- Message: "Write operations are not allowed in read-only mode"
- **No database mutation occurred**
- **No tool execution occurred** (verify in logs: no "Customer insert initiated" message)

---

### Test 2: Verify Authorization Denial

**Purpose:** Prove capability-based authorization is enforced **before execution**.

**Environment:** Remove `tool.invoke` grant for `add_customer`

```bash
MCP_CAPABILITIES='{"capSetId":"test","issuedAt":1234567890000,"expiresAt":9999999999000,"issuer":"test","grants":[{"action":"tool.list","target":"*"}]}'
```

**Restart server**, then attempt insert.

**Expected Result:**
- Status: **Error**
- Error code: `AUTHORIZATION_DENIED`
- Message: "Insufficient permissions to invoke this tool"
- **No database mutation occurred**

---

### Test 3: Successful Insert (Happy Path)

**Purpose:** Verify tool works correctly when all security checks pass.

**Environment:** Proper configuration with write capability grant

**Tool:** `add_customer`

**Payload:**
```json
{
  "store_id": 1,
  "first_name": "Charlie",
  "last_name": "Brown",
  "email": "charlie@example.com",
  "address_id": 3
}
```

**Expected Result:**
- Status: **Success**
- Response includes: `customer_id`, `inserted_at`
- **Database mutation occurred** (verify in MySQL)

**Audit logs should show:**
```
INFO: Customer insert initiated
INFO: Customer insert completed (customer_id: <id>, executionTime: <ms>)
```

---

### Test 4: Input Validation

**Purpose:** Verify input validation rejects invalid data **before execution**.

**Payload (invalid store_id):**
```json
{
  "store_id": 999,
  "first_name": "Diana",
  "last_name": "Prince",
  "address_id": 1
}
```

**Expected Result:**
- Status: **Error**
- Error code: `VALIDATION_ERROR`
- Details: "store_id: Number must be less than or equal to 2"
- **No database mutation occurred**

---

### Test 5: Foreign Key Violation

**Purpose:** Verify database constraints are enforced (fail-safe).

**Payload (non-existent address_id):**
```json
{
  "store_id": 1,
  "first_name": "Eve",
  "last_name": "Wilson",
  "email": "eve@example.com",
  "address_id": 99999
}
```

**Expected Result:**
- Status: **Error**
- Error code: `INSERT_FAILED`
- Details: Foreign key constraint violation
- **No database mutation occurred** (transaction rolled back)

---

## Security Review Checklist

Before deploying a write-enabled tool to production:

### Execution Boundary (Core Library)
- [ ] Tool uses `executeToolBoundary` (no bypass)
- [ ] Read-only mode blocks execution (test with `READ_ONLY=true`)
- [ ] Authorization denial blocks execution (test with missing capability grant)

### Tool Implementation
- [ ] Tool operates on **fixed, allowlisted table** (no dynamic table targeting)
- [ ] All queries are **parameterized** (no SQL injection possible)
- [ ] Capability requirement is **explicit and documented**
- [ ] Input validation **rejects invalid data**
- [ ] Database allowlist is **enforced** (tool checks adapter config)
- [ ] No arbitrary SQL execution (query is fixed)

### Database Configuration
- [ ] Dedicated MySQL user with **minimal privileges** (INSERT-only on specific table)
- [ ] User CANNOT read other tables
- [ ] User CANNOT modify schema
- [ ] User CANNOT drop tables

### Audit & Monitoring
- [ ] Audit logging captures **identity, tenant, outcome**
- [ ] Audit logs do NOT contain **sensitive data**
- [ ] Failed attempts are logged
- [ ] Successful mutations are logged

---

## Why This Is Safe (Defense in Depth)

**Compared to a generic "execute any SQL" tool:**

| Generic Tool | This Example |
|--------------|--------------|
| ❌ Arbitrary SQL | ✅ Fixed query (INSERT only) |
| ❌ Dynamic table targeting | ✅ Single table (`sakila.customer`) |
| ❌ User-controlled WHERE clauses | ✅ No WHERE clause |
| ❌ SQL injection risk | ✅ Parameterized query |
| ❌ Cross-database access | ✅ Database allowlist enforced |
| ❌ Implicit capability grants | ✅ Explicit `TOOL_INVOKE` required |

**Defense in depth (7 layers):**

1. Boundary-level read-only enforcement → Blocks writes at system level
2. Capability-based authorization → Explicit grant required
3. Quota enforcement → Rate/concurrency/cost limits
4. Input validation → Schema-based, fail-closed (Zod)
5. Tool-level database allowlist → Hard-coded check
6. Parameterized query → SQL injection impossible
7. Audit logging → Full trail for incident response

---

## Extending This Example

If you need to add more write-enabled tools:

### Design Principles
1. **One tool = one mutation operation**
2. **Fixed queries only** (no dynamic SQL)
3. **Explicit capability grants** (one grant per tool)
4. **Database/table allowlists** (hard-coded in tool)
5. **Parameterized values only**

### DO NOT
- ❌ Implement generic query execution
- ❌ Allow user-controlled table names
- ❌ Construct SQL from user input
- ❌ Bypass the execution boundary
- ❌ Expose transaction control to callers

---

## Operator Responsibility Statement

**By deploying this example or similar write-enabled tools, you acknowledge:**

1. **The core library does not guarantee write safety.** Write safety is a property of specific tool implementations.

2. **You are responsible for:**
   - Defining and enforcing authorization policies for mutations
   - Configuring database credentials with minimal required privileges
   - Implementing monitoring and alerting appropriate for your risk tolerance
   - Complying with data governance and regulatory requirements
   - Incident response and remediation

3. **This example is a reference implementation**, not a production-ready solution.

4. **The core library developers are not responsible for:**
   - Misuse of write-capable tools
   - Data corruption or loss
   - Compliance violations
   - Security incidents resulting from insufficient access controls

**If you are unsure whether your use case is safe, consult a security professional before deployment.**

---

## License

Apache-2.0 (same as BytePro MCP Core)
