import { BaseAdapter } from './baseAdapter.js';
import { allowlist } from '../security/allowlist.js';
import { queryGuard } from '../security/queryGuard.js';
import { logger } from '../utils/logger.js';
import { validateQueryWithTables } from '../security/queryValidator.js';
import { enforceQueryPermissions } from '../security/permissions.js';
import { logQueryEvent, computeQueryFingerprint } from '../security/auditLogger.js';

/**
 * MySQL/MariaDB adapter implementation
 * Provides database introspection for MySQL/MariaDB
 * 
 * SECURITY CONSTRAINTS:
 * - Read-only SELECT queries only
 * - Mandatory schema qualification (db.table)
 * - Server-side LIMIT enforcement
 * - Explicit rejection: OFFSET, multi-statements, comments, implicit joins
 */
export class MySQLAdapter extends BaseAdapter {
  constructor(config) {
    super('mysql', config);
    this.pool = null;
    this.mysql2 = null;
  }

  /**
   * Connect to MySQL/MariaDB
   */
  async connect() {
    if (this.connected) {
      logger.warn('MySQL adapter already connected');
      return;
    }

    try {
      // Lazy load mysql2 - fail if not available
      try {
        this.mysql2 = await import('mysql2/promise');
      } catch (error) {
        throw new Error(
          'mysql2 package not installed. Install with: npm install mysql2'
        );
      }

      // Initialize connection pool
      this.pool = this.mysql2.createPool({
        host: this.config.host || 'localhost',
        port: this.config.port || 3306,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        waitForConnections: true,
        connectionLimit: this.config.maxConnections || 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        // Security: disable multi-statement at driver level
        multipleStatements: false,
      });

      // Test connection
      const health = await this.health();

      if (!health.healthy) {
        throw new Error(
          `MySQL connection unhealthy: ${health.error || 'Unknown error'}`
        );
      }

      this.connected = true;
      logger.info('MySQL adapter connected');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to connect MySQL adapter');
      throw error;
    }
  }

  /**
   * Disconnect from MySQL/MariaDB
   */
  async disconnect() {
    if (!this.connected) {
      return;
    }

    try {
      if (this.pool) {
        await this.pool.end();
        this.pool = null;
      }
      this.connected = false;
      logger.info('MySQL adapter disconnected');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to disconnect MySQL adapter');
      throw error;
    }
  }

  /**
   * Health check
   */
  async health() {
    const startTime = Date.now();

    try {
      if (!this.pool) {
        return {
          healthy: false,
          latency: 0,
          error: 'Pool not initialized',
        };
      }

      const connection = await this.pool.getConnection();
      await connection.query('SELECT 1');
      connection.release();

      const latency = Date.now() - startTime;

      logger.debug({ latency }, 'MySQL health check passed');

      return {
        healthy: true,
        latency,
      };
    } catch (error) {
      const latency = Date.now() - startTime;

      logger.error(
        { error: error.message, latency },
        'MySQL health check failed'
      );

      return {
        healthy: false,
        latency,
        error: error.message,
      };
    }
  }

  /**
   * List all tables in allowed schemas (databases in MySQL)
   * @param {Object} [params] - Query parameters
   * @param {string} [params.schema] - Optional schema (database) filter
   * @returns {Promise<Array<{name: string, schema: string}>>}
   */
  async listTables(params = {}) {
    const startTime = Date.now();

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
            table_schema as \`schema\`
          FROM information_schema.tables
          WHERE table_schema = ?
            AND table_type = 'BASE TABLE'
          ORDER BY table_schema, table_name
        `;
        queryParams = [schema];
      } else {
        // Get all tables from allowed schemas
        const allowedSchemas = allowlist.getConfig().allowedSchemas;

        if (allowedSchemas.length === 0) {
          return [];
        }

        // MySQL uses ? placeholders, need one for each schema
        const placeholders = allowedSchemas.map(() => '?').join(',');

        query = `
          SELECT 
            table_name as name,
            table_schema as \`schema\`
          FROM information_schema.tables
          WHERE table_schema IN (${placeholders})
            AND table_type = 'BASE TABLE'
          ORDER BY table_schema, table_name
        `;
        queryParams = allowedSchemas;
      }

      // Execute query
      const [rows] = await this.pool.query(query, queryParams);

      // Filter by allowlist and apply limits
      let tables = rows.filter((row) =>
        allowlist.isTableAllowed(row.schema, row.name)
      );

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
   * @param {string} params.schema - Schema (database) name
   * @param {string} params.table - Table name
   * @returns {Promise<Array<{name: string, type: string, nullable: boolean, default: any, isPrimaryKey: boolean}>>}
   */
  async describeTable(params) {
    const startTime = Date.now();

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
          c.COLUMN_NAME as name,
          c.COLUMN_TYPE as type,
          c.IS_NULLABLE = 'YES' as nullable,
          c.COLUMN_DEFAULT as \`default\`,
          c.COLUMN_KEY = 'PRI' as isPrimaryKey
        FROM information_schema.COLUMNS c
        WHERE c.TABLE_SCHEMA = ?
          AND c.TABLE_NAME = ?
        ORDER BY c.ORDINAL_POSITION
      `;

      const [rows] = await this.pool.query(columnQuery, [schema, table]);

      if (rows.length === 0) {
        throw new Error(`Table "${schema}.${table}" not found or has no columns`);
      }

      // Apply column limit
      let columns = queryGuard.limitColumns(rows);

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
   * @returns {Promise<Object>} Query results with metadata
   */
  async executeQuery(params) {
    const startTime = Date.now();
    let validationPassed = false; // Track whether validation succeeded

    try {
      const {
        query,
        params: queryParams = [],
        limit = 100,
        timeout = 30000,
      } = params;

      if (!query || typeof query !== 'string') {
        throw this._createError(
          'INVALID_INPUT',
          'Query must be a non-empty string'
        );
      }

      // Compute fingerprint once (no raw SQL crosses audit boundary after this)
      const queryFingerprint = computeQueryFingerprint(query);

      // Step 1: Validate query structure (regex-based security validation)
      const validation = validateQueryWithTables(query);
      
      if (!validation.valid) {
        // Audit log: validation rejected (AFTER validation, fail-closed)
        logQueryEvent('mysql', queryFingerprint, 'rejected');
        throw this._createError('QUERY_REJECTED', validation.reason);
      }

      const tables = validation.tables;

      // Step 2: Enforce permissions (allowlist check)
      try {
        enforceQueryPermissions(query);
      } catch (permissionError) {
        // Audit log: permission rejected (AFTER permission check, fail-closed)
        logQueryEvent('mysql', queryFingerprint, 'rejected');
        throw permissionError;
      }

      // Audit log: validation succeeded (AFTER validation + permissions, fail-closed)
      logQueryEvent('mysql', queryFingerprint, 'validated');
      validationPassed = true; // Mark validation as complete

      // Step 3: Validate and normalize limits/timeouts
      const normalizedLimit = this._normalizeLimit(limit);
      const normalizedTimeout = this._normalizeTimeout(timeout);

      // Step 4: Execute via safe read method
      const result = await this._executeSafeRead(query, queryParams, {
        maxLimit: normalizedLimit,
        timeout: normalizedTimeout,
      });

      const executionTime = Date.now() - startTime;

      // Audit log: execution succeeded (AFTER execution, fail-closed)
      logQueryEvent('mysql', queryFingerprint, 'success', executionTime);

      // Step 5: Log operation (no query text or params in logs)
      this.logOperation(
        'executeQuery',
        { tableCount: tables.length, limit: normalizedLimit },
        startTime,
        result
      );

      return {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields.map((f) => ({
          name: f.name,
          type: f.type,
        })),
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
        logQueryEvent('mysql', queryFingerprint, 'execution_error', Date.now() - startTime);
      }
      
      this.logError('executeQuery', { hasQuery: !!params.query }, mappedError);
      throw mappedError;
    }
  }

  /**
   * Execute a read-only query with safety enforcements
   * 
   * Enforces:
   * - SET SESSION TRANSACTION READ ONLY
   * - Query timeout at session level
   * - Server-side LIMIT (never trust client)
   * - Max rows enforcement (post-execution truncation)
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

    // Inject LIMIT if missing, clamp if present
    const limitedQuery = this._enforceLimitClause(query, enforcedLimit);

    const connection = await this.pool.getConnection();
    const startTime = Date.now();

    try {
      // Set session to read-only mode
      await connection.query('SET SESSION TRANSACTION READ ONLY');

      // Set query timeout (milliseconds to seconds, rounded up)
      const timeoutSeconds = Math.ceil(timeout / 1000);
      await connection.query(`SET SESSION max_execution_time = ${timeoutSeconds * 1000}`);

      // Execute the query
      const [rows, fields] = await connection.query(limitedQuery, params);

      const executionTime = Date.now() - startTime;

      // Post-execution truncation (defense in depth)
      let truncated = false;
      let resultRows = rows;

      if (rows.length > enforcedLimit) {
        resultRows = rows.slice(0, enforcedLimit);
        truncated = true;
        logger.warn(
          { returnedRows: rows.length, enforcedLimit },
          'Query returned more rows than limit, truncated'
        );
      }

      logger.debug(
        {
          executionTime,
          rowCount: resultRows.length,
          truncated,
          appliedLimit: enforcedLimit,
        },
        'Safe read query executed'
      );

      return {
        rows: resultRows,
        fields: fields || [],
        rowCount: resultRows.length,
        executionTime,
        truncated,
        appliedLimit: enforcedLimit,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      logger.error(
        {
          error: error.message,
          executionTime,
          timeout,
          enforcedLimit,
        },
        'Safe read query failed'
      );

      throw error;
    } finally {
      // Reset session settings and release connection
      try {
        await connection.query('SET SESSION TRANSACTION READ WRITE');
        await connection.query('SET SESSION max_execution_time = DEFAULT');
      } catch (resetError) {
        logger.error(
          { error: resetError.message },
          'Failed to reset session settings'
        );
      }

      connection.release();
    }
  }

  /**
   * Enforce LIMIT clause on a query
   * - If query has no LIMIT: append LIMIT
   * - If query has LIMIT: clamp to server max
   * 
   * @private
   * @param {string} query - SQL query
   * @param {number} maxLimit - Server-enforced maximum LIMIT
   * @returns {string} Query with enforced LIMIT
   */
  _enforceLimitClause(query, maxLimit) {
    // Check if query already has LIMIT clause (case-insensitive)
    const limitRegex = /\bLIMIT\s+(\d+)\b/i;
    const match = limitRegex.exec(query);

    if (match) {
      // Query has LIMIT - clamp to server max
      const clientLimit = parseInt(match[1], 10);
      const clampedLimit = Math.min(clientLimit, maxLimit);

      // Replace existing LIMIT with clamped value
      return query.replace(limitRegex, `LIMIT ${clampedLimit}`);
    } else {
      // Query has no LIMIT - append server max
      const trimmed = query.trimEnd();
      return `${trimmed} LIMIT ${maxLimit}`;
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
    if (
      error.code &&
      ['QUERY_REJECTED', 'PERMISSION_DENIED', 'INVALID_INPUT', 'AUDIT_FAILURE'].includes(
        error.code
      )
    ) {
      return error;
    }

    // Map MySQL error codes
    // ER_QUERY_TIMEOUT or max_execution_time exceeded
    if (error.code === 'ER_QUERY_TIMEOUT' || error.errno === 3024) {
      return this._createError('TIMEOUT', 'Query execution timeout');
    }

    // Syntax errors (1064)
    if (error.errno === 1064) {
      return this._createError('SYNTAX_ERROR', 'SQL syntax error');
    }

    // Table/column doesn't exist (1146, 1054)
    if (error.errno === 1146 || error.errno === 1054) {
      return this._createError(
        'OBJECT_NOT_FOUND',
        'Referenced table or column not found'
      );
    }

    // Access denied (1142, 1143, 1370)
    if ([1142, 1143, 1370].includes(error.errno)) {
      return this._createError(
        'PERMISSION_DENIED',
        'Access denied to requested object'
      );
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

export default MySQLAdapter;
