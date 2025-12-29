# Block 1: Identity & Tenant Binding - Quick Reference

## What Was Implemented?
Immutable session context that binds identity + tenant at MCP session start and enforces this binding across all data-plane operations.

---

## Files Modified (Summary)

| File | Changes | Purpose |
|------|---------|---------|
| `src/core/sessionContext.js` | **NEW** (222 lines) | Core session context with immutable binding |
| `src/core/server.js` | 4 changes | Bind context at initialization |
| `src/core/toolRegistry.js` | 3 changes | Store context, inject into tool execution |
| `src/tools/listTables.js` | 1 change | Accept and validate context |
| `src/tools/describeTable.js` | 1 change | Accept and validate context |
| `src/tools/queryRead.js` | 2 changes | Accept, validate, pass context to adapter |
| `src/adapters/baseAdapter.js` | 2 changes | Update abstract method signatures |
| `src/adapters/postgres.js` | 3 changes | Enforce context in all data methods |
| `test-session-context.js` | **NEW** (285 lines) | Comprehensive test suite |
| `BLOCK-1-IMPLEMENTATION.md` | **NEW** | Full documentation |

**Total**: 8 files modified, 3 files created, ~200 lines of production code

---

## Environment Variables (Required)

```bash
# Must be set by trusted control-plane launcher before starting server
export MCP_SESSION_IDENTITY="user@example.com"  # Verified identity
export MCP_SESSION_TENANT="tenant-abc-123"       # Verified tenant
```

---

## Execution Flow

```
1. Server Start (server.js)
   ↓
2. createSessionContextFromEnv() - Reads env vars, validates, creates SessionContext
   ↓
3. context.bind(identity, tenant, sessionId) - Immutable binding, state: UNBOUND → BOUND
   ↓
4. toolRegistry.initialize(server, sessionContext) - Stores context in tool registry
   ↓
5. Tool Execution (e.g., query_read)
   ↓
6. toolRegistry.executeTool() - Asserts context.isBound, injects into handler
   ↓
7. Tool Handler (queryRead.handler) - Validates context, passes to adapter
   ↓
8. Adapter (postgres.executeQuery) - Validates context, executes query
   ↓
9. Audit Log - Logs identity + tenant from context
```

---

## Security Invariants

### 1. Bind Exactly Once
```javascript
// Attempting to rebind throws fatal error
context.bind('user1', 'tenant1', 'session1');  // ✅ OK
context.bind('user2', 'tenant2', 'session2');  // ❌ FATAL: rebinding violation
```

### 2. Fail-Closed
```javascript
// Missing env vars = server refuses to start
// Unbound session = all operations throw errors
// Invalid identity/tenant = binding fails immediately
```

### 3. Immutable After Binding
```javascript
context._identity = 'hacker';  // ❌ Silently fails (Object.freeze)
context.identity;              // ✅ Still returns original value
```

### 4. Defense-in-Depth (5 layers)
1. Control-plane: Validates env vars
2. Server: Binds context before initialization
3. Tool registry: Asserts bound before execution
4. Tool handler: Validates context parameter
5. Adapter: Validates context in every method

---

## API Reference

### SessionContext Class

```javascript
import { SessionContext, createSessionContextFromEnv } from './src/core/sessionContext.js';

// Create unbound context
const context = new SessionContext();

// Bind once (immutable)
context.bind('user@example.com', 'tenant-123', 'session-abc');

// Read-only accessors (throw if unbound)
context.identity;    // → 'user@example.com'
context.tenant;      // → 'tenant-123'
context.sessionId;   // → 'session-abc'
context.boundAt;     // → 1766431683496 (Unix timestamp)

// State checks
context.isBound;     // → true
context.state;       // → 'BOUND'

// Defensive assertion (for data-plane ops)
context.assertBound();  // Throws if unbound

// Safe serialization (for logging)
context.toJSON();
// → { state: 'BOUND', identity: '...', tenant: '...', sessionId: '...', boundAt: ... }
```

### Control-Plane Factory

```javascript
// Create context from environment variables
// Throws if MCP_SESSION_IDENTITY or MCP_SESSION_TENANT missing
const context = createSessionContextFromEnv();
```

---

## Tool Handler Signature

**Before Block 1**:
```javascript
async function handler(input, adapter) {
  // ...
}
```

**After Block 1**:
```javascript
async function handler(input, adapter, sessionContext) {
  // SECURITY: Defensive assertion
  if (!sessionContext || !sessionContext.isBound) {
    throw new Error('SECURITY: tool called without bound session context');
  }

  // Use context.identity and context.tenant as needed
  const result = await adapter.someMethod(input, sessionContext);
  // ...
}
```

---

## Adapter Method Signature

**Before Block 1**:
```javascript
async executeQuery(params) {
  // ...
}
```

**After Block 1**:
```javascript
async executeQuery(params, sessionContext) {
  // SECURITY: Defensive assertion
  if (!sessionContext || !sessionContext.isBound) {
    throw new Error('SECURITY VIOLATION: Adapter called without bound session context');
  }

  // Proceed with query execution
  // ...
}
```

---

## Testing

```bash
# Run test suite
node test-session-context.js

# Expected output: ✅ ALL TESTS PASSED
```

Test coverage:
- ✅ Basic binding
- ✅ Immutability enforcement (rebinding blocked)
- ✅ Fail-closed on invalid inputs
- ✅ assertBound() enforcement
- ✅ Environment-based binding
- ✅ Fail-closed on missing env vars
- ✅ Safe serialization

---

## Error Messages (Security)

All security violations produce explicit error messages:

| Scenario | Error Message |
|----------|---------------|
| Rebinding attempt | `SessionContext: Attempted to rebind an already-bound session (immutability violation)` |
| Missing identity | `SessionContext: Invalid identity (must be non-empty string)` |
| Missing tenant | `SessionContext: Invalid tenant (must be non-empty string)` |
| Unbound operation | `SessionContext: Operation attempted on unbound session (fail-closed)` |
| Missing env vars | `Control-plane binding failed: MCP_SESSION_IDENTITY and MCP_SESSION_TENANT must be set by trusted launcher` |
| Tool without context | `SECURITY: {tool_name} called without bound session context` |
| Adapter without context | `SECURITY VIOLATION: Adapter called without bound session context` |
| Query without context | `SECURITY VIOLATION: Query execution attempted without bound session context` |

---

## Logging

All session-related events are logged:

```json
// Successful binding
{
  "level": "info",
  "identity": "user@example.com",
  "tenant": "tenant-123",
  "sessionId": "abc-xyz",
  "boundAt": 1766431683496,
  "msg": "SessionContext: Successfully bound"
}

// Rebinding attempt (FATAL)
{
  "level": "fatal",
  "state": "BOUND",
  "existingIdentity": "user1@example.com",
  "existingTenant": "tenant-1",
  "attemptedIdentity": "user2@example.com",
  "attemptedTenant": "tenant-2",
  "msg": "SECURITY VIOLATION: Session rebinding attempt"
}

// Missing control-plane binding (FATAL)
{
  "level": "fatal",
  "hasIdentity": false,
  "hasTenant": false,
  "msg": "FATAL: Control-plane binding missing (MCP_SESSION_IDENTITY or MCP_SESSION_TENANT not set)"
}

// Tool execution with context
{
  "level": "info",
  "action": "query_read",
  "identity": "user@example.com",
  "tenant": "tenant-123",
  "outcome": "success",
  "duration": 45
}
```

---

## Compliance Checklist

- [x] ✅ Identity + tenant bound once at session start
- [x] ✅ Context is immutable (no rebinding, Object.freeze)
- [x] ✅ No client-controlled tenant switching
- [x] ✅ Context injected automatically into all tool invocations
- [x] ✅ Fail-closed if identity or tenant missing/invalid
- [x] ✅ No adapter bypass (defensive assertions)
- [x] ✅ No data-plane validation logic modified
- [x] ✅ No new dependencies (Node.js built-ins only)
- [x] ✅ Minimal, explicit changes

---

## Next Steps

### Block 2: Cryptographic Binding Verification
Replace environment-based binding with HMAC/signature-verified tokens:
- Add token signature verification using Node.js crypto
- Enforce token expiry (iat/exp validation)
- Add anti-replay (nonce tracking)
- Integrate with key management for verification keys

### Block 3: Tenant-Scoped Data Isolation
Use bound tenant for row-level security:
- Add tenant column validation to allowlist
- Enforce `WHERE tenant_id = <bound tenant>` in all queries
- Add tenant column auto-injection for INSERT/UPDATE (future)

### Block 4: Identity-Based Authorization
Use bound identity for fine-grained permissions:
- Add role-based access control (RBAC)
- Per-identity table/column permissions
- Audit log enrichment with user actions

---

## Troubleshooting

### Server won't start

**Symptom**: Server logs FATAL error and exits immediately

**Cause**: Missing `MCP_SESSION_IDENTITY` or `MCP_SESSION_TENANT` environment variables

**Fix**:
```bash
export MCP_SESSION_IDENTITY="user@example.com"
export MCP_SESSION_TENANT="tenant-123"
node src/core/server.js
```

---

### Tool execution fails with "unbound session"

**Symptom**: Error: `SECURITY VIOLATION: Tool execution attempted without bound session context`

**Cause**: SessionContext was not initialized or binding failed

**Fix**: Check server logs for binding errors at startup

---

### Rebinding error

**Symptom**: Error: `SessionContext: Attempted to rebind an already-bound session`

**Cause**: Code is attempting to call `context.bind()` more than once

**Fix**: This is a bug—binding should only happen once during server initialization. Review call sites of `context.bind()`.

---

## Code Examples

### Example 1: Add a New Tool

```javascript
// src/tools/myNewTool.js
import { z } from 'zod';

export const myNewToolInputSchema = z.object({
  param1: z.string(),
});

// IMPORTANT: Add sessionContext as third parameter
async function handler(input, adapter, sessionContext) {
  // SECURITY: Always validate context at the start
  if (!sessionContext || !sessionContext.isBound) {
    throw new Error('SECURITY: my_new_tool called without bound session context');
  }

  // Use context as needed
  console.log(`Tool called by identity: ${sessionContext.identity}`);
  console.log(`Tool called for tenant: ${sessionContext.tenant}`);

  // Pass context to adapter if needed
  const result = await adapter.someMethod(input, sessionContext);
  
  return result;
}

export const myNewTool = {
  name: 'my_new_tool',
  description: 'My new tool',
  inputSchema: myNewToolInputSchema,
  handler,
};
```

### Example 2: Add a New Adapter Method

```javascript
// src/adapters/postgres.js (or any adapter)

async myNewMethod(params, sessionContext) {
  const startTime = Date.now();

  // SECURITY: Defensive assertion - context MUST be bound
  if (!sessionContext || !sessionContext.isBound) {
    throw new Error('SECURITY VIOLATION: Adapter called without bound session context');
  }

  try {
    // Use context for logging
    logger.info({
      identity: sessionContext.identity,
      tenant: sessionContext.tenant,
      operation: 'myNewMethod',
    }, 'Executing method');

    // Perform database operation
    // ...

    return result;
  } catch (error) {
    this.logError('myNewMethod', params, error);
    throw error;
  }
}
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│ Control Plane (Trusted Launcher/Orchestrator)          │
│  - Authenticates user/workload                          │
│  - Authorizes tenant access                             │
│  - Sets MCP_SESSION_IDENTITY and MCP_SESSION_TENANT     │
└────────────────────┬────────────────────────────────────┘
                     │ spawn process with env vars
                     ↓
┌─────────────────────────────────────────────────────────┐
│ MCP Server (src/core/server.js)                         │
│  1. createSessionContextFromEnv()                       │
│  2. context.bind(identity, tenant, sessionId)           │
│  3. toolRegistry.initialize(server, context)            │
│     [context now immutable and stored in registry]      │
└────────────────────┬────────────────────────────────────┘
                     │ tool invocation
                     ↓
┌─────────────────────────────────────────────────────────┐
│ Tool Registry (src/core/toolRegistry.js)                │
│  - assertBound()                                         │
│  - Injects sessionContext into handler                  │
└────────────────────┬────────────────────────────────────┘
                     │ handler(input, adapter, context)
                     ↓
┌─────────────────────────────────────────────────────────┐
│ Tool Handler (e.g., src/tools/queryRead.js)             │
│  - Validates sessionContext.isBound                     │
│  - Passes context to adapter                            │
└────────────────────┬────────────────────────────────────┘
                     │ adapter.method(params, context)
                     ↓
┌─────────────────────────────────────────────────────────┐
│ Adapter (e.g., src/adapters/postgres.js)                │
│  - Validates sessionContext.isBound (defense-in-depth)  │
│  - Executes database operation                          │
│  - Logs with identity + tenant                          │
└─────────────────────────────────────────────────────────┘
```

---

**Block 1 Status**: ✅ **COMPLETE & TESTED**

**Test Results**: ✅ All 7 tests passing

**Security Review**: Ready for audit
