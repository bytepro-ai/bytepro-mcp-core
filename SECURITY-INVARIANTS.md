# SECURITY-INVARIANTS.md

This document defines the **non-negotiable security contracts** for BytePro MCP Core.  
These invariants are **behavioral guarantees**, not intentions, and are validated by
explicit security tests. If any invariant is violated in production behavior,
the system must be considered **insecure**.

These invariants must remain valid across:
- refactors
- adapter changes
- performance optimizations
- feature evolution
- dependency upgrades

If any invariant cannot be upheld, the change **must not ship** without an explicit,
documented security exception and review.

---

## Threat model (baseline assumption)

BytePro MCP Core operates under a **hostile-environment assumption**:

- Callers are untrusted (including compromised clients).
- Tools are untrusted (buggy, malicious, or externally supplied).
- Adapters and dependencies are untrusted.
- Configuration may be missing, partial, or incorrect.
- Partial outages and unexpected failures are normal.
- **Fail-closed behavior is always preferred over availability.**

---

## 1) What a security invariant means

A security invariant is a property that **must hold for all executions**, including:

- invalid inputs
- missing or malformed context
- adapter failures or timeouts
- misconfiguration
- malicious tool logic
- concurrency and retry behavior
- version skew between components

Invariants are evaluated **only by observable behavior**.  
If the behavior can occur in production, it is in scope.

---

## 2) Core invariants (must ALWAYS hold)

### A. Fail-closed by default

- Any uncertainty in authorization, tenant attribution, quotas, or policy evaluation
  **must result in denial**.
- Security-relevant failures must never degrade into “best-effort allow”.

---

### B. Explicit trust boundaries

- All caller-supplied data (identity, tenant, capabilities, inputs) is untrusted.
- All tool execution is untrusted computation.
- The system must never assume tool correctness or safety.

---

### C. Tenant and scope isolation

- Every request is evaluated strictly within its declared tenant and scope.
- Isolation must be enforced consistently across adapters and deployments.
- Cross-tenant influence (state, quota, or execution) is forbidden.

---

### D. Deterministic, policy-driven decisions

- Authorization outcomes must be derived from explicit policy and validated context.
- No security decision may rely on:
  - implicit defaults
  - missing fields
  - permissive fallbacks
  - ambiguous parsing

---

### E. Least privilege (control-plane enforcement)

- Only the minimal access required for an authorized tool invocation is permitted.
- Missing, empty, or wildcard-like fields must never expand permissions.

---

### F. Safe error handling

- Errors must not leak sensitive data (cross-tenant info, policy internals, secrets).
- Error paths must not create side effects that violate isolation or quotas.

---

### G. Resource governance integrity

- Quota, rate, and concurrency enforcement must hold under:
  - concurrency
  - retries
  - partial failures
- Reservation and release semantics must not leak capacity.

---

### H. Auditability (control-plane events)

- Control-plane decisions (allow/deny) must be representable as audit events.
- **Audit logging must not weaken fail-closed behavior**.
- Audit events are permitted side effects **only after enforcement decisions**.

---

## 3) Hard prohibitions (must NEVER occur)

These are absolute constraints. If any can occur, the system is insecure.

---

### A. Unauthorized execution

- A tool must never execute if authorization is missing, invalid, indeterminate, or denied.

---

### B. Cross-tenant access

- A request must never:
  - read another tenant’s data
  - consume another tenant’s quotas
  - influence another tenant’s control-plane state

---

### C. Quota bypass

- A tool must never execute if quota checks cannot complete reliably.
- Adapter errors or missing data must not bypass limits.

---

### D. Silent allow

The system must never default to allow when:
- configuration is missing or invalid
- adapters are unavailable
- policy evaluation fails
- identity or tenant context is incomplete

---

### E. Unbounded amplification

- The control plane must not enable uncontrolled execution due to missing enforcement.

---

### F. Enforcement flow integrity

- The enforcement order must never be bypassed or reordered.
- No extension point may introduce an execution path that skips enforcement.

---

## 4) Canonical enforcement ordering

For **every tool invocation attempt**, the system must enforce:

1. **Context validation**
   - Validate presence and structure of security-relevant context.
   - If invalid or missing → deny.
   - **No adapter calls, no quota actions, no tool execution.**

2. **Authorization**
   - Evaluate permission to invoke the specific tool for the given tenant/scope.
   - If denied or indeterminate → deny.
   - **Tool must not execute.**

3. **Quota / limits**
   - Enforce rate, concurrency, and usage constraints.
   - If quota evaluation fails → deny.
   - **Tool must not execute.**

4. **Execution**
   - Tool execution may proceed **only after (1)–(3) succeed**.

If execution fails mid-flight, quota integrity must be preserved
(no leaked reservations, no retry-based bypass).

---

## 5) Zero side-effects guarantee

For the following conditions, the system must produce **zero observable side effects**:

- Missing or invalid SessionContext
- Unknown tool name
- Authorization denied
- Quota enforcement failure
- Read-only violation

“Zero side effects” means:
- No tool execution
- No adapter calls (DB, network, etc.)
- No quota reservation
- No mutation of control-plane state

Audit logging is permitted **only if it does not alter enforcement outcomes**.

---

## 6) Read-only enforcement precedence

When the system is operating in **read-only mode**:

- Any tool invocation that would perform a write **must be denied**.
- The denial reason must be **READ_ONLY**.
- Read-only enforcement must occur **before any write-capable execution**.
- Authorization success must not override read-only restrictions.

---

## 7) Unknown tool handling

- If a requested tool name is not registered:
  - The request must be denied with `TOOL_NOT_FOUND`.
  - No authorization, quota, adapter, or tool logic may run.
  - No side effects are permitted.

---

## 8) Canonical denial codes (internal contract)

The execution boundary must produce **structured, explicit denial reasons**:

- `SESSION_CONTEXT_INVALID`
- `TOOL_NOT_FOUND`
- `UNAUTHORIZED`
- `READ_ONLY`
- `ADAPTER_FAILURE`
- `DENIED` (catch-all if no more specific reason applies)

`ok: false` is the sole indicator of denial.

---

## 9) Execution boundary requirement

All tool invocations must pass through a **single, internal execution boundary**
that enforces:

- context validation
- authorization
- quota enforcement
- read-only restrictions
- non-execution on denial

No other code path may execute tools directly.

---

## 10) Verified by Tests

The following security invariants are **explicitly verified by executable tests**.
These tests assert observable behavior, including denial outcomes and the
absence of side effects.

The test suite **must pass in CI** for any change affecting:
- execution boundaries
- authorization
- quotas
- adapters

### Verified invariants

- **Fail-closed on missing or invalid SessionContext**  
  Test:  
  - `tests/security/invariant.session-context.fail-closed.test.js`

- **Authorization precedes execution**  
  Test:  
  - `tests/security/invariant.authorization-precedes-execution.test.js`

- **Unknown tools produce zero side effects**  
  Test:  
  - `tests/security/invariant.unknown-tool-zero-effects.test.js`

- **Read-only mode blocks writes before authorization or execution**  
  Test:  
  - `tests/security/invariant.read-only-blocks-writes.test.js`

If any of these tests fail, the system must be considered
**non-compliant with its security contract**, regardless of documentation or intent.

---

## 11) Changes that require security review

The following changes **must not be merged without explicit security review**:

- Authorization or policy logic
- Tenant/scope attribution
- Quota or concurrency enforcement
- Adapter behavior affecting enforcement
- Default configuration changes
- Request validation or parsing
- Audit behavior affecting enforcement flow
- Any change that could introduce side effects before authorization

Security review must verify that **no new path enables**:
- unauthorized execution
- quota bypass
- cross-tenant influence
- silent allow

---

## 12) Explicit non-goals

These invariants do **not** guarantee:

- Tool sandboxing or runtime isolation
- Tool correctness or safety
- Network-level security
- Secrets management
- Compliance certification
- Data exfiltration prevention

These concerns must be addressed by the surrounding infrastructure.

---

## Security posture summary

> This library does not make agents smarter.  
> It exists to make agent execution safer.
