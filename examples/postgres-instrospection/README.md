# PostgreSQL Introspection (Read-Only) — Minimal Example

## 1) What this example demonstrates

This example demonstrates how to run **BytePro MCP Core** as a **read-only MCP runtime** that exposes **only** two introspection tools to MCP clients:

- `list_tables` — list tables within explicitly allowlisted schemas
- `describe_table` — return schema details for an allowlisted table

All tool invocations are mediated by the runtime’s control-plane enforcement (authorization/guards/limits as configured), and the example is intentionally restricted to **introspection-only** behavior.

---

## 2) Minimal setup steps

1. Ensure you have:
   - Node.js installed
   - Access to a PostgreSQL instance you are allowed to query (read-only access recommended)

2. From the repository root, install dependencies:

   - `npm install`

3. Create an environment file for this example:

   - `cp .env.example .env`

---

## 3) Required environment variables

Set the following in `examples/postgres-introspection/.env` (or provide them via your shell environment):

### PostgreSQL connection
- `PG_HOST` (e.g., `localhost`)
- `PG_PORT` (e.g., `5432`)
- `PG_USER`
- `PG_PASSWORD`
- `PG_DATABASE`

### Read-only enforcement
- `READ_ONLY=true`

### Explicit allowlists (required)
- `ALLOWLIST_SCHEMAS` (comma-separated, e.g., `public`)
- (If supported by your configuration) any table-level allowlist must be set explicitly; do not rely on permissive defaults.

### Minimal logging
- `LOG_LEVEL=info`

> Note: This example intentionally does not document optional/advanced settings. Use the repository’s root documentation for broader configuration reference.

---

## 4) How to run the example

From the repository root:

1. Ensure your environment variables are set (or your `.env` file is present in this example directory).
2. Start the MCP server runtime:

   - `npm run dev`

3. Connect with an MCP client using **stdio** transport (for example, MCP Inspector), then invoke:

- `list_tables`
- `describe_table`

This example is limited to these two introspection tools. No other MCP tools are registered in this example.

---

## 5) Security notes (intentional restrictions)

This example is intentionally constrained to reduce risk:

- **Read-only mode is required** (`READ_ONLY=true`).
- **Only introspection tools are in scope**:
  - No query execution tool is exposed.
  - No write or mutation operations are supported by this example.
- **Allowlists are mandatory**:
  - Only explicitly allowlisted schemas (and, where applicable, tables) are accessible.
  - No implicit “access everything” posture is intended.
- **No advanced configuration**:
  - No additional transports, adapter types, or enterprise-only features are used.
  - No extension hooks or custom tool registration is included.
- **No write queries**:
  - If your database credentials permit writes, you should replace them with a dedicated **read-only** database role for this example.

If you need broader capabilities, treat them as a separate design and security review exercise rather than modifying this minimal example in place.