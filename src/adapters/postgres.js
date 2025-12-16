import { BaseAdapter } from './baseAdapter.js';
import { pgPool } from '../utils/pgPool.js';
import { allowlist } from '../security/allowlist.js';
import { queryGuard } from '../security/queryGuard.js';
import { logger } from '../utils/logger.js';

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
}

export default PostgresAdapter;
