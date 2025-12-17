# Week 1 Implementation Plan — MCP Core (Community Edition)

## Goals
- Deliver a minimal MCP core prototype using PostgreSQL.
- Implement two secure introspection tools: `list_tables` and `describe_table`.
- Enforce baseline security: allowlist ACLs, parameterized queries, query guards, result caps, and audit logging.
- Validate end-to-end MCP flow using the official MCP SDK.
- Provide clear manual testing instructions and a usable quickstart guide.

## Deliverables
- PostgreSQL adapter with connection pooling and health check.
- MCP server core implemented using the official MCP SDK and stdio transport.
- Tools: `list_tables` and `describe_table` with input schema validation.
- Security modules: allowlist enforcement and basic query guard utilities.
- Config loader using `.env` with schema validation and defaults.
- Minimal logging utility with audit metadata.
- Manual testing instructions and usage documentation.

## Dependencies (Community)
- Runtime: Node.js LTS (ESM)
- MCP SDK: `@modelcontextprotocol/sdk`
- Packages: `pg`, `dotenv`, `zod`, `pino`
- Dev: `eslint`, `prettier`, `nodemon`

## Repo Structure (initial)
- `src/`
	- `core/`
		- `server.js`
		- `toolRegistry.js`
		- `responseFormatter.js`
	- `adapters/`
		- `baseAdapter.js`
		- `postgres.js`
		- `adapterRegistry.js`
	- `security/`
		- `allowlist.js`
		- `queryGuard.js`
	- `tools/`
		- `listTables.js`
		- `describeTable.js`
	- `config/`
		- `env.js`
		- `schema.js`
	- `utils/`
		- `logger.js`
		- `pgPool.js`
- `tests/`
	- `manual/`
		- `connect-postgres.md`
		- `run-tools.md`
- `docs/`
	- `getting-started.md`
- `.env.example`
- `README.md`

## Implementation Order
1. Configuration and logging scaffolding
2. PostgreSQL pool utility and health check
3. Basic security primitives (allowlist and query guard)
4. MCP server hello-world using official SDK
5. Adapter layer (base adapter and PostgreSQL adapter)
6. Real MCP tools implementation
7. Response formatting and consistent error handling
8. Manual testing, documentation, and smoke tests

## Contracts and Interfaces (concise)
- **BaseAdapter**
	- `connect()`, `disconnect()`, `health()`
	- `listTables(schema?)`
	- `describeTable({ schema, table })`
	- Returns normalized, adapter-agnostic results.
- **Tool Registry**
	- Registers tools via MCP SDK
	- Validates inputs using `zod`
	- Enforces allowlist and query guard rules
	- Routes execution to adapters
	- Returns standardized responses
- **Allowlist**
	- Configuration-driven allowed schemas and tables
	- `isSchemaAllowed(schema)`, `isTableAllowed(schema, table)`
- **Query Guard**
	- Blocks dangerous patterns (DROP, ALTER, `;`)
	- Enforces parameterized queries only
	- Enforces result caps
- **Response Formatter**
	- `success({ data, meta })`
	- `error({ code, message, details })`

## Security Rules (Week 1 Scope)
- Read-only mode by default; tools perform introspection only.
- No dynamic SQL.
- Parameterized queries everywhere.
- Explicit schema and table allowlists.
- Enforced limits:
	- `MAX_TABLES = 100`
	- `MAX_COLUMNS = 200`
- Audit logging includes tool name, adapter, sanitized input, duration, and outcome.

## Config
- `.env` keys:
	- `PG_HOST`
	- `PG_PORT`
	- `PG_USER`
	- `PG_PASSWORD`
	- `PG_DATABASE`
	- `PG_SSL`
	- `ALLOWLIST_SCHEMAS`
	- `ALLOWLIST_TABLES`
	- `READ_ONLY`
	- `LOG_LEVEL`
- `env.js` parses and validates configuration using `zod` and applies defaults.
- Application fails fast on invalid configuration.

## Day-by-Day Breakdown
- **Day 0 (optional pre-work):**
	- Read official MCP documentation.
	- Clone and run an official MCP server example.
	- Goal: understand stdio and JSON-RPC flow.
- **Day 1:**
	- Initialize `src/` scaffolding and dependencies.
	- Implement `env.js`, `schema.js`, `logger.js`.
	- Add `.env.example`.
	- Update README quickstart.
- **Day 2:**
	- Implement `pgPool.js` with health check and graceful shutdown.
	- Implement `allowlist.js` with simple string-based rules.
	- Implement `queryGuard.js` blocking DROP, ALTER, and semicolons.
- **Day 3:**
	- Install and integrate `@modelcontextprotocol/sdk`.
	- Implement core server using stdio transport.
	- Register a dummy ping tool.
	- Validate server using MCP Inspector.
- **Day 4:**
	- Implement `baseAdapter.js`.
	- Implement `postgres.js` with `listTables` and `describeTable`.
	- Implement `adapterRegistry.js` and adapter selection via config.
	- Wire adapter into MCP server.
- **Day 5:**
	- Implement `listTables` tool with input schema validation.
	- Implement `describeTable` tool with input schema validation.
	- Implement `responseFormatter.js`.
	- Register real tools in tool registry.
	- Enforce result caps and logging.
- **Day 6:**
	- Manual testing using MCP Inspector.
	- End-to-end smoke testing.
	- Validate security rules and logging output.
	- Finalize `getting-started.md` and `README`.

## Testing Strategy
- Unit-level testing for allowlist and query guard logic.
- Manual MCP testing via MCP Inspector.
- Validate:
	- Tool registration
	- Allowlist enforcement
	- Query blocking
	- Result limits
	- Error formatting
	- Audit logs

## Quickstart
1. Copy `.env.example` to `.env` and set PostgreSQL credentials.
2. Install dependencies using `npm install`.
3. Run the server using `npm run dev`.
4. Use MCP Inspector to invoke `list_tables` and `describe_table`.

## Future Week Considerations (Out of Scope)
- Additional adapters (MySQL, MSSQL).
- Query execution tools.
- HTTP or WebSocket transport.
- Advanced permissions and multi-tenant support.
- Enterprise plugin hooks.
