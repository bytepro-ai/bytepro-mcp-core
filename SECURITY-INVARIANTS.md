# Security Invariants

This document defines the **non-negotiable security contracts** for BytePro MCP Core.

These invariants are **behavioral guarantees**, not intentions. They are validated by explicit security tests. If any invariant is violated in production behavior, the system must be considered **insecure**.

These invariants must remain valid across:
- Refactors
- Adapter changes
- Performance optimizations
- Feature evolution
- Dependency upgrades

If any invariant cannot be upheld, the change **must not be committed** without an explicit, documented security exception and verification.

---

## Threat Model

BytePro MCP Core operates under a **hostile-environment assumption**:

- **Callers are untrusted** (including compromised clients)
- **Tools are untrusted** (buggy, malicious, or externally supplied)
- **Adapters are untrusted** (can fail, timeout, or behave incorrectly)
- **Configuration may be missing, partial, or incorrect**
- **Partial outages and unexpected failures are normal**
- **Fail-closed behavior is always preferred over availability**

---

## What a Security Invariant Means

A security invariant is a property that **must hold for all executions**, including:

- Invalid inputs
- Missing or malformed context
- Adapter failures or timeouts
- Misconfiguration
- Malicious tool logic
- Concurrency and retry behavior
- Version skew between components

Invariants are evaluated **only by observable behavior**. If the behavior can occur in production, it is in scope.

---

## Core Invariants (MUST ALWAYS HOLD)

### 1. Fail-Closed by Default

Any uncertainty in authorization, tenant attribution, quotas, or policy evaluation **must result in denial**.

Security-relevant failures must never degrade into "best-effort allow".

### 2. Explicit Trust Boundaries

- All caller-supplied data (identity, tenant, capabilities, inputs) is untrusted
- All tool execution is untrusted computation
- The system must never assume tool correctness or safety

### 3. Tenant and Scope Isolation

- Every request is evaluated strictly within its declared tenant and scope
- Isolation must be enforced consistently across adapters and deployments
- Cross-tenant influence (state, quota, or execution) is forbidden

### 4. Deterministic, Policy-Driven Decisions

Authorization outcomes must be derived from explicit policy and validated context.

No security decision may rely on:
- Implicit defaults
- Missing fields
- Permissive fallbacks
- Ambiguous parsing

### 5. Least Privilege

- Only the minimal access required for an authorized tool invocation is permitted
- Missing, empty, or wildcard-like fields must never expand permissions

### 6. Safe Error Handling

- Errors must not leak sensitive data (cross-tenant info, policy internals, secrets)
- Error paths must not create side effects that violate isolation or quotas

### 7. Resource Governance Integrity

Quota, rate, and concurrency enforcement must hold under:
- Concurrency
- Retries
- Partial failures

Reservation and release semantics must not leak capacity.

### 8. Auditability

- Control-plane decisions (allow/deny) must be representable as audit events
- **Audit logging must not weaken fail-closed behavior**
- Audit events are permitted side effects **only after enforcement decisions**

---

## Hard Prohibitions (MUST NEVER OCCUR)

These are absolute constraints. If any can occur, the system is insecure.

### A. Unauthorized Execution

A tool must never execute if authorization is missing, invalid, indeterminate, or denied.

### B. Cross-Tenant Access

A request must never:
- Read another tenant's data
- Consume another tenant's quotas
- Influence another tenant's control-plane state

### C. Quota Bypass

- A tool must never execute if quota checks cannot complete reliably
- Adapter errors or missing data must not bypass limits

### D. Silent Allow

The system must never default to allow when:
- Configuration is missing or invalid
- Adapters are unavailable
- Policy evaluation fails
- Identity or tenant context is incomplete

### E. Unbounded Amplification

The control plane must not enable uncontrolled execution due to missing enforcement.

### F. Enforcement Flow Integrity

- The enforcement order must never be bypassed or reordered
- No extension point may introduce an execution path that skips enforcement

---

## Canonical Execution Boundary

All tool invocations must pass through a **single, internal execution boundary** (`executeToolBoundary`) that enforces:

1. **Session Context Validation**
   - Validate presence and structure of security-relevant context
   - If invalid or missing → deny
   - **No adapter calls, no quota actions, no tool execution**

2. **Tool Lookup**
   - Verify the tool exists in the registry
   - If unknown → deny with `TOOL_NOT_FOUND`
   - **No authorization, no quota, no execution**

3. **Read-Only Mode Check**
   - If `mode.readOnly === true` and tool is write-capable → deny with `READ_ONLY`
   - **No authorization, no execution**

4. **Authorization**
   - Evaluate permission to invoke the specific tool for the given tenant/scope
   - If denied or indeterminate → deny with `UNAUTHORIZED`
   - **Tool must not execute**

5. **Quota / Limits**
   - Enforce rate, concurrency, and usage constraints
   - If quota evaluation fails → deny with `RATE_LIMITED`
   - **Tool must not execute**

6. **Execution**
   - Tool execution may proceed **only after (1)–(5) succeed**

If execution fails mid-flight, quota integrity must be preserved (no leaked reservations, no retry-based bypass).

**No other code path may execute tools directly.** Bypassing this boundary is a security violation.

---

## Frozen Invariants (Verified by Tests)

The following security invariants are **explicitly verified by executable tests**. These tests assert observable behavior, including denial outcomes and the absence of side effects.

The test suite **must pass locally** (via `npm test`) for any change affecting:
- Execution boundaries
- Authorization
- Quotas
- Adapters

**Jest security tests are the single source of truth** for enforceable security behavior. Documentation describes intent, but **does not override executable evidence**.

### Test-Verified Invariants

#### 1. Fail-Closed on Missing or Invalid SessionContext

**Invariant**: Missing or invalid session context prevents all tool execution and produces zero side effects.

**Test**: `tests/security/invariant.session-context.fail-closed.test.js`

**Observable Behavior**:
- Denial with `SESSION_CONTEXT_INVALID`
- Zero tool execution
- Zero adapter calls (auth, db, policy, quota)
- Zero database operations

#### 2. Authorization Precedes Execution

**Invariant**: Authorization denial prevents tool execution and prevents adapter usage.

**Test**: `tests/security/invariant.authorization-precedes-execution.test.js`

**Observable Behavior**:
- Denial with `UNAUTHORIZED` or `AUTHORIZATION_DENIED`
- Zero tool handler invocation
- Zero database operations
- Authorization check occurs before any execution path

#### 3. Unknown Tools Produce Zero Side Effects

**Invariant**: Unknown or unregistered tool names are denied without any side effects.

**Test**: `tests/security/invariant.unknown-tool-zero-effects.test.js`

**Observable Behavior**:
- Denial with `TOOL_NOT_FOUND`
- Zero authorization checks
- Zero adapter calls
- Zero quota reservation
- Tool lookup failure prevents all downstream operations

#### 4. Read-Only Mode Blocks Writes Before Authorization

**Invariant**: Read-only mode blocks write operations before authorization checks or tool execution.

**Test**: `tests/security/invariant.read-only-blocks-writes.test.js`

**Observable Behavior**:
- Denial with `READ_ONLY`
- Zero tool execution
- Zero adapter calls (auth, db, policy, quota)
- Read-only check precedes authorization evaluation

---

## Conceptual Invariants (Design Intent)

The following invariants represent design intent and architectural principles. They are not currently verified by dedicated security tests but inform the system's security model.

### Zero Side-Effects Guarantee

For the following conditions, the system must produce **zero observable side effects**:

- Missing or invalid SessionContext
- Unknown tool name
- Authorization denied
- Quota enforcement failure
- Read-only violation

"Zero side effects" means:
- No tool execution
- No adapter calls (DB, network, etc.)
- No quota reservation
- No mutation of control-plane state

Audit logging is permitted **only if it does not alter enforcement outcomes**.

### Canonical Denial Codes

The execution boundary must produce **structured, explicit denial reasons**:

- `SESSION_CONTEXT_INVALID`
- `TOOL_NOT_FOUND`
- `READ_ONLY`
- `UNAUTHORIZED`
- `RATE_LIMITED`
- `ADAPTER_FAILURE`
- `DENIED` (catch-all if no more specific reason applies)

`ok: false` is the sole indicator of denial.

---

## Write Operations and Read-Only Enforcement

**The core library CAN execute database writes** if write-capable tools are implemented and registered.

**Write safety is NOT a global guarantee of the core library.** Write safety is a property of specific tool implementations.

### Read-Only Mode Enforcement

- When `mode.readOnly === true`, the execution boundary denies write-capable tools with `READ_ONLY`
- This denial occurs **before authorization checks** and **before tool execution**
- Authorization success does not override read-only restrictions
- Read-only enforcement is boundary-level, not tool-level

### Write-Capable Tools

If you implement tools that perform database mutations (INSERT/UPDATE/DELETE/DDL), you must:

1. Define explicit authorization/capability requirements for write operations
2. Implement strict input validation and SQL construction controls
3. Use allowlist-based targeting (schemas/tables/operations) where applicable
4. Add audit logging sufficient for incident response
5. Implement rate limiting and quotas appropriate for mutation operations
6. Document operator responsibilities (credentials, monitoring, incident response)

**Reference tools** (`list_tables`, `describe_table`, `query_read`) are strictly read-only and demonstrate secure tool construction patterns.

---

## Changes Requiring Security Review

The following changes **require strict adherence to the [Security Change Checklist](SECURITY-CHANGE-CHECKLIST.md)** (including local invariant verification) before committing to `main`:

- Authorization or policy logic
- Tenant/scope attribution
- Quota or concurrency enforcement
- Adapter behavior affecting enforcement
- Default configuration changes
- Request validation or parsing
- Audit behavior affecting enforcement flow
- Any change that could introduce side effects before authorization
- Modifications to `executeToolBoundary` control flow or check ordering

Pre-commit verification must confirm that **no new path enables**:
- Unauthorized execution
- Quota bypass
- Cross-tenant influence
- Silent allow

See [`SECURITY-CHANGE-CHECKLIST.md`](SECURITY-CHANGE-CHECKLIST.md) for the verification process.

---

## Explicit Non-Goals

These invariants do **not** guarantee:

- **Tool sandboxing or runtime isolation** — Tools execute in the same process
- **Tool correctness or safety** — Tools are untrusted computation
- **Network-level security** — Transport security is external
- **Secrets management** — Credential storage and rotation are external
- **Compliance certification** — No HIPAA, SOC 2, PCI-DSS, or similar guarantees
- **Data exfiltration prevention** — Tools can read and return data
- **Global read-only system** — Write-capable tools can be implemented

These concerns must be addressed by the surrounding infrastructure and operational controls.

---

## Security Posture Summary

> This library does not make agents smarter.
> 
> It exists to make agent execution safer.

The focus is on fail-closed enforcement, zero side effects for invalid requests, and defense in depth for the operations that are allowed.

---

## Documentation References

- [`BASELINE-WEEK1-4.md`](BASELINE-WEEK1-4.md) — Frozen baseline declaration
- [`SECURITY-CHANGE-CHECKLIST.md`](SECURITY-CHANGE-CHECKLIST.md) — Security review checklist
- [`SECURITY.md`](SECURITY.md) — Vulnerability reporting and disclosure policy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contribution guidelines and security expectations

---

**Last Updated**: January 2026

**Test Suite Status**: All security invariant tests passing

If any frozen invariant test fails, the system must be considered **non-compliant with its security contract**, regardless of documentation or intent.