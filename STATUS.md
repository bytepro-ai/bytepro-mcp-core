# Project Status

## Current State

**Status**: Experimental — security baseline frozen (Week 1–4)

**Authority model**:
- **Jest security tests are the single source of truth** for enforceable security behavior.
- Documentation describes intent and constraints, but **does not override executable evidence**.

**Workflow reality**:
- Development occurs **directly on `main`**.
- No PR-based workflow is assumed.
- No CI pipelines are assumed.
- **Local `npm test` is the only verification gate** before changes land on `main`.

---

## What Exists

### Core Library

- **Execution Boundary**: [`src/core/executeToolBoundary.js`](src/core/executeToolBoundary.js)
  - Session context validation (fail-closed)
  - Tool lookup (unknown tools denied before side effects)
  - Read-only mode enforcement
  - Authorization evaluation (capability-based, default deny)
  - Quota enforcement (rate limits, concurrency limits)

- **Database Adapters**:
  - PostgreSQL ([`src/adapters/postgres.js`](src/adapters/postgres.js))
  - MySQL ([`src/adapters/mysql.js`](src/adapters/mysql.js))
  - Adapter registry for runtime selection

- **Security Primitives**:
  - Allowlist-based access control (schemas, tables)
  - Query guards and SQL validation
  - Capability-based authorization ([`src/security/capabilities.js`](src/security/capabilities.js))
  - Quota engine ([`src/security/quotas.js`](src/security/quotas.js))
  - Audit logging (tool invocations, authorization decisions, query fingerprints)

### Reference Tools (Read-Only)

- **`list_tables`**: Lists tables in allowed schemas
- **`describe_table`**: Returns detailed schema information
- **`query_read`**: Executes SELECT queries with validation and result limiting

All reference tools enforce read-only constraints via boundary-level checks, SQL validation, and DB-session enforcement.

### Write Capability

**The core library CAN execute database writes** if write-capable tools are implemented and registered.

**Write safety is NOT a global guarantee.** Write safety is a property of specific tool implementations.

See [`examples/mysql-write-controlled/`](examples/mysql-write-controlled/) for a reference implementation with defense-in-depth controls and explicit operator responsibility.

---

## Security Baseline (Frozen)

The Week 1–4 frozen baseline is defined in [`BASELINE-WEEK1-4.md`](BASELINE-WEEK1-4.md) and verified by Jest tests in [`tests/security/`](tests/security/).

**Frozen invariants (test-verified)**:

1. **Fail-Closed on Missing/Invalid SessionContext**  
   Test: [`tests/security/invariant.session-context.fail-closed.test.js`](tests/security/invariant.session-context.fail-closed.test.js)

2. **Authorization Precedes Execution**  
   Test: [`tests/security/invariant.authorization-precedes-execution.test.js`](tests/security/invariant.authorization-precedes-execution.test.js)

3. **Unknown Tools Produce Zero Side Effects**  
   Test: [`tests/security/invariant.unknown-tool-zero-effects.test.js`](tests/security/invariant.unknown-tool-zero-effects.test.js)

4. **Read-Only Mode Blocks Writes Before Authorization**  
   Test: [`tests/security/invariant.read-only-blocks-writes.test.js`](tests/security/invariant.read-only-blocks-writes.test.js)

5. **Write Tool Controlled Execution**  
   Test: [`tests/security/invariant.write-tool-controlled.test.js`](tests/security/invariant.write-tool-controlled.test.js)

**Compliance rule**:
- If any frozen invariant test fails, the system must be considered **non-compliant with its security contract**, regardless of documentation or intent.

See [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md) for the full security contract and threat model.

---

## Dependency Security Audit (npm audit)

The project has been reviewed using `npm audit` for direct and transitive dependencies.

### Summary

- `npm audit` reports high-severity advisories in transitive dependencies
- Findings are assessed against the actual threat model (local stdio transport; no HTTP server)
- Risks are explicitly documented and accepted when not exploitable under current architecture

### Finding 1 — `@modelcontextprotocol/sdk`

- **Advisory**: GHSA-8r9q-7v3j-jr4g (ReDoS)
- **Severity**: High
- **Fix Available**: No upstream fix available
- **Dependency Type**: Direct dependency

**Assessment**:
- Affected paths relate to request parsing behavior.
- BytePro MCP Core operates exclusively over **local stdio transport**.
- There is **no HTTP server, no untrusted network input**, and no exposure to external request bodies.

**Decision**:
- Not exploitable under the current threat model.
- Risk accepted and monitored for upstream patches.

### Finding 2 — `qs` (transitive)

- **Advisory**: GHSA-6rw7-vpxm-498p
- **Severity**: High
- **Fix Available**: Yes (upstream)
- **Dependency Path**:
  - `@modelcontextprotocol/sdk → express → body-parser → qs`

**Assessment**:
- `qs` is used in HTTP request parsing contexts.
- BytePro MCP Core does **not expose an HTTP server**.
- No execution path parses untrusted HTTP request bodies.

**Decision**:
- Not exploitable in the current architecture.
- `npm audit fix` is intentionally not applied to avoid unreviewed dependency changes.
- Risk is accepted and documented.

### Audit Policy

- `npm audit fix` is not run automatically.
- Dependency changes require explicit review and **local** security invariant tests passing (`npm test`).
- This project favors determinism and test-verified behavior over automatic patching.

---

## Validation (Local, Enforceable)

**Run security tests (required gate before committing to `main`)**:

```bash
npm test
```

**Run server (for local exploration only; not a security gate)**:

```bash
npm run dev
```

Connect via MCP Inspector using stdio transport.

**Baseline verification rule**:
- The enforceable baseline is the Jest security test suite in [`tests/security/`](tests/security/).
- Manual guides under [`tests/manual/`](tests/manual/) may assist operator exploration, but are **not** an authority source for security correctness.

---

## Explicit Non-Goals

The following are intentionally out of scope:

- **Global read-only system**: Write-capable tools can be implemented
- **Tool sandboxing**: Tools execute in the same process
- **Authentication/IAM**: Identity and authentication are external
- **Compliance certification**: No HIPAA, SOC 2, PCI-DSS guarantees
- **Data exfiltration prevention**: Tools can read and return data

See [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md) and [`README.md`](README.md) for complete details.

---

## Deployment Guidance

**Before deploying to production**:

1. Review [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md)
2. Review [`BASELINE-WEEK1-4.md`](BASELINE-WEEK1-4.md)
3. Verify all security tests pass locally (`npm test`)
4. Configure database credentials with least-privilege access
5. Implement monitoring and audit log retention
6. Define incident response procedures
7. If implementing write-capable tools, follow [`examples/mysql-write-controlled/README.md`](examples/mysql-write-controlled/README.md)

**Operator responsibilities**:

- Credential isolation and rotation
- Authorization policy definition
- Quota configuration appropriate for risk tolerance
- Monitoring and alerting
- Compliance and data governance

---

## Documentation

### Core Documentation

- [`README.md`](README.md) — Project overview and quick start
- [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md) — Security contracts and threat model
- [`BASELINE-WEEK1-4.md`](BASELINE-WEEK1-4.md) — Frozen security baseline
- [`SECURITY.md`](SECURITY.md) — Vulnerability reporting and disclosure policy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contribution guidelines and security expectations
- [`SECURITY-CHANGE-CHECKLIST.md`](SECURITY-CHANGE-CHECKLIST.md) — Local security change gate for direct-to-main development

### Examples

- `examples/postgres-introspection/` — Read-only PostgreSQL introspection
- [`examples/mysql-write-controlled/`](examples/mysql-write-controlled/) — Write-enabled tool with defense-in-depth

### Manual Testing (Non-Authoritative)

- [`tests/manual/run-tools.md`](tests/manual/run-tools.md) — Running tools via Inspector or stdio
- [`tests/manual/week-02-query_read.md`](tests/manual/week-02-query_read.md) — `query_read` guided manual checks
- [`tests/manual/week-03-order_by.md`](tests/manual/week-03-order_by.md) — ORDER BY allowlist manual cases

Manual documents may help reproduce behaviors, but **do not define correctness**. Correctness is defined by **local Jest security tests**.

---

## Support

**Security vulnerabilities**: Report via GitHub Security Advisories or contact maintainers privately.

**General questions**: Open a public GitHub issue (without vulnerability details).

---

## License

Apache-2.0. See [`LICENSE`](LICENSE).

---

**Last Updated**: January 2026  
**Baseline Status**: Frozen (Week 1–4)  
**Authority**: Local Jest security tests (`npm test`)
