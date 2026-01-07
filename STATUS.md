
# Project Status

## Current State

**Status**: Experimental — Security baseline frozen (Week 1–4)

**Security Posture**: Fail-closed enforcement verified by executable tests

**Operational Readiness**: Requires operator review for production deployment

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
  - Quota engine with token bucket algorithm ([`src/security/quotas.js`](src/security/quotas.js))
  - Audit logging (tool invocations, authorization decisions, query fingerprints)

### Reference Tools (Read-Only)

- **`list_tables`**: Lists tables in allowed schemas
- **`describe_table`**: Returns detailed schema information
- **`query_read`**: Executes SELECT queries with validation and result limiting

All reference tools enforce read-only constraints via boundary-level checks, SQL validation, and DB-session enforcement.

### Write Capability

**The core library CAN execute database writes** if write-capable tools are implemented and registered.

**Write safety is NOT a global guarantee.** Write safety is a property of specific tool implementations.

See [`examples/mysql-write-controlled/`](examples/mysql-write-controlled/) for a reference implementation with defense-in-depth controls.

---

## Security Baseline (Frozen)

The security baseline is defined in [`BASELINE-WEEK1-4.md`](BASELINE-WEEK1-4.md) and verified by tests in [`tests/security/`](tests/security/).

**Frozen Invariants (Test-Verified)**:

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

**All baseline tests must pass** for the system to be considered compliant with its security contract.

See [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md) for the complete security model.

---

## Implementation Metrics

- **Core Modules**: 15+ JavaScript files (ESM)
- **Security Tests**: 5 frozen invariants (100% passing)
- **Database Adapters**: 2 (PostgreSQL, MySQL)
- **Reference Tools**: 3 (read-only introspection and query execution)
- **Dependencies**: Minimal (MCP SDK, pg, mysql2, zod, pino)

---

## Validation

**Run security tests**:

```bash
npm test
```

**Run server**:

```bash
npm run dev
```

Connect via MCP Inspector using stdio transport.

**Verify baseline**:

All tests in [`tests/security/`](tests/security/) must pass. Baseline is invalidated if any test fails.

---

## Explicit Non-Goals

The following are **intentionally out of scope**:

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
3. Verify all security tests pass (`npm test`)
4. Configure database credentials with least-privilege access
5. Implement monitoring and audit log retention
6. Define incident response procedures
7. If implementing write-capable tools, follow [`examples/mysql-write-controlled/README.md`](examples/mysql-write-controlled/README.md)

**Operator Responsibilities**:

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
- [`SECURITY-CHANGE-CHECKLIST.md`](SECURITY-CHANGE-CHECKLIST.md) — Security review checklist

### Examples

- `examples/postgres-introspection/` — Read-only PostgreSQL introspection
- [`examples/mysql-write-controlled/`](examples/mysql-write-controlled/) — Write-enabled tool with defense-in-depth

### Manual Testing

- [`tests/manual/week-02-query_read.md`](tests/manual/week-02-query_read.md) — Query tool testing guide

---

## Support

**Security vulnerabilities**: Report via GitHub Security Advisories or contact maintainers privately

**General questions**: Open a public GitHub issue (without vulnerability details)

---

## License

Apache-2.0. See [`LICENSE`](LICENSE).

---

**Last Updated**: January 2026  
**Baseline Status**: Frozen (Week 1–4)  
**Test Suite Status**: All security invariant tests passing
