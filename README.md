# BytePro MCP Core (Community Edition)

Security-first runtime for implementing, executing, and governing MCP tools.

BytePro MCP Core is a Node.js runtime for building secure MCP servers that expose existing systems (starting with PostgreSQL databases) to AI agents under strict security and governance controls.

It combines tool execution with an embedded control plane that enforces authorization, isolation, rate limits, and auditability before any tool logic runs.

This repository contains the Community Edition, focused on PostgreSQL introspection and read-only access.

---

## What this project is

A runtime for MCP tools.

Tools are registered with executable handlers.
Tool logic runs inside BytePro only after all security checks pass.

A security-first execution boundary.

Allowlist-based access control.
Query guards and read-only enforcement.
Rate and concurrency limits.
Full audit logging.

A foundation for building production-appropriate MCP servers.

Non-invasive to existing databases.
No schema changes or workflow rewrites.
Designed for legacy and regulated environments.

---

## What this project is not

This library intentionally does not aim to:

Be a general-purpose workflow engine or orchestration platform.
Provide sandboxing for arbitrary untrusted code.
Replace authentication, IAM, or identity systems.
Enable unrestricted or write-capable database access.
Abstract compliance or governance responsibility from operators.

The scope is deliberately limited to safe, auditable MCP tool execution.

---

## Features (Community Edition)

Security-first defaults.
Read-only mode by default.
Schema and table allowlists.
Query pattern blocking (DROP, ALTER, etc.).

Database introspection tools.
List tables.
Describe table schemas.

PostgreSQL adapter.
Connection pooling.
Parameterized queries.
Guarded execution.

Audit logging.
Complete audit trail of tool invocation decisions.

MCP SDK integration.
Built on the official Model Context Protocol SDK.

stdio transport.
Compatible with MCP Inspector and MCP clients.

---

## Quick Start

npm install  
cp .env.example .env  
npm run dev  

Edit the .env file with your PostgreSQL credentials.

---

## Configuration

Required environment variables:

PG_HOST=localhost  
PG_PORT=5432  
PG_USER=postgres  
PG_PASSWORD=your_password  
PG_DATABASE=your_database  

READ_ONLY=true  
ALLOWLIST_SCHEMAS=public  
LOG_LEVEL=info  

See .env.example for the full list.

---

## Available Tools

list_tables  
Lists tables in allowed schemas.

describe_table  
Returns detailed schema information for a table.

All tools execute under the same control-plane enforcement.

---

## Architecture Overview

src/
core/           MCP runtime and tool registry
adapters/       Database adapters (PostgreSQL)
security/       Authorization, guards, and limits
tools/          MCP tool implementations
config/         Configuration and validation
utils/          Logging and shared utilities

---

## Testing

Run the server:

npm run dev

Connect using MCP Inspector via stdio transport.

---

## Development Status

Week 1 Complete.

Project scaffolding and configuration.
PostgreSQL adapter with pooling.
Security primitives (allowlists, query guards).
MCP runtime with official SDK.
Introspection tools.
Manual testing documentation.

See IMPLEMENTATION-SUMMARY.md for details.

---

## Community vs Enterprise

Community Edition:

PostgreSQL adapter.
Read-only introspection tools.
Core security controls.
stdio transport.

Enterprise Edition:

Additional database adapters (MySQL, SQL Server).
Query execution tools.
Advanced permission models.
Additional transports (HTTP, WebSocket).

---

## Guiding Principle

This project does not try to make agents smarter.
It exists to make agent execution safer.

---

## License

Apache-2.0. See LICENSE.

---

## Contributing

This is an early-stage project.

Fork the repository.
Create a feature branch.
Follow existing code patterns.
Submit a pull request.