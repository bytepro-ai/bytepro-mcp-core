import { BaseAdapter } from './baseAdapter.js';
import { logger } from '../utils/logger.js';
import { isValidSessionContext } from '../core/sessionContext.js';
import { allowlist } from '../security/allowlist.js';
import { queryGuard } from '../security/queryGuard.js';
import { validateQueryWithTables } from '../security/queryValidator.js';
import { enforceQueryPermissions } from '../security/permissions.js';
import { logQueryEvent, computeQueryFingerprint } from '../security/auditLogger.js';

export class MSSQLAdapter extends BaseAdapter {
  constructor(config) {
    super('mssql', config);
  }

  async connect() {
    if (this.connected) {
      logger.warn('MSSQL adapter already connected');
      return;
    }

    try {
      if (!this.mssql) {
        let imported;
        try {
          imported = await import('mssql');
        } catch (error) {
          throw new Error('mssql package not installed. Install with: npm install mssql');
        }

        this.mssql = imported.default || imported;
      }

      this.pool = new this.mssql.ConnectionPool(this.config);
      await this.pool.connect();

      this.connected = true;
      logger.info('MSSQL adapter connected');
    } catch (error) {
      if (this.pool) {
        try {
          await this.pool.close();
        } catch (cleanupError) {
          logger.warn({ error: cleanupError.message }, 'MSSQL adapter pool cleanup failed');
        }
      }

      this.pool = null;
      this.connected = false;

      logger.error({ error: error.message }, 'Failed to connect MSSQL adapter');
      throw error;
    }
  }

  async disconnect() {
    if (!this.connected && !this.pool) {
      return;
    }

    try {
      if (this.pool) {
        await this.pool.close();
      }

      this.pool = null;
      this.connected = false;
      logger.info('MSSQL adapter disconnected');
    } catch (error) {
      this.pool = null;
      this.connected = false;

      logger.error({ error: error.message }, 'Failed to disconnect MSSQL adapter');
      throw error;
    }
  }

  async health() {
    const startTime = Date.now();

    if (!this.connected || !this.pool) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: 'Adapter not connected',
      };
    }

    try {
      await this.pool.request().query('SELECT 1');
      const latency = Date.now() - startTime;

      logger.debug({ latency }, 'MSSQL health check passed');

      return {
        healthy: true,
        latency,
      };
    } catch (error) {
      const latency = Date.now() - startTime;

      logger.error({ error: error.message, latency }, 'MSSQL health check failed');

      return {
        healthy: false,
        latency,
        error: error.message,
      };
    }
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
      const request = this.pool.request();

      if (schema) {
        // Validate schema is allowed
        allowlist.enforceSchema(schema);

        query = `
          SELECT 
            TABLE_NAME AS name,
            TABLE_SCHEMA AS schema
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = @schema
            AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_SCHEMA, TABLE_NAME;
        `;
        request.input('schema', this.mssql.VarChar, schema);
      } else {
        // Get all tables from allowed schemas
        const allowedSchemas = allowlist.getConfig().allowedSchemas;

        if (allowedSchemas.length === 0) {
          return [];
        }

        // Build IN clause with individual parameters
        const schemaParams = allowedSchemas.map((s, i) => {
          request.input(`schema${i}`, this.mssql.VarChar, s);
          return `@schema${i}`;
        }).join(',');

        query = `
          SELECT 
            TABLE_NAME AS name,
            TABLE_SCHEMA AS schema
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA IN (${schemaParams})
            AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_SCHEMA, TABLE_NAME;
        `;
      }

      // Execute query
      const result = await request.query(query);

      // Filter by allowlist and apply limits
      let tables = result.recordset.filter((row) => allowlist.isTableAllowed(row.schema, row.name));

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

      // Query to get column information with primary key detection
      const columnQuery = `
        SELECT 
          c.COLUMN_NAME AS name,
          c.DATA_TYPE AS type,
          CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS nullable,
          c.COLUMN_DEFAULT AS [default],
          CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT ku.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
            ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
            AND tc.TABLE_NAME = ku.TABLE_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            AND tc.TABLE_SCHEMA = @schema
            AND tc.TABLE_NAME = @table
        ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
        WHERE c.TABLE_SCHEMA = @schema
          AND c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION;
      `;

      const request = this.pool.request();
      request.input('schema', this.mssql.VarChar, schema);
      request.input('table', this.mssql.VarChar, table);

      const result = await request.query(columnQuery);

      if (result.recordset.length === 0) {
        throw new Error(`Table "${schema}.${table}" not found or has no columns`);
      }

      // Apply column limit
      let columns = queryGuard.limitColumns(result.recordset);

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
        logQueryEvent('mssql', queryFingerprint, 'rejected');
        throw this._createError('QUERY_REJECTED', validation.reason);
      }

      const tables = validation.tables;

      // Step 2: Enforce permissions (allowlist check)
      try {
        enforceQueryPermissions(query);
      } catch (permissionError) {
        // Audit log: permission rejected (AFTER permission check, fail-closed)
        logQueryEvent('mssql', queryFingerprint, 'rejected');
        throw permissionError;
      }

      // Audit log: validation succeeded (AFTER validation + permissions, fail-closed)
      logQueryEvent('mssql', queryFingerprint, 'validated');
      validationPassed = true; // Mark validation as complete

      // Step 3: Validate and normalize limits/timeouts
      const normalizedLimit = this._normalizeLimit(limit);
      const normalizedTimeout = this._normalizeTimeout(timeout);

      // Step 4: Execute via safe read method (SNAPSHOT transaction, enforced TOP, timeout)
      const result = await this._executeSafeRead(query, queryParams, {
        maxLimit: normalizedLimit,
        timeout: normalizedTimeout,
      });

      const executionTime = Date.now() - startTime;

      // Audit log: execution succeeded (AFTER execution, fail-closed)
      logQueryEvent('mssql', queryFingerprint, 'success', executionTime);

      // Step 5: Log operation (no query text or params in logs)
      this.logOperation('executeQuery', { tableCount: tables.length, limit: normalizedLimit }, startTime, result);

      return {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields.map((f) => ({ name: f.name, type: f.type })),
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
        logQueryEvent('mssql', queryFingerprint, 'execution_error', Date.now() - startTime);
      }
      
      this.logError('executeQuery', { hasQuery: !!params.query }, mappedError);
      throw mappedError;
    }
  }

  /**
   * Execute a read-only query with safety enforcements
   * 
   * Enforces:
   * - SET TRANSACTION ISOLATION LEVEL SNAPSHOT (closest to READ ONLY)
   * - Query timeout at request level
   * - Server-side TOP enforcement (never trust client)
   * - Max rows enforcement (post-execution truncation)
   * 
   * MSSQL READ-ONLY IMPLEMENTATION NOTE:
   * MSSQL does not support true READ ONLY transactions like PostgreSQL.
   * This implementation uses SNAPSHOT isolation level + transaction rollback
   * as defense-in-depth. SNAPSHOT provides read-consistent views but does not
   * prevent write operations at the database level. The SQL validation layer
   * (validateQueryWithTables) blocks all non-SELECT queries before execution,
   * and the rollback ensures no writes are committed. This approach relies on
   * multiple layers of defense rather than database-level read-only enforcement.
   * 
   * @private
   * @param {string} query - SQL SELECT query
   * @param {Array} params - Query parameters
   * @param {Object} options - Execution options
   * @param {number} options.timeout - Query timeout in milliseconds
   * @param {number} options.maxLimit - Maximum rows to return
   * @returns {Promise<{rows, fields, rowCount, executionTime, truncated, appliedLimit}>}
   */
  async _executeSafeRead(query, params = [], options = {}) {
    const { timeout = 10000, maxLimit = 100 } = options;
    
    // Enforce server-side max limit (never trust client)
    const enforcedLimit = Math.min(Math.max(1, maxLimit), 1000);
    
    // Inject TOP if missing, clamp if present
    const limitedQuery = this._enforceLimitClause(query, enforcedLimit);
    
    const transaction = this.pool.transaction();
    const startTime = Date.now();
    
    try {
      // Begin transaction with SNAPSHOT isolation (closest to READ ONLY in MSSQL)
      // SNAPSHOT prevents dirty reads, non-repeatable reads, and phantom reads
      await transaction.begin(this.mssql.ISOLATION_LEVEL.SNAPSHOT);
      
      // Create request within transaction
      const request = transaction.request();
      request.timeout = timeout;
      
      // Bind parameters
      if (params && Array.isArray(params)) {
        params.forEach((param, index) => {
          request.input(`param${index}`, param);
        });
      }
      
      // Execute the query
      const result = await request.query(limitedQuery);
      
      // Rollback transaction (no commit needed for reads)
      await transaction.rollback();
      
      const executionTime = Date.now() - startTime;
      
      // Post-execution truncation (defense in depth)
      let truncated = false;
      let rows = result.recordset || [];
      
      if (rows.length > enforcedLimit) {
        rows = rows.slice(0, enforcedLimit);
        truncated = true;
        logger.warn(
          { returnedRows: result.recordset.length, enforcedLimit },
          'Query returned more rows than limit, truncated'
        );
      }
      
      logger.debug(
        { executionTime, rowCount: rows.length, truncated, appliedLimit: enforcedLimit },
        'Safe read query executed'
      );
      
      return {
        rows,
        fields: result.recordset.columns || [],
        rowCount: rows.length,
        executionTime,
        truncated,
        appliedLimit: enforcedLimit,
      };
    } catch (error) {
      // Ensure transaction rollback on error
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        logger.error({ error: rollbackError.message }, 'Transaction rollback failed');
      }
      
      throw error;
    }
  }

  /**
   * Enforce TOP clause on a query
   * - If query has no TOP: inject TOP after SELECT
   * - If query has TOP: clamp to server max
   * 
   * @private
   * @param {string} query - SQL query
   * @param {number} maxLimit - Server-enforced maximum TOP
   * @returns {string} Query with enforced TOP
   */
  _enforceLimitClause(query, maxLimit) {
    // Check if query already has TOP clause
    const topRegex = /^SELECT\s+(?:DISTINCT\s+)?TOP\s+\(?(\d+)\)?/i;
    const topMatch = query.match(topRegex);
    
    if (topMatch) {
      // Query has TOP - clamp to server max
      const existingLimit = parseInt(topMatch[1], 10);
      
      if (!Number.isFinite(existingLimit) || existingLimit <= 0) {
        throw new Error('Invalid TOP clause value');
      }
      
      const clampedLimit = Math.min(existingLimit, maxLimit);
      
      // Replace existing TOP with clamped value
      return query.replace(/^SELECT\s+(DISTINCT\s+)?TOP\s+\(?\d+\)?/i, (_, distinctPart) => {
        const distinctSegment = distinctPart ? 'DISTINCT ' : '';
        return `SELECT ${distinctSegment}TOP ${clampedLimit}`;
      });
    } else {
      // Query has no TOP - inject after SELECT
      if (/^SELECT\s+DISTINCT\s+/i.test(query)) {
        return query.replace(/^SELECT\s+DISTINCT\s+/i, `SELECT DISTINCT TOP ${maxLimit} `);
      } else {
        return query.replace(/^SELECT\s+/i, `SELECT TOP ${maxLimit} `);
      }
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
    if (error.code && ['QUERY_REJECTED', 'PERMISSION_DENIED', 'UNAUTHORIZED_TABLE', 'INVALID_INPUT', 'AUDIT_FAILURE'].includes(error.code)) {
      return error;
    }
    
    // Map MSSQL error codes
    // Timeout (Request timeout or execution timeout)
    if (error.name === 'RequestError' && error.message.includes('timeout')) {
      return this._createError('TIMEOUT', 'Query execution timeout');
    }
    
    // Syntax errors (class 15, 16)
    if (error.number >= 102 && error.number <= 105) {
      return this._createError('SYNTAX_ERROR', 'SQL syntax error');
    }
    
    // Object not found (208: Invalid object name, 207: Invalid column name)
    if (error.number === 208 || error.number === 207) {
      return this._createError('OBJECT_NOT_FOUND', 'Referenced table or column not found');
    }
    
    // Permission denied (229: SELECT permission denied)
    if (error.number === 229) {
      return this._createError('PERMISSION_DENIED', 'Access denied to requested object');
    }
    
    // Generic execution error
    return this._createError('EXECUTION_ERROR', `Query execution failed: ${error.message}`);
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

export default MSSQLAdapter;
