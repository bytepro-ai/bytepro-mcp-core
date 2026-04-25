# Initialization Order

BytePro MCP Core is a library. Consumers own process startup, `.env` loading, adapter connection, and shutdown registration.

## Required Initialization Order

1. Optionally call `loadEnv()` before reading configuration.
2. Read configuration with `loadConfig()`/`getConfig()` or provide explicit adapter configuration.
3. Create and bind a `SessionContext`, or call `createSessionContextFromEnv()` when launched by a trusted control plane.
4. Load and attach capabilities and quotas if used.
5. Create runtime objects lazily with factories such as `getQueryGuard()`, `getPgPool()`, or `getToolRegistry()`.
6. Initialize database adapters and the tool registry.
7. Optionally call `registerPgPoolShutdownHandlers()` from the application entrypoint.

Do not rely on import order for runtime setup. Imports should not start servers, connect to databases, load `.env`, or register process handlers.

## Minimal Usage

```js
import {
  createSessionContextFromEnv,
  getQueryGuard,
  getConfig,
  loadQuotaEngineFromEnv,
  loadEnv,
  ToolRegistry,
} from '@bytepro/mcp-core';
import { loadCapabilitiesFromEnv } from '@bytepro/mcp-core/capabilities';

loadEnv();
const config = getConfig();

const sessionContext = createSessionContextFromEnv();
const capabilities = loadCapabilitiesFromEnv();
if (capabilities) sessionContext.attachCapabilities(capabilities);
sessionContext.attachQuotaEngine(loadQuotaEngineFromEnv());

const queryGuard = getQueryGuard();
queryGuard.enforceQuery('SELECT 1');

const toolRegistry = new ToolRegistry();
await toolRegistry.initialize(server, sessionContext);
```

For PostgreSQL pool usage through the package subpath:

```js
import { getPgPool, registerPgPoolShutdownHandlers } from '@bytepro/mcp-core/pg-pool';

const pgPool = getPgPool();
pgPool.initialize();
registerPgPoolShutdownHandlers();
```

## Environment Variables

The following list is based on all `process.env` reads in `src/`.

| Variable | Used by | Default / required behavior |
| --- | --- | --- |
| `ALLOWLIST_SCHEMAS` | `createAllowlist()`, `loadConfig()` | Defaults to empty list. |
| `ALLOWLIST_TABLES` | `createAllowlist()`, `loadConfig()` | Defaults to empty list. |
| `APP_NAME` | `createLogger()`, `loadConfig()` | Logger default: `mcp-server`. Config schema default: `@bytepro/mcp-core`. |
| `APP_VERSION` | `createLogger()`, `loadConfig()` | Logger default: `1.0.0`. Config schema default: `0.1.0`. |
| `AUDIT_SECRET` | `computeQueryFingerprint()` | Required at runtime; must be at least 32 characters. |
| `DB_ADAPTER` | `loadConfig()` | Defaults to `postgres`. |
| `LOG_LEVEL` | `createLogger()`, `loadConfig()` | Defaults to `info`. |
| `LOG_PRETTY` | `createLogger()`, `loadConfig()` | Pretty logging enabled only when set to `true`; otherwise false. |
| `MAX_COLUMNS` | `getQueryGuard()`, `loadConfig()` | Defaults to `200`. |
| `MAX_TABLES` | `getQueryGuard()`, `loadConfig()` | Defaults to `100`. |
| `MCP_CAPABILITIES` | `loadCapabilitiesFromEnv()` | Missing value returns `null`; normal authorization remains default-deny without capabilities. |
| `MCP_QUOTA_POLICIES` | `loadQuotaEngineFromEnv()` | Required when `NODE_ENV=production`; otherwise defaults to an empty quota engine. |
| `MCP_SESSION_IDENTITY` | `createSessionContextFromEnv()` | Required; missing value fails closed. |
| `MCP_SESSION_TENANT` | `createSessionContextFromEnv()` | Required; missing value fails closed. |
| `MYSQL_DATABASE` | `loadConfig()` | Required by config validation for MySQL configuration. |
| `MYSQL_HOST` | `loadConfig()` | Required by config validation for MySQL configuration. |
| `MYSQL_MAX_CONNECTIONS` | `loadConfig()` | Defaults to `10`. |
| `MYSQL_PASSWORD` | `loadConfig()` | Required by config validation for MySQL configuration. |
| `MYSQL_PORT` | `loadConfig()` | Defaults to `3306`. |
| `MYSQL_SSL` | `loadConfig()` | Defaults to `false`. |
| `MYSQL_USER` | `loadConfig()` | Required by config validation for MySQL configuration. |
| `MSSQL_DATABASE` | `loadConfig()` | Required by config validation for MSSQL configuration. |
| `MSSQL_HOST` | `loadConfig()` | Required by config validation for MSSQL configuration. |
| `MSSQL_MAX_CONNECTIONS` | `loadConfig()` | Defaults to `10`. |
| `MSSQL_PASSWORD` | `loadConfig()` | Required by config validation for MSSQL configuration. |
| `MSSQL_PORT` | `loadConfig()` | Defaults to `1433`. |
| `MSSQL_SSL` | `loadConfig()` | Defaults to `false`. |
| `MSSQL_USER` | `loadConfig()` | Required by config validation for MSSQL configuration. |
| `NODE_ENV` | `loadQuotaEngineFromEnv()` | `production` makes missing quota policies fail closed. |
| `PG_CONNECTION_TIMEOUT_MS` | `getPgPool()`, `loadConfig()` | Direct pool default: `2000`; config schema default: `5000`. |
| `PG_DATABASE` | `getPgPool()`, `loadConfig()` | Required by config validation for PostgreSQL configuration. |
| `PG_HOST` | `getPgPool()`, `loadConfig()` | Required by config validation for PostgreSQL configuration. |
| `PG_IDLE_TIMEOUT_MS` | `getPgPool()`, `loadConfig()` | Direct pool default: `10000`; config schema default: `30000`. |
| `PG_MAX_CONNECTIONS` | `getPgPool()`, `loadConfig()` | Defaults to `10`. |
| `PG_PASSWORD` | `getPgPool()`, `loadConfig()` | Required by config validation for PostgreSQL configuration. |
| `PG_PORT` | `getPgPool()`, `loadConfig()` | Defaults to `5432`. |
| `PG_SSL` | `getPgPool()`, `loadConfig()` | Defaults to `false`; direct pool uses `{ rejectUnauthorized: false }` when set to `true`. |
| `PG_USER` | `getPgPool()`, `loadConfig()` | Required by config validation for PostgreSQL configuration. |
| `READ_ONLY` | `getQueryGuard()`, `loadConfig()` | Defaults to `true`; set to `true` to allow only `SELECT`/`WITH`. |
