import { BaseAdapter } from './baseAdapter.js';
import { pgPool } from '../utils/pgPool.js';
import { allowlist } from '../security/allowlist.js';
import { queryGuard } from '../security/queryGuard.js';
import { logger } from '../utils/logger.js';
import { validateQueryWithTables } from '../security/queryValidator.js';
import { enforceQueryPermissions } from '../security/permissions.js';
import { logQueryEvent, computeQueryFingerprint } from '../security/auditLogger.js';
import { isValidSessionContext } from '../core/sessionContext.js';

/**
 * PostgreSQL adapter implementation
 * Provides database introspection for PostgreSQL
 */
export class PostgresAdapter extends BaseAdapter {
  constructor(config) {
    super('postgres', config);
    this.pool = null;
  }

  /**
   * Connect to PostgreSQL
   */
  async connect() {
    if (this.connected) {
      logger.warn('PostgreSQL adapter already connected');
      return;
    }

    try {
      this.pool = pgPool.initialize();
      const health = await pgPool.health();

      if (!health.healthy) {
        throw new Error(`PostgreSQL connection unhealthy: ${health.error || 'Unknown error'}`);
      }

      this.connected = true;
      logger.info('PostgreSQL adapter connected');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to connect PostgreSQL adapter');
      throw error;
    }
  }

  /**
   * Disconnect from PostgreSQL
   */
  async disconnect() {
    if (!this.connected) {
      return;
    }

    try {
      await pgPool.shutdown();
      this.connected = false;
      logger.info('PostgreSQL adapter disconnected');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to disconnect PostgreSQL adapter');
      throw error;
    }
  }

  /**
   * Health check
   */
  async health() {
    return await pgPool.health();
  }

  /**
   * List all tables in allowed schemas
   * @param {Object} [params] - Query parameters
   * @param {string} [params.schema] - Optional schema filter
   * @param {SessionContext} sessionContext - Bound session context (identity + tenant)
   * @returns {Promise<Array<{name: string, schema: string}>>}
   */
  async listTables(params = {}, sessionContext) {
    const startTime = Date.now();

    // SECURITY: Defensive assertion - session context MUST be bound
    // Adapters MUST NOT execute without bound identity + tenant
    if (!sessionContext || !sessionContext.isBound) {
      throw new Error('SECURITY VIOLATION: Adapter called without bound session context');
    }

    // SECURITY: Verify session context is genuine
    if (!isValidSessionContext(sessionContext)) {
      throw new Error('SECURITY VIOLATION: Invalid session context instance');
    }

    try {
      let { schema } = params;

      // Build query to list tables
      let query;
      let queryParams = [];

      if (schema) {
        // Validate schema is allowed
        allowlist.enforceSchema(schema);

        query = `
          SELECT 
            table_name as name,
            table_schema as schema
          FROM information_schema.tables
          WHERE table_schema = $1
            AND table_type = 'BASE TABLE'
          ORDER BY table_schema, table_name;
        `;
        queryParams = [schema];
      } else {
        // Get all tables from allowed schemas
        const allowedSchemas = allowlist.getConfig().allowedSchemas;

        if (allowedSchemas.length === 0) {
          return [];
        }

        query = `
          SELECT 
            table_name as name,
            table_schema as schema
          FROM information_schema.tables
          WHERE table_schema = ANY($1)
            AND table_type = 'BASE TABLE'
          ORDER BY table_schema, table_name;
        `;
        queryParams = [allowedSchemas];
      }

      // Execute query
      const result = await pgPool.query(query, queryParams);

      // Filter by allowlist and apply limits
      let tables = result.rows.filter((row) => allowlist.isTableAllowed(row.schema, row.name));

      tables = queryGuard.limitTables(tables);

      this.logOperation('listTables', params, startTime, tables);

      return tables;
    } catch (error) {
      this.logError('listTables', params, error);
      throw error;
    }
  }

  /**
   * Describe a table's schema
   * @param {Object} params - Query parameters
   * @param {string} params.schema - Schema name
   * @param {string} params.table - Table name
   * @param {SessionContext} sessionContext - Bound session context (identity + tenant)
   * @returns {Promise<Array<{name: string, type: string, nullable: boolean, default: any, isPrimaryKey: boolean}>>}
   */
  async describeTable(params, sessionContext) {
    const startTime = Date.now();

    // SECURITY: Defensive assertion - session context MUST be bound
    if (!sessionContext || !sessionContext.isBound) {
      throw new Error('SECURITY VIOLATION: Adapter called without bound session context');
    }

    // SECURITY: Verify session context is genuine
    if (!isValidSessionContext(sessionContext)) {
      throw new Error('SECURITY VIOLATION: Invalid session context instance');
    }

    try {
      const { schema, table } = params;

      if (!schema || !table) {
        throw new Error('Schema and table are required');
      }

      // Validate access
      allowlist.enforceTable(schema, table);

      // Query to get column information
      const columnQuery = `
        SELECT 
          c.column_name as name,
          c.data_type as type,
          c.is_nullable = 'YES' as nullable,
          c.column_default as default,
          CASE 
            WHEN pk.column_name IS NOT NULL THEN true 
            ELSE false 
          END as "isPrimaryKey"
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
            AND tc.table_schema = ku.table_schema
            AND tc.table_name = ku.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        ) pk ON c.column_name = pk.column_name
        WHERE c.table_schema = $1
          AND c.table_name = $2
        ORDER BY c.ordinal_position;
      `;

      const result = await pgPool.query(columnQuery, [schema, table]);

      if (result.rows.length === 0) {
        throw new Error(`Table "${schema}.${table}" not found or has no columns`);
      }

      // Apply column limit
      let columns = queryGuard.limitColumns(result.rows);

      this.logOperation('describeTable', params, startTime, columns);

      return columns;
    } catch (error) {
      this.logError('describeTable', params, error);
      throw error;
    }
  }

  /**
   * Execute a read-only SELECT query with security enforcement
   * @param {Object} params - Query parameters
   * @param {string} params.query - SQL query string
   * @param {Array} [params.params] - Query parameters
   * @param {number} [params.limit] - Maximum rows to return (default: 100, max: 1000)
   * @param {number} [params.timeout] - Query timeout in milliseconds (default: 30000, max: 60000)
   * @param {SessionContext} sessionContext - Bound session context (identity + tenant)
   * @returns {Promise<Object>} Query results with metadata
   */
  async executeQuery(params, sessionContext) {
    const startTime = Date.now();
    let validationPassed = false; // Track whether validation succeeded

    // SECURITY: Defensive assertion - session context MUST be bound
    // NO data-plane query execution without bound identity + tenant
    if (!sessionContext || !sessionContext.isBound) {
      throw new Error('SECURITY VIOLATION: Query execution attempted without bound session context');
    }

    // SECURITY: Verify session context is genuine
    if (!isValidSessionContext(sessionContext)) {
      throw new Error('SECURITY VIOLATION: Invalid session context instance');
    }

    try {
      const { query, params: queryParams = [], limit = 100, timeout = 30000 } = params;

      if (!query || typeof query !== 'string') {
        throw this._createError('INVALID_INPUT', 'Query must be a non-empty string');
      }

      // Compute fingerprint once (no raw SQL crosses audit boundary after this)
      const queryFingerprint = computeQueryFingerprint(query);

      // Step 1: Validate query structure (regex-based security validation)
      const validation = validateQueryWithTables(query);
      
      if (!validation.valid) {
        // Audit log: validation rejected (AFTER validation, fail-closed)
        logQueryEvent('postgres', queryFingerprint, 'rejected');
        throw this._createError('QUERY_REJECTED', validation.reason);
      }

      const tables = validation.tables;

      // Step 2: Enforce permissions (allowlist check)
      try {
        enforceQueryPermissions(query);
      } catch (permissionError) {
        // Audit log: permission rejected (AFTER permission check, fail-closed)
        logQueryEvent('postgres', queryFingerprint, 'rejected');
        throw permissionError;
      }

      // Audit log: validation succeeded (AFTER validation + permissions, fail-closed)
      logQueryEvent('postgres', queryFingerprint, 'validated');
      validationPassed = true; // Mark validation as complete

      // Step 3: Validate and normalize limits/timeouts
      const normalizedLimit = this._normalizeLimit(limit);
      const normalizedTimeout = this._normalizeTimeout(timeout);

      // Step 4: Execute via safe read method (READ ONLY transaction, enforced LIMIT, timeout)
      const result = await pgPool.executeSafeRead(query, queryParams, {
        maxLimit: normalizedLimit,
        timeout: normalizedTimeout,
      });

      const executionTime = Date.now() - startTime;

      // Audit log: execution succeeded (AFTER execution, fail-closed)
      logQueryEvent('postgres', queryFingerprint, 'success', executionTime);

      // Step 5: Log operation (no query text or params in logs)
      this.logOperation('executeQuery', { tableCount: tables.length, limit: normalizedLimit }, startTime, result);

      return {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
        executionTime: result.executionTime,
        truncated: result.truncated,
        appliedLimit: result.appliedLimit,
      };
    } catch (error) {
      // Map to standardized error codes
      const mappedError = this._mapExecutionError(error);
      
      // Audit log: execution failed (ONLY if validation passed)
      // This prevents duplicate logging of validation failures
      // Skip if error is AUDIT_FAILURE (to prevent recursion)
      if (validationPassed && mappedError.code !== 'AUDIT_FAILURE') {
        const queryFingerprint = computeQueryFingerprint(params.query);
        logQueryEvent('postgres', queryFingerprint, 'execution_error', Date.now() - startTime);
      }
      
      this.logError('executeQuery', { hasQuery: !!params.query }, mappedError);
      throw mappedError;
    }
  }

  /**
   * Normalize and validate limit parameter
   * @private
   */
  _normalizeLimit(limit) {
    const parsed = parseInt(limit, 10);
    if (isNaN(parsed) || parsed < 1) {
      return 100; // default
    }
    return Math.min(parsed, 1000); // max
  }

  /**
   * Normalize and validate timeout parameter
   * @private
   */
  _normalizeTimeout(timeout) {
    const parsed = parseInt(timeout, 10);
    if (isNaN(parsed) || parsed < 1000) {
      return 30000; // default 30s
    }
    return Math.min(parsed, 60000); // max 60s
  }

  /**
   * Map execution errors to standardized error codes
   * @private
   */
  _mapExecutionError(error) {
    // If error already has a code from security layers, preserve it
    if (error.code && ['QUERY_REJECTED', 'PERMISSION_DENIED', 'INVALID_INPUT', 'AUDIT_FAILURE'].includes(error.code)) {
      return error;
    }

    // Map database errors
    if (error.code === '57014') {
      return this._createError('TIMEOUT', 'Query execution timeout');
    }

    if (error.code && error.code.startsWith('42')) {
      return this._createError('SYNTAX_ERROR', 'SQL syntax error');
    }

    if (error.message && error.message.includes('does not exist')) {
      return this._createError('OBJECT_NOT_FOUND', 'Referenced table or column not found');
    }

    // Generic execution error
    return this._createError('EXECUTION_ERROR', 'Query execution failed');
  }

  /**
   * Create structured error object
   * @private
   */
  _createError(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    if (details) {
      error.details = details;
    }
    return error;
  }
}

export default PostgresAdapter;
