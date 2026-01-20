import { logger } from '../utils/logger.js';

/**
 * Allowlist enforcement for database access control
 * Validates schema and table access against configured allowlists
 */
export class Allowlist {
  constructor() {
    const allowlistSchemas = (process.env.ALLOWLIST_SCHEMAS || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    const allowlistTables = (process.env.ALLOWLIST_TABLES || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    this.allowedSchemas = new Set(allowlistSchemas);
    this.allowedTables = new Set(allowlistTables);
    this.allowAllTables = this.allowedTables.size === 0; // Empty list means allow all tables

    logger.info(
      {
        allowedSchemas: Array.from(this.allowedSchemas),
        allowedTables: Array.from(this.allowedTables),
        allowAllTables: this.allowAllTables,
      },
      'Allowlist initialized'
    );
  }

  /**
   * Check if a schema is allowed
   * @param {string} schema - Schema name to check
   * @returns {boolean} True if allowed
   */
  isSchemaAllowed(schema) {
    if (!schema) {
      logger.warn('Schema name is empty or undefined');
      return false;
    }

    // If no schemas are explicitly allowed, deny all
    if (this.allowedSchemas.size === 0) {
      logger.warn({ schema }, 'No schemas in allowlist - access denied');
      return false;
    }

    const allowed = this.allowedSchemas.has(schema);

    if (!allowed) {
      logger.warn({ schema, allowedSchemas: Array.from(this.allowedSchemas) }, 'Schema not in allowlist');
    }

    return allowed;
  }

  /**
   * Check if a table is allowed
   * @param {string} schema - Schema name
   * @param {string} table - Table name to check
   * @returns {boolean} True if allowed
   */
  isTableAllowed(schema, table) {
    // First check schema
    if (!this.isSchemaAllowed(schema)) {
      return false;
    }

    if (!table) {
      logger.warn('Table name is empty or undefined');
      return false;
    }

    // If allowlist is empty, allow all tables in allowed schemas
    if (this.allowAllTables) {
      return true;
    }

    // Check both "table" and "schema.table" formats
    const tableName = table;
    const qualifiedTableName = `${schema}.${table}`;

    const allowed = this.allowedTables.has(tableName) || this.allowedTables.has(qualifiedTableName);

    if (!allowed) {
      logger.warn(
        {
          schema,
          table,
          allowedTables: Array.from(this.allowedTables),
        },
        'Table not in allowlist'
      );
    }

    return allowed;
  }

  /**
   * Validate and enforce access for a schema
   * @param {string} schema - Schema name
   * @throws {Error} If schema is not allowed
   */
  enforceSchema(schema) {
    if (!this.isSchemaAllowed(schema)) {
      throw new Error(`Access denied: Schema "${schema}" is not in the allowlist`);
    }
  }

  /**
   * Validate and enforce access for a table
   * @param {string} schema - Schema name
   * @param {string} table - Table name
   * @throws {Error} If table is not allowed
   */
  enforceTable(schema, table) {
    if (!this.isTableAllowed(schema, table)) {
      throw new Error(`Access denied: Table "${schema}.${table}" is not in the allowlist`);
    }
  }

  /**
   * Filter a list of schemas to only include allowed ones
   * @param {Array<string>} schemas - List of schema names
   * @returns {Array<string>} Filtered list of allowed schemas
   */
  filterSchemas(schemas) {
    return schemas.filter((schema) => this.isSchemaAllowed(schema));
  }

  /**
   * Filter a list of tables to only include allowed ones
   * @param {string} schema - Schema name
   * @param {Array<string>} tables - List of table names
   * @returns {Array<string>} Filtered list of allowed tables
   */
  filterTables(schema, tables) {
    if (!this.isSchemaAllowed(schema)) {
      return [];
    }

    if (this.allowAllTables) {
      return tables;
    }

    return tables.filter((table) => this.isTableAllowed(schema, table));
  }

  /**
   * Get the configured allowlists for debugging
   * @returns {Object} Allowlist configuration
   */
  getConfig() {
    return {
      allowedSchemas: Array.from(this.allowedSchemas),
      allowedTables: Array.from(this.allowedTables),
      allowAllTables: this.allowAllTables,
    };
  }
}

// Export singleton instance
export const allowlist = new Allowlist();

export default allowlist;
