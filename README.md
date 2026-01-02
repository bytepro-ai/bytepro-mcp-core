# BytePro MCP Core

**Security-first library for building MCP servers with database adapters and tool execution boundaries.**

BytePro MCP Core is a Node.js (ESM) library for building MCP servers that expose database systems to AI agents under strict security and governance controls.

## Core library vs reference tools

**Core library** (this repository):
- A canonical execution boundary (`executeToolBoundary`) for tool invocation
- Database adapters (PostgreSQL and MySQL are implemented and wired)
- Security primitives (allowlists, query guards, authorization, quotas, audit logging)
- Tool and adapter registries

**Reference MCP tools** (shipped as examples):
- Strictly read-only introspection and query tools (`list_tables`, `describe_table`, `query_read`)
- Reference implementations demonstrating secure tool construction

**Developer responsibility:**
- The core library **can execute database writes** if you implement explicit write-capable tools
- Write safety is **not** a global guarantee of the core; it is a property of specific tools
- If you add mutation tools, you must implement and enforce write controls, authorization, and audit logging

---

## What the core library provides

**A canonical execution boundary:**
- All tool invocations pass through `executeToolBoundary(request)`
- Enforces security checks before execution and adapter calls
- Denials occur before side effects when possible (validation, tool lookup, read-only mode, authorization, quotas)

**Database adapters:**
- PostgreSQL adapter (implemented, wired, tested)
- MySQL adapter (implemented, wired, tested)
- Adapter registry for runtime selection

**Security primitives:**
- Allowlist-based access control (schemas, tables)
- Query guards and SQL validation
- Capability-based authorization
- Rate limits and concurrency quotas
- Audit logging (tool invocations, authorization decisions, query fingerprints)

**A foundation for building production-appropriate MCP servers:**
- Non-invasive to existing databases (no schema changes required)
- Designed for legacy and regulated environments
- ESM, Node.js runtime

---

## What the core library does NOT guarantee

- **Not globally read-only:** the core can execute database writes if developers implement explicit write-capable tools
- **Not a universal safety guarantee:** any write safety property is specific to how tools are implemented
- **Not a sandboxing environment:** tools and adapters are treated as untrusted code; enforcement is the responsibility of the execution boundary and tool implementation
- **Not a replacement for authentication/IAM:** identity and authentication are external to this library
- **Not a compliance solution:** operators are responsible for governance and compliance controls

---

## Reference MCP tools (verified behavior)

The reference tools shipped in this repository are **strictly read-only**, enforced by:
- Boundary-level denial when read-only mode is enabled
- SQL validation (SELECT-only, write keyword blocking)
- DB-session/transaction-level read-only enforcement

**Introspection tools:**
- `list_tables` — Lists tables in allowed schemas
- `describe_table` — Returns detailed schema information for a table

**Query tool:**
- `query_read` — Executes read-only SELECT queries (with validation, permission checks, and result limiting)

All reference tools execute under the same execution boundary enforcement (session context validation, tool lookup, authorization, quotas, audit logging).

**Developer-implemented tools:**
If you add tools that perform database mutations (INSERT/UPDATE/DELETE/DDL), you are responsible for implementing:
- Explicit authorization and capability checks for the specific write operation(s)
- Strict input validation and SQL construction controls
- Allowlist-based targeting (schemas/tables/operations) where applicable
- Audit logging sufficient for incident response
- Rate limiting and quotas appropriate for mutation operations
- Security invariants and tests demonstrating denial before side effects

---

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Edit the `.env` file with your database credentials (PostgreSQL or MySQL).

Connect using MCP Inspector or any MCP-compatible client via stdio transport.

---

## Configuration

Required environment variables for PostgreSQL:

```bash
PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=your_password
PG_DATABASE=your_database
```

Required environment variables for MySQL:

```bash
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=your_database
```

Security and operational settings:

```bash
READ_ONLY=true
ALLOWLIST_SCHEMAS=public
LOG_LEVEL=info
```

See `.env.example` for the full list.

---

## Available Tools

**`list_tables`**  
Lists tables in allowed schemas.

**`describe_table`**  
Returns detailed schema information for a table.

**`query_read`**  
Executes SELECT queries with validation, permission checks, and result limiting.

All tools execute under the same execution boundary enforcement.

---

## Architecture Overview

```
src/
├── core/           Execution boundary, tool registry, session context
├── adapters/       Database adapters (PostgreSQL, MySQL)
├── security/       Authorization, guards, permissions, quotas, audit logging
├── tools/          Reference MCP tool implementations (read-only)
├── config/         Configuration and validation
└── utils/          Logging and shared utilities
```

```
tests/
└── security/       Security invariant tests (fail-closed behavior, zero side effects)
```

---

## Testing

**Run the server:**

```bash
npm run dev
```

Connect using MCP Inspector via stdio transport.

**Run the test suite:**

```bash
npm test
```

Security invariant tests verify fail-closed behavior and zero side effects for invalid/unauthorized requests.

---

## Development Status

**Implemented and verified:**
- Project scaffolding and configuration
- PostgreSQL adapter with pooling and read-only transaction enforcement
- MySQL adapter with pooling and read-only session enforcement
- Security primitives (allowlists, query guards, SQL validation, authorization, quotas)
- Execution boundary with fail-closed enforcement
- Reference MCP tools (introspection and read-only query execution)
- Security invariant tests (session context, unknown tool, authorization ordering, read-only enforcement)
- Audit logging (authorization decisions, tool invocations, query fingerprints)

See [STATUS.md](STATUS.md) for detailed implementation status.

---

## Implemented Database Adapters

**PostgreSQL:**
- Connection pooling
- Parameterized queries
- Read-only transaction enforcement (`BEGIN READ ONLY`)
- Introspection (schemas, tables, columns)
- Query execution with validation and permission checks

**MySQL:**
- Connection pooling
- Parameterized queries
- Read-only session enforcement (`SET SESSION TRANSACTION READ ONLY`)
- Introspection (schemas, tables, columns)
- Query execution with validation and permission checks

Both adapters are wired into the runtime adapter registry and are production-ready for read-only workloads.

---

## Security Model

**Trust boundaries:**
- Tools are untrusted (can be authored by application developers)
- Adapters are untrusted (can be replaced or extended)

**Execution boundary:**
All tool invocations must pass through `executeToolBoundary(request)`, which enforces:
1. Session context validation (bound, branded, authentic)
2. Tool lookup (unknown tools are denied before any side effects)
3. Read-only mode enforcement (denies before authorization or execution)
4. Authorization (capability-based, fail-closed, default deny)
5. Quota enforcement (rate limits, concurrency limits)
6. Input validation (schema-based, fail-closed)
7. Execution (with audit logging)

**Defense in depth (reference tools):**
- Boundary-level read-only enforcement
- SQL validation (SELECT-only, write keyword blocking)
- DB-session/transaction-level read-only enforcement

**Developer responsibilities (write-capable tools):**
If you implement tools that perform database mutations, you must:
- Define and enforce authorization/capability checks for mutations
- Ensure denials occur before any execution or adapter side effects
- Add audit logging appropriate for mutation operations
- Add tests that prove security invariants for your tools

---

## Guiding Principle

**This project does not try to make agents smarter.**  
**It exists to make agent execution safer.**

The focus is on fail-closed enforcement, zero side effects for invalid requests, and defense in depth for the operations that are allowed.

---

## Contributing

This is an early-stage project.

1. Fork the repository
2. Create a feature branch
3. Follow existing code patterns and security-first design
4. Add tests for security invariants (fail-closed behavior, zero side effects)
5. Submit a pull request

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## License

Apache-2.0. See [LICENSE](LICENSE).