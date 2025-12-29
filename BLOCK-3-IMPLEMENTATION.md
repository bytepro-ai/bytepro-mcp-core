# Block 3: Quota & Rate Limiting - Implementation Summary

**Status**: ✅ COMPLETE  
**Date**: 2024-12-22  
**Tests**: 10/10 passing  
**Integration**: Block 1 ✓ | Block 2 ✓

---

## Overview

Block 3 adds **server-side quota and rate limiting** to the MCP Core control-plane, building on Blocks 1–2. Quotas are enforced **after authorization** (Block 2) and **before data-plane validation**, ensuring resource limits are respected while maintaining security guarantees.

### Design Principles

1. **Server-Side Only**: No client hints or client-side throttling
2. **Fail-Closed**: Any ambiguity or counter error results in denial
3. **Tenant + Identity Aware**: Scoped by tenant, identity, and capability set
4. **Pre-Execution**: Enforced before validation or adapter invocation
5. **Adapter-Agnostic**: No data-plane assumptions or SQL parsing
6. **Minimal State**: In-memory counters with TTL eviction
7. **Defense-in-Depth**: Builds on Block 1/2 guarantees

---

## Architecture

### Control-Plane Flow

```
MCP Session Start
    ↓
Block 1: Bind Identity + Tenant (immutable)
    ↓
Block 2: Attach Capabilities (immutable)
    ↓
Block 3: Attach Quota Engine (immutable)
    ↓
Tool Execution Request
    ↓
1. SessionContext Validation (Block 1)
    ↓
2. Authorization Check (Block 2)
    ├─ DENIED → Return error (no quota consumed)
    └─ ALLOWED → Continue
    ↓
3. Quota Check (Block 3) ← YOU ARE HERE
    ├─ DENIED → Return rate limit error
    └─ ALLOWED → Reserve quota (acquire concurrency)
    ↓
4. Data-Plane Validation (Blocks 1-3 unchanged)
    ↓
5. Execution
    ↓
6. Finally: Release concurrency slot
```

### Why After Authorization?

- Prevents unauthorized users from consuming quota
- Avoids quota as a DoS vector against legitimate users
- Prevents leaking authorization state via quota side-effects

---

## Implementation Details

### 1. Quota Dimensions

**File**: `src/security/quotas.js` (NEW, ~530 lines)

#### QuotaDimension Enum (Closed Set)

```javascript
export const QuotaDimension = Object.freeze({
  RATE_PER_MINUTE: 'rate.per_minute',       // Requests per minute
  RATE_PER_10_SECONDS: 'rate.per_10_seconds', // Burst protection
  CONCURRENCY: 'concurrency.max',            // In-flight requests
  COST_PER_MINUTE: 'cost.per_minute',       // Cost-based budget
});
```

#### Tool Cost Table (Server-Defined)

```javascript
const TOOL_COSTS = Object.freeze({
  list_tables: 1,
  describe_table: 2,
  query_read: 5,
});
```

**Rationale**: Cost is assigned **before validation** based only on tool name, avoiding SQL parsing or schema inspection.

---

### 2. Quota Scoping

#### Scope Keys (Server-Derived Only)

All scope dimensions come from **Block 1** and **Block 2** state:

```
tenant:{tenantId}:identity:{identityId}:capset:{capSetId}:action:{action}:target:{toolName}
```

**Components**:
- `tenant`: From Block 1 (immutable binding)
- `identity`: From Block 1 (immutable binding)
- `capSetId`: From Block 2 (capability set identifier)
- `action`: From Block 2 (e.g., `tool.invoke`)
- `target`: Tool name (e.g., `query_read`)

**Fail-Closed**: If any component is missing or ambiguous → deny

---

### 3. State Model

#### In-Memory Counters (Default)

- **Token Buckets**: Rate limiting with refill over time
- **Semaphores**: Concurrency tracking with acquire/release
- **TTL Eviction**: Unused keys expire after 1 hour
- **Max Keys**: Hard limit of 10,000 keys per process (prevent memory exhaustion)

#### Data Structures

```javascript
class TokenBucket {
  - capacity: max tokens
  - refillRate: tokens per window
  - windowMs: refill window duration
  - tokens: current available tokens
  - lastRefill: timestamp of last refill
}

class Semaphore {
  - maxConcurrent: maximum in-flight
  - current: current in-flight count
}
```

**Clock Safety**: If clock goes backwards → deny (fail-closed)

---

### 4. QuotaPolicy & QuotaEngine

#### QuotaPolicy Class

Immutable policy defining limits for a scope:

```javascript
new QuotaPolicy({
  tenant: 'tenant-123',
  identity: 'user@example.com', // null = tenant-wide
  capSetId: 'cap-abc',          // null = all capsets
  limits: {
    'rate.per_minute': 60,
    'rate.per_10_seconds': 10,
    'concurrency.max': 5,
    'cost.per_minute': 100,
  }
});
```

#### QuotaEngine Class

Central enforcement point:

```javascript
checkAndReserve(context) {
  // 1. Build scope key (fail-closed on ambiguity)
  // 2. Find applicable policy (fail-closed if missing/ambiguous)
  // 3. Check rate limits (token buckets)
  // 4. Check cost budget (cost bucket)
  // 5. Check concurrency (semaphore)
  // Returns: { allowed: boolean, reason: string, semaphoreKey: string }
}

release(semaphoreKey) {
  // MUST be called in finally block to prevent leaks
}
```

**Policy Resolution**:
- Exactly one policy must apply (fail-closed on multiple or zero)
- Future: explicit merge rules for tenant + identity policies

---

### 5. SessionContext Integration

**File**: `src/core/sessionContext.js` (MODIFIED)

#### WeakMap Storage

```javascript
const quotaEngineMap = new WeakMap();
const quotaEngineAttachedMap = new WeakMap();
```

**Why WeakMaps**: Allows attachment after `Object.freeze()` in Block 1

#### Methods

```javascript
attachQuotaEngine(quotaEngine)  // One-time attachment
get quotaEngine()               // Read-only access
get hasQuotaEngine()            // Boolean check
```

**Invariants**:
- Quota engine attached exactly once
- Must be attached after binding (Block 1) and capabilities (Block 2)
- Attachment logged to audit trail

---

### 6. Enforcement Point

**File**: `src/core/toolRegistry.js` (MODIFIED)

#### Execution Flow Order

```javascript
async executeTool(name, args) {
  // 1. Verify SessionContext (Block 1)
  // 2. Authorization check (Block 2)
  //    └─ If denied → return error (no quota consumed)
  
  // 3. QUOTA CHECK (Block 3) ← NEW
  let quotaSemaphoreKey = null;
  
  if (this.sessionContext.hasQuotaEngine) {
    const quotaResult = quotaEngine.checkAndReserve({
      tenant: this.sessionContext.tenant,
      identity: this.sessionContext.identity,
      sessionId: this.sessionContext.sessionId,
      capSetId: this.sessionContext.capabilities?.capSetId,
      action: CapabilityAction.TOOL_INVOKE,
      target: name,
    });
    
    if (!quotaResult.allowed) {
      return RATE_LIMITED_ERROR;
    }
    
    quotaSemaphoreKey = quotaResult.semaphoreKey;
  }
  
  // 4. Validation
  // 5. Execution
  try {
    result = await tool.handler(...);
  } finally {
    // 6. Always release concurrency slot
    if (quotaSemaphoreKey) {
      quotaEngine.release(quotaSemaphoreKey);
    }
  }
}
```

**Critical**: Concurrency release in `finally` block prevents leaks on errors

---

### 7. Server Initialization

**File**: `src/core/server.js` (MODIFIED)

```javascript
// 1. Bind identity + tenant (Block 1)
this.sessionContext = createSessionContextFromEnv();

// 2. Attach capabilities (Block 2)
const capabilities = loadCapabilitiesFromEnv();
this.sessionContext.attachCapabilities(capabilities);

// 3. Attach quota engine (Block 3) ← NEW
const quotaEngine = loadQuotaEngineFromEnv();
this.sessionContext.attachQuotaEngine(quotaEngine);

// 4. Initialize tools (all blocks attached)
await toolRegistry.initialize(this.server, this.sessionContext);
```

**Fail-Closed**: Any error loading or attaching quotas → session termination

---

## Environment Variable Format

### MCP_QUOTA_POLICIES

JSON format defining quota policies:

```json
{
  "policies": [
    {
      "tenant": "tenant-123",
      "identity": "user@example.com",
      "capSetId": "cap-abc",
      "limits": {
        "rate.per_minute": 60,
        "rate.per_10_seconds": 10,
        "concurrency.max": 5,
        "cost.per_minute": 100
      }
    }
  ]
}
```

**Fields**:
- `tenant`: Tenant identifier (required)
- `identity`: Identity identifier (optional, null = tenant-wide)
- `capSetId`: Capability set identifier (optional, null = all capsets)
- `limits`: Object mapping QuotaDimension to limit values

**Loading Behavior**:
- If `MCP_QUOTA_POLICIES` not set → engine with no policies (effectively no quotas)
- If malformed JSON → fatal error (fail-closed)
- If invalid policy structure → fatal error (fail-closed)

---

## Error Responses

### Rate Limited Error

```json
{
  "code": "RATE_LIMITED",
  "message": "Request denied by quota policy",
  "details": {
    "tool": "query_read",
    "reason": "RATE_EXCEEDED"
  }
}
```

**Reasons** (QuotaDenialReason enum):
- `QUOTA_POLICY_MISSING`: No applicable policy found
- `QUOTA_POLICY_AMBIGUOUS`: Multiple policies or missing scope components
- `RATE_EXCEEDED`: Token bucket exhausted
- `CONCURRENCY_EXCEEDED`: Max in-flight requests reached
- `COST_EXCEEDED`: Cost budget exhausted
- `COUNTER_ERROR`: Internal counter error or max keys exceeded
- `CLOCK_AMBIGUITY`: Clock went backwards

**Note**: Intentionally generic - does not leak policy details or remaining capacity

---

## Audit Logging

### Quota Decision Logging

```javascript
auditLog({
  action: 'quota',
  tool: 'query_read',
  identity: 'user@example.com',
  tenant: 'tenant-123',
  decision: 'DENY',
  reason: 'RATE_EXCEEDED',
  duration: 5,
  outcome: 'denied',
});
```

**Logged Fields**:
- `action`: Always 'quota'
- `tool`: Tool name being invoked
- `identity`: From Block 1
- `tenant`: From Block 1
- `decision`: 'ALLOW' or 'DENY'
- `reason`: QuotaDenialReason value (if denied)
- `duration`: Time to make decision (ms)
- `outcome`: 'success' or 'denied'

**Not Logged**:
- SQL text, schema names, table names
- Token counts, remaining capacity
- Client-supplied data

---

## Test Coverage

**File**: `test-block-3.js` (NEW, 10 tests)

| # | Test | Status |
|---|------|--------|
| 1 | QuotaPolicy creation and validation | ✅ PASS |
| 2 | Quota check with missing policy (fail-closed) | ✅ PASS |
| 3 | Rate limiting enforcement | ✅ PASS |
| 4 | Concurrency limiting enforcement | ✅ PASS |
| 5 | Cost-based quota enforcement | ✅ PASS |
| 6 | Policy applicability (tenant vs identity) | ✅ PASS |
| 7 | SessionContext quota engine attachment | ✅ PASS |
| 8 | Ambiguous scope results in denial | ✅ PASS |
| 9 | Multiple quota dimensions enforced together | ✅ PASS |
| 10 | Token bucket refill over time | ✅ PASS |

**Run Tests**:
```bash
AUDIT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa node test-block-3.js
```

---

## Security Guarantees

### Block 1 & 2 Preservation

✅ Identity/tenant binding remains immutable  
✅ Capability-based authorization unchanged  
✅ No modifications to Block 1 or Block 2 invariants  
✅ Quotas cannot alter identity, tenant, or capabilities  

### Quota Guarantees

✅ Enforced after authorization (prevents unauthorized quota consumption)  
✅ Enforced before validation (no data-plane leakage)  
✅ Fail-closed on missing/ambiguous policy  
✅ Fail-closed on counter errors  
✅ Fail-closed on clock skew  
✅ Concurrency slots always released (finally block)  
✅ No client-supplied hints or overrides  

### Abuse Resistance

✅ Scope keys derived server-side only (Block 1 + Block 2)  
✅ WeakSet branding prevents fake SessionContext  
✅ TTL eviction + max keys prevents memory exhaustion  
✅ No data-plane content in audit logs  
✅ Generic error messages (no policy detail leakage)  

---

## Integration Examples

### Example 1: Basic Rate Limiting

```bash
export MCP_QUOTA_POLICIES='{
  "policies": [{
    "tenant": "tenant-123",
    "identity": null,
    "capSetId": null,
    "limits": {
      "rate.per_minute": 60,
      "rate.per_10_seconds": 10
    }
  }]
}'

# Tenant-wide: 60 req/min, 10 req/10sec
# - Burst of 10 requests allowed
# - Sustained rate: 1 req/second
```

### Example 2: Identity-Specific Limits

```bash
export MCP_QUOTA_POLICIES='{
  "policies": [
    {
      "tenant": "tenant-123",
      "identity": "power-user@example.com",
      "capSetId": null,
      "limits": {
        "rate.per_minute": 200,
        "concurrency.max": 10,
        "cost.per_minute": 1000
      }
    },
    {
      "tenant": "tenant-123",
      "identity": null,
      "capSetId": null,
      "limits": {
        "rate.per_minute": 60,
        "concurrency.max": 2,
        "cost.per_minute": 300
      }
    }
  ]
}'

# power-user@example.com: higher limits
# All other users in tenant-123: standard limits
# Note: Must have exactly one matching policy (fail-closed on multiple)
```

### Example 3: Concurrency Control Only

```bash
export MCP_QUOTA_POLICIES='{
  "policies": [{
    "tenant": "tenant-123",
    "identity": null,
    "capSetId": null,
    "limits": {
      "concurrency.max": 5
    }
  }]
}'

# Limit in-flight requests to 5
# No rate or cost limits
```

---

## Operational Considerations

### Memory Usage

- **Per-Key Overhead**: ~200 bytes (bucket + semaphore + timestamp)
- **Max Keys**: 10,000 (configurable in QuotaEngine)
- **Max Memory**: ~2MB at capacity
- **TTL Eviction**: Automatic cleanup after 1 hour of inactivity

### Failure Modes

| Scenario | Behavior |
|----------|----------|
| No MCP_QUOTA_POLICIES | Engine with no policies (no quotas enforced) |
| Malformed JSON | Fatal error, session termination |
| Invalid policy | Fatal error, session termination |
| No matching policy | Deny with POLICY_MISSING |
| Multiple matching policies | Deny with POLICY_AMBIGUOUS |
| Counter error | Deny with COUNTER_ERROR |
| Max keys exceeded | Deny with COUNTER_ERROR |
| Clock skew | Deny with CLOCK_AMBIGUITY |

### Monitoring

Recommended metrics (from audit logs):
- `quota_decisions_total{tenant, tool, decision, reason}`
- `quota_denied_total{tenant, reason}`
- `quota_decision_duration_ms{tenant, tool}`

---

## Future Enhancements

### Planned for Block 4+

- **Durable Backend**: Pluggable quota store for multi-process deployments
- **Policy Merge Rules**: Explicit tenant + identity policy composition
- **Dynamic Policy Updates**: Reload policies without restart
- **Per-Resource Quotas**: Table-level or schema-level limits
- **Adaptive Rate Limiting**: Automatic adjustment based on system load

### Not Planned

- ❌ Client-supplied quota hints (violates server-side enforcement)
- ❌ Per-query cost calculation (requires SQL parsing)
- ❌ Data-plane metrics as quota signals (leaks SQL content)
- ❌ HTTP rate limit headers (no HTTP assumptions)

---

## Dependencies

**No new dependencies added**. All implementations use Node.js built-ins:
- `Map` / `WeakMap` / `WeakSet` (native)
- `Date.now()` for timestamps
- `Object.freeze()` for immutability

---

## Related Documentation

- [Block 1 Implementation](./BLOCK-1-IMPLEMENTATION.md)
- [Block 2 Implementation](./BLOCK-2-IMPLEMENTATION.md)
- [Audit Logging](./AUDIT-LOGGING-README.md)
- [Quick Reference](./QUICKREF.md)

---

**END OF DOCUMENT**
