# Block 2: Capability-Based Authorization - Implementation Summary

**Status**: ✅ COMPLETE  
**Date**: 2024-01-22  
**Tests**: 10/10 passing

---

## Overview

Block 2 adds **capability-based authorization** to the MCP Core control-plane, building on Block 1's identity/tenant binding. Authorization is enforced **before** any data-plane validation or query execution.

### Design Principles

1. **Default Deny**: No action is authorized unless explicitly granted
2. **Fail-Closed**: Any error, ambiguity, or missing capability results in denial
3. **Immutable Grants**: Capabilities cannot be modified after attachment
4. **Closed Enum**: Only predefined actions are allowed (no dynamic permissions)
5. **Defense-in-Depth**: Enforcement at multiple layers (registry → tools → adapters)

---

## Architecture

### Control-Plane Flow

```
MCP Session Start
    ↓
Block 1: Bind Identity + Tenant (immutable)
    ↓
Load Capabilities from Environment (MCP_CAPABILITIES)
    ↓
Attach Capabilities to SessionContext (one-time, immutable)
    ↓
Tool Execution Request
    ↓
Authorization Check (ToolRegistry)
    ├─ AUTHORIZED → Input Validation → Execute
    └─ DENIED → Log + Return Error (no execution)
```

### Authorization Enforcement

**Primary Enforcement**: `src/core/toolRegistry.js`  
- Authorization check occurs **before** input validation
- Logs all authorization decisions to audit log
- Returns `AUTHORIZATION_DENIED` error on failure
- Filters tool list based on capabilities

**Defense-in-Depth**:
- Tools validate SessionContext integrity (WeakSet check)
- Adapters validate SessionContext integrity (WeakSet check)
- Multi-layer validation prevents bypass attempts

---

## Implementation Details

### 1. Capability Model

**File**: `src/security/capabilities.js` (NEW, ~330 lines)

#### CapabilityAction Enum (Closed Set)

```javascript
export const CapabilityAction = Object.freeze({
  TOOL_INVOKE: 'tool.invoke',      // Execute specific tool
  TOOL_LIST: 'tool.list',          // List available tools
  RESOURCE_READ: 'resource.read',  // Read resource (future)
  RESOURCE_WRITE: 'resource.write', // Write resource (future)
});
```

#### CapabilitySet Class

Immutable capability grants with:
- `capSetId`: Unique identifier for audit trail
- `issuedAt` / `expiresAt`: Time-based validity
- `issuer`: Issuing authority (for future multi-issuer support)
- `grants`: Array of `{ action, target }` pairs

**Validation**:
- Rejects expired capabilities at construction time (fail-closed)
- Validates all required fields
- Freezes object after creation (immutable)

#### Authorization Evaluation

```javascript
export function evaluateCapability(capabilities, action, target)
```

**Logic**:
1. If no capabilities → DENY
2. If action not in CapabilityAction enum → DENY
3. If capabilities expired → DENY
4. If no matching grant → DENY
5. If grant found with matching action:
   - Exact target match → ALLOW
   - Wildcard (`*`) → ALLOW
6. Otherwise → DENY

**Returns**: `{ authorized: boolean, reason: AuthzReason }`

#### Control-Plane Loading

```javascript
export function loadCapabilitiesFromEnv()
```

Loads capabilities from `MCP_CAPABILITIES` environment variable:
- JSON format: Same as CapabilitySet constructor
- Fail-closed on parse errors or validation failures
- Logs all loading attempts for audit trail

---

### 2. SessionContext Extension

**File**: `src/core/sessionContext.js` (MODIFIED)

#### WeakMap Storage

Uses WeakMaps to store capabilities externally, allowing attachment after `Object.freeze()`:

```javascript
const capabilitiesMap = new WeakMap();
const capabilitiesAttachedMap = new WeakMap();
```

**Why WeakMaps**:
- Allows attachment after SessionContext is frozen
- No memory leaks (entries garbage collected with object)
- Cannot be enumerated or accessed without object reference

#### Capability Attachment

```javascript
attachCapabilities(capabilities)
```

**Invariants**:
1. Session must be bound before attaching capabilities
2. Capabilities can be attached exactly once (prevents re-attachment)
3. Attachment logged to audit trail

#### Capability Access

```javascript
get capabilities()  // Returns CapabilitySet or null
get hasCapabilities // Returns boolean
```

**Security**: Throws error if accessed before attachment (fail-closed)

---

### 3. Authorization Enforcement

**File**: `src/core/toolRegistry.js` (MODIFIED)

#### Tool Execution

```javascript
async executeTool(toolName, args, sessionContext)
```

**Enforcement Order**:
1. Validate SessionContext is valid (WeakSet check)
2. **Authorization check** (NEW)
3. Input validation
4. Tool execution

**Authorization Decision Logging**:
```javascript
auditLogger.logAuthorization({
  action: CapabilityAction.TOOL_INVOKE,
  target: toolName,
  authorized: result.authorized,
  reason: result.reason,
  identity: sessionContext.identity,
  tenant: sessionContext.tenant,
  capSetId: sessionContext.capabilities?.capSetId,
});
```

#### Tool Listing

```javascript
listTools(sessionContext)
```

**Filtering**: Only returns tools the session is authorized to invoke  
- If no capabilities → returns empty list (default deny)
- If wildcard grant (`*`) → returns all tools
- Otherwise → returns only explicitly granted tools

---

### 4. Server Initialization

**File**: `src/core/server.js` (MODIFIED)

#### Capability Loading Flow

```javascript
// After Block 1 binding
const capabilities = loadCapabilitiesFromEnv();

// Attach to session context (one-time)
sessionContext.attachCapabilities(capabilities);
```

**Fail-Closed Behavior**: Any error loading or attaching capabilities terminates session

---

## Environment Variable Format

### MCP_CAPABILITIES

JSON format matching CapabilitySet constructor:

```json
{
  "capSetId": "session-abc123",
  "issuedAt": 1234567890000,
  "expiresAt": 1234571490000,
  "issuer": "control-plane",
  "grants": [
    { "action": "tool.invoke", "target": "query_read" },
    { "action": "tool.invoke", "target": "list_tables" },
    { "action": "tool.list", "target": "*" }
  ]
}
```

**Fields**:
- `capSetId`: Unique identifier (required)
- `issuedAt`: Unix timestamp in milliseconds (required)
- `expiresAt`: Unix timestamp in milliseconds (required, must be future)
- `issuer`: String identifier (required)
- `grants`: Array of capability grants (required)
  - `action`: One of CapabilityAction enum values (required)
  - `target`: Tool name or `*` for wildcard (required)

---

## Test Coverage

**File**: `test-block-2.js` (NEW, 10 tests)

| # | Test | Status |
|---|------|--------|
| 1 | CapabilitySet creation and validation | ✅ PASS |
| 2 | Fail-closed on missing required fields | ✅ PASS |
| 3 | Capability expiration check | ✅ PASS |
| 4 | Default deny when no matching grant | ✅ PASS |
| 5 | Successful authorization with valid grant | ✅ PASS |
| 6 | Unknown action denied (closed enum) | ✅ PASS |
| 7 | No capabilities results in deny | ✅ PASS |
| 8 | SessionContext capability attachment | ✅ PASS |
| 9 | Load capabilities from environment | ✅ PASS |
| 10 | Malformed capabilities fail closed | ✅ PASS |

**Run Tests**:
```bash
AUDIT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa node test-block-2.js
```

---

## Security Guarantees

### Block 1 Preservation

✅ Identity/tenant binding remains immutable  
✅ No modifications to Block 1 security invariants  
✅ Capabilities cannot alter identity or tenant  

### Authorization Guarantees

✅ Default deny enforced (no capability = no access)  
✅ Closed enum prevents unknown actions  
✅ Expiration enforced at construction and evaluation  
✅ Wildcard grants require explicit `*` target  
✅ Authorization logged for audit trail  

### Fail-Closed Behavior

✅ Missing capabilities → deny  
✅ Expired capabilities → deny  
✅ Unknown action → deny  
✅ Malformed capability JSON → session termination  
✅ Capability attachment errors → session termination  

### Defense-in-Depth

✅ Registry: Primary authorization enforcement  
✅ Tools: WeakSet validation of SessionContext  
✅ Adapters: WeakSet validation of SessionContext  
✅ Audit logging at all enforcement points  

---

## Integration Examples

### Example 1: Minimal Tool Access

```bash
export MCP_CAPABILITIES='{
  "capSetId": "minimal-access",
  "issuedAt": 1234567890000,
  "expiresAt": 1234571490000,
  "issuer": "control-plane",
  "grants": [
    { "action": "tool.invoke", "target": "list_tables" }
  ]
}'

# Session can ONLY invoke list_tables
# - query_read: DENIED
# - describe_table: DENIED
# - tool.list: DENIED (not granted)
```

### Example 2: Full Tool Access with Listing

```bash
export MCP_CAPABILITIES='{
  "capSetId": "full-access",
  "issuedAt": 1234567890000,
  "expiresAt": 1234571490000,
  "issuer": "control-plane",
  "grants": [
    { "action": "tool.invoke", "target": "*" },
    { "action": "tool.list", "target": "*" }
  ]
}'

# Session can invoke all tools and list available tools
```

### Example 3: Read-Only Query Access

```bash
export MCP_CAPABILITIES='{
  "capSetId": "read-only",
  "issuedAt": 1234567890000,
  "expiresAt": 1234571490000,
  "issuer": "control-plane",
  "grants": [
    { "action": "tool.invoke", "target": "query_read" },
    { "action": "tool.invoke", "target": "list_tables" },
    { "action": "tool.invoke", "target": "describe_table" }
  ]
}'

# Session can read data but not modify
# - Future write tools would be DENIED
```

---

## Audit Log Integration

Authorization decisions are logged with:
- **identity**: User identity from Block 1
- **tenant**: Tenant from Block 1
- **action**: Capability action attempted
- **target**: Tool or resource name
- **authorized**: Boolean result
- **reason**: AuthzReason enum value
- **capSetId**: Capability set identifier (if present)

**Example Log Entry**:
```json
{
  "level": 30,
  "time": 1234567890000,
  "identity": "user@example.com",
  "tenant": "tenant-123",
  "action": "tool.invoke",
  "target": "query_read",
  "authorized": true,
  "reason": "GRANTED",
  "capSetId": "session-abc123",
  "msg": "Authorization: Granted"
}
```

---

## Migration Notes

### Existing Deployments

1. **No Breaking Changes**: Block 1 behavior unchanged
2. **Backward Compatible**: Sessions without MCP_CAPABILITIES will have null capabilities
3. **Default Deny**: Without capabilities, all tool invocations will be denied
4. **Required Action**: Add MCP_CAPABILITIES to environment to restore access

### Deployment Checklist

- [ ] Generate capability set for each session
- [ ] Set MCP_CAPABILITIES environment variable
- [ ] Verify capability expiration times are appropriate
- [ ] Monitor audit logs for authorization denials
- [ ] Test with minimal capabilities first (principle of least privilege)

---

## Future Enhancements

### Planned for Block 3+

- **Resource-Level Authorization**: `resource.read` / `resource.write` enforcement
- **Dynamic Capability Refresh**: Token-based renewal without session restart
- **Multi-Issuer Support**: Trust multiple capability issuers
- **Fine-Grained Query Constraints**: Row-level security based on capabilities
- **Capability Delegation**: Time-limited sub-capabilities

### Not Planned

- ❌ Runtime capability modification (violates immutability)
- ❌ Client-supplied capabilities (violates trust boundary)
- ❌ Dynamic action creation (violates closed enum)

---

## Dependencies

**No new dependencies added**. All implementations use Node.js built-ins:
- `crypto` (existing, for session IDs)
- `WeakMap` / `WeakSet` (native)
- `Object.freeze()` / `Object.defineProperty()` (native)

---

## Related Documentation

- [Block 1 Implementation](./BLOCK-1-IMPLEMENTATION.md)
- [Audit Logging](./AUDIT-LOGGING-README.md)
- [Quick Reference](./QUICKREF.md)

---

**END OF DOCUMENT**
