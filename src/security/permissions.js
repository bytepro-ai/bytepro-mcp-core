/**
 * Query Permissions Enforcement
 * 
 * Enforces table-level access control using allowlists.
 * Operates on pre-validated queries (queryValidator must run first).
 * Throws structured MCP errors on violations.
 */

import { allowlist } from './allowlist.js';
import { extractTables } from './queryValidator.js';
import { logger } from '../utils/logger.js';

/**
 * Permission error class for structured MCP error responses
 */
export class PermissionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Enforce table access permissions for a validated query
 * 
 * @param {string} query - Pre-validated SQL query (SELECT only)
 * @returns {{ tables: string[], schemas: string[] }} Validated table references
 * @throws {PermissionError} If any table is not in allowlist
 */
export function enforceQueryPermissions(query) {
  // Extract table references from the query
  // Note: extractTables returns ["schema.table", ...] format
  const tables = extractTables(query);

  // Fail-closed: If no tables extracted, this should have been caught by validator
  // but we double-check here for defense in depth
  if (tables.length === 0) {
    logger.error({ query: query.substring(0, 100) }, 'No tables extracted from query (should not reach permissions layer)');
    throw new PermissionError(
      'INVALID_QUERY',
      'Query must reference at least one table',
      { hint: 'This indicates a validation bypass - report to administrators' }
    );
  }

  // Track which schemas and tables we've validated
  const validatedSchemas = new Set();
  const validatedTables = [];

  // Check each table against allowlist
  for (const fullTableName of tables) {
    // Parse schema.table format
    // Format is always "schema.table" from extractTables
    const [schema, table] = fullTableName.split('.');

    // Paranoid validation: ensure parse succeeded
    if (!schema || !table) {
      logger.error({ fullTableName }, 'Failed to parse table name (unexpected format)');
      throw new PermissionError(
        'INVALID_QUERY',
        'Invalid table reference format',
        { table: fullTableName, hint: 'Table name must be in schema.table format' }
      );
    }

    // Check schema allowlist first
    if (!allowlist.isSchemaAllowed(schema)) {
      logger.warn({ schema, table, allowedSchemas: Array.from(allowlist.allowedSchemas) }, 'Schema not in allowlist');
      throw new PermissionError(
        'UNAUTHORIZED_TABLE',
        `Access denied: Schema "${schema}" is not allowed`,
        { 
          schema,
          table: fullTableName,
          hint: 'Contact administrator to request schema access'
        }
      );
    }

    // Check table allowlist
    if (!allowlist.isTableAllowed(schema, table)) {
      logger.warn({ schema, table, allowedTables: Array.from(allowlist.allowedTables) }, 'Table not in allowlist');
      throw new PermissionError(
        'UNAUTHORIZED_TABLE',
        `Access denied: Table "${fullTableName}" is not allowed`,
        { 
          schema,
          table: fullTableName,
          hint: 'Contact administrator to request table access'
        }
      );
    }

    // Track validated references
    validatedSchemas.add(schema);
    validatedTables.push(fullTableName);
  }

  // Log successful validation
  logger.debug(
    { 
      tables: validatedTables,
      schemas: Array.from(validatedSchemas)
    }, 
    'Query permissions validated'
  );

  // Return validated references for adapter usage
  return {
    tables: validatedTables,
    schemas: Array.from(validatedSchemas)
  };
}

/**
 * Check if a specific table is accessible (convenience function)
 * 
 * @param {string} schema - Schema name
 * @param {string} table - Table name
 * @returns {boolean} True if table is accessible
 */
export function isTableAccessible(schema, table) {
  return allowlist.isSchemaAllowed(schema) && allowlist.isTableAllowed(schema, table);
}

/**
 * Get list of all accessible tables (for introspection tools)
 * 
 * @returns {{ schemas: string[], tables: string[] }} Accessible resources
 */
export function getAccessibleResources() {
  const config = allowlist.getConfig();
  
  return {
    schemas: config.allowedSchemas,
    tables: config.allowedTables,
    allowAllTables: config.allowAllTables
  };
}
