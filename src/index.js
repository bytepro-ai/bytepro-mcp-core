/**
 * BytePro MCP Core - Public Library Entrypoint
 * 
 * This module exports the core library symbols for use in custom MCP servers.
 * It does NOT execute any runtime logic or perform initialization.
 * 
 * Usage:
 *   import { AdapterRegistry, executeToolBoundary, ToolRegistry } from 'bytepro-mcp-core';
 *   import { PostgresAdapter, MySQLAdapter, MSSQLAdapter } from 'bytepro-mcp-core';
 */

// Core execution boundary
export { executeToolBoundary } from './core/executeToolBoundary.js';

// Tool registry
export { ToolRegistry } from './core/toolRegistry.js';

// Adapter registry
export { AdapterRegistry } from './adapters/adapterRegistry.js';

// Database adapters (for custom server implementations)
export { PostgresAdapter } from './adapters/postgres.js';
export { MySQLAdapter } from './adapters/mysql.js';
export { MSSQLAdapter } from './adapters/mssql.js';
