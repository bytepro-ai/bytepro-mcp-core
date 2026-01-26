/**
 * BytePro MCP Core - Public Library Entrypoint
 * 
 * This module exports the core library symbols for use in custom MCP servers.
 * It does NOT execute any runtime logic or perform initialization.
 * 
 * Usage:
 *   import { AdapterRegistry, executeToolBoundary, ToolRegistry } from '@bytepro/mcp-core';
 *   import { PostgresAdapter, MySQLAdapter, MSSQLAdapter } from '@bytepro/mcp-core';
 *   import { SessionContext, CapabilitySet, CapabilityAction } from '@bytepro/mcp-core';
 */

// Core execution boundary
export { executeToolBoundary } from './core/executeToolBoundary.js';

// Tool registry
export { ToolRegistry } from './core/toolRegistry.js';

// Adapter registry
export { AdapterRegistry } from './adapters/adapterRegistry.js';

// Base adapter (for custom adapter implementations)
export { BaseAdapter } from './adapters/baseAdapter.js';

// Database adapters (for custom server implementations)
export { PostgresAdapter } from './adapters/postgres.js';
export { MySQLAdapter } from './adapters/mysql.js';
export { MSSQLAdapter } from './adapters/mssql.js';

// Session context (identity and tenant binding)
export { SessionContext, isValidSessionContext, createSessionContextFromEnv } from './core/sessionContext.js';

// Capability-based authorization
export { CapabilitySet, CapabilityAction, evaluateCapability, AuthzReason } from './security/capabilities.js';

// Quota management
export { 
  QuotaEngine, 
  QuotaPolicy,
  QuotaDimension,
  QuotaDenialReason,
  loadQuotaEngineFromEnv,
  createDefaultQuotaEngine
} from './security/quotas.js';

// Configuration utilities
export { loadConfig, getConfig } from './config/env.js';
export { configSchema, validateConfig } from './config/schema.js';

// Security primitives (for custom tool implementations)
export { allowlist } from './security/allowlist.js';
export { queryGuard } from './security/queryGuard.js';
export { validateQueryWithTables } from './security/queryValidator.js';
export { enforceQueryPermissions, PermissionError } from './security/permissions.js';
export { logQueryEvent, computeQueryFingerprint } from './security/auditLogger.js';

// Utilities
export { logger } from './utils/logger.js';
export { pgPool } from './utils/pgPool.js';

// Response formatting
export { success as formatSuccess, error as formatError, ErrorCodes, fromError } from './core/responseFormatter.js';
