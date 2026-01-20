import { BaseAdapter } from './baseAdapter.js';
import { logger } from '../utils/logger.js';
import { isValidSessionContext } from '../core/sessionContext.js';
import { allowlist } from '../security/allowlist.js';

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

  async listTables(params = {}, sessionContext) {
    if (!sessionContext || !sessionContext.isBound) {
      throw new Error('SECURITY VIOLATION: Adapter called without bound session context');
    }

    if (!isValidSessionContext(sessionContext)) {
      throw new Error('SECURITY VIOLATION: Invalid session context instance');
    }

    throw new Error('Not implemented');
  }

  async describeTable(params, sessionContext) {
    if (!sessionContext || !sessionContext.isBound) {
      throw new Error('SECURITY VIOLATION: Adapter called without bound session context');
    }

    if (!isValidSessionContext(sessionContext)) {
      throw new Error('SECURITY VIOLATION: Invalid session context instance');
    }

    throw new Error('Not implemented');
  }

  async executeQuery(params, sessionContext) {
    if (!sessionContext || !sessionContext.isBound) {
      throw new Error('SECURITY VIOLATION: Query execution attempted without bound session context');
    }

    if (!isValidSessionContext(sessionContext)) {
      throw new Error('SECURITY VIOLATION: Invalid session context instance');
    }

    // MSSQL-specific validation (static string checks)
    const { query } = params;

    if (!query || typeof query !== 'string') {
      throw new Error('Query must be a non-empty string');
    }

    const normalized = query.trim();

    if (normalized.length === 0) {
      throw new Error('Query cannot be empty');
    }

    // Rule: Must start with SELECT (case-insensitive)
    if (!/^SELECT\s+/i.test(normalized)) {
      throw new Error('Query must start with SELECT');
    }

    // Rule: Reject semicolons (multiple statements)
    if (normalized.includes(';')) {
      throw new Error('Multiple statements not allowed (semicolons forbidden)');
    }

    // Rule: Reject batch separator GO
    if (/\bGO\b/i.test(normalized)) {
      throw new Error('Batch separators not allowed (GO forbidden)');
    }

    // Rule: Reject stored procedure execution
    if (/\b(EXEC|EXECUTE)\b/i.test(normalized)) {
      throw new Error('Stored procedure execution not allowed (EXEC/EXECUTE forbidden)');
    }

    // Rule: Reject SQL comments
    if (normalized.includes('--') || normalized.includes('/*') || normalized.includes('*/')) {
      throw new Error('SQL comments not allowed (-- or /* */ forbidden)');
    }

    // Rule: Reject write keywords
    const writeKeywords = [
      'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER',
      'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE'
    ];

    for (const keyword of writeKeywords) {
      const pattern = new RegExp(`\\b${keyword}\\b`, 'i');
      if (pattern.test(normalized)) {
        throw new Error(`Write operations not allowed (${keyword} forbidden)`);
      }
    }

    // Extract and validate table references
    const tables = new Set();

    // Pattern 1: FROM clause - matches FROM schema.table or FROM table
    const fromPattern = /\bFROM\s+(?:(\w+)\.)?(\w+)/gi;
    let match;

    while ((match = fromPattern.exec(normalized)) !== null) {
      const schema = match[1];
      const table = match[2];

      if (schema) {
        tables.add(`${schema}.${table}`);
      } else {
        throw new Error('Table references must be schema-qualified (schema.table)');
      }
    }

    // Pattern 2: JOIN clause - matches JOIN schema.table or JOIN table
    const joinPattern = /\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+)?JOIN\s+(?:(\w+)\.)?(\w+)/gi;

    while ((match = joinPattern.exec(normalized)) !== null) {
      const schema = match[1];
      const table = match[2];

      if (schema) {
        tables.add(`${schema}.${table}`);
      } else {
        throw new Error('Table references must be schema-qualified (schema.table)');
      }
    }

    // Fail-closed: Query must reference at least one table
    if (tables.size === 0) {
      throw new Error('Query must reference at least one table');
    }

    // Enforce allowlist for each referenced table
    for (const fullTableName of tables) {
      const [schema, table] = fullTableName.split('.');

      if (!schema || !table) {
        throw new Error(`Invalid table reference format: ${fullTableName}`);
      }

      // Check schema allowlist
      if (!allowlist.isSchemaAllowed(schema)) {
        throw new Error(`Access denied: Schema "${schema}" is not in the allowlist`);
      }

      // Check table allowlist
      if (!allowlist.isTableAllowed(schema, table)) {
        throw new Error(`Access denied: Table "${fullTableName}" is not in the allowlist`);
      }
    }

    if (!this.connected || !this.pool) {
      throw new Error('Adapter not connected');
    }

    const limitValue = Number(params.limit);
    const requestedLimit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 100;
    const maxRows = Math.min(requestedLimit, 1000);
    let appliedLimit = maxRows;

    const timeoutValue = Number(params.timeout);
    const requestedTimeout = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 30000;
    const queryTimeout = Math.min(requestedTimeout, 60000);

    let finalQuery = normalized;
    const topRegex = /^SELECT\s+(?:DISTINCT\s+)?TOP\s+\(?([0-9]+)\)?/i;
    const topMatch = finalQuery.match(topRegex);

    if (topMatch) {
      const existingLimit = parseInt(topMatch[1], 10);

      if (!Number.isFinite(existingLimit) || existingLimit <= 0) {
        throw new Error('Invalid TOP clause value');
      }

      appliedLimit = Math.min(existingLimit, maxRows);

      if (appliedLimit !== existingLimit) {
        finalQuery = finalQuery.replace(/^SELECT\s+(DISTINCT\s+)?TOP\s+\(?[0-9]+\)?/i, (_, distinctPart) => {
          const distinctSegment = distinctPart ? 'DISTINCT ' : '';
          return `SELECT ${distinctSegment}TOP ${appliedLimit} `;
        });
      }
    } else if (/^SELECT\s+DISTINCT\s+/i.test(finalQuery)) {
      finalQuery = finalQuery.replace(/^SELECT\s+DISTINCT\s+/i, `SELECT DISTINCT TOP ${appliedLimit} `);
    } else {
      finalQuery = finalQuery.replace(/^SELECT\s+/i, `SELECT TOP ${appliedLimit} `);
    }

    if (!/^SELECT\s+/i.test(finalQuery)) {
      throw new Error('Invalid SELECT statement');
    }

    const request = this.pool.request();
    request.timeout = queryTimeout;

    const executionStart = Date.now();

    let result;
    try {
      result = await request.query(finalQuery);
    } catch (error) {
      logger.error({ error: error.message }, 'MSSQL query execution failed');
      throw new Error(`MSSQL query execution failed: ${error.message}`);
    }

    const rows = result?.recordset ?? [];
    const rowCount = rows.length;
    const truncated = rowCount === appliedLimit;
    const executionTime = Date.now() - executionStart;

    return {
      rows,
      rowCount,
      truncated,
      appliedLimit,
      executionTime,
    };
  }
}

export default MSSQLAdapter;
