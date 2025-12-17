import pg from 'pg';
import { config } from '../config/env.js';
import { logger } from './logger.js';

const { Pool } = pg;

/**
 * PostgreSQL connection pool singleton
 * Manages connections with health checking and graceful shutdown
 */
class PostgresPool {
  constructor() {
    this.pool = null;
    this.isShuttingDown = false;
  }

  /**
   * Initialize the connection pool
   */
  initialize() {
    if (this.pool) {
      logger.warn('PostgreSQL pool already initialized');
      return this.pool;
    }

    const poolConfig = {
      host: config.pg.host,
      port: config.pg.port,
      user: config.pg.user,
      password: config.pg.password,
      database: config.pg.database,
      ssl: config.pg.ssl ? { rejectUnauthorized: false } : false,
      max: config.pg.maxConnections,
      idleTimeoutMillis: config.pg.idleTimeoutMillis,
      connectionTimeoutMillis: config.pg.connectionTimeoutMillis,
    };

    this.pool = new Pool(poolConfig);

    // Log pool errors
    this.pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected PostgreSQL pool error');
    });

    // Log new client connections in debug mode
    this.pool.on('connect', () => {
      logger.debug('New PostgreSQL client connected to pool');
    });

    // Log client removal
    this.pool.on('remove', () => {
      logger.debug('PostgreSQL client removed from pool');
    });

    logger.info(
      {
        host: config.pg.host,
        port: config.pg.port,
        database: config.pg.database,
        maxConnections: config.pg.maxConnections,
      },
      'PostgreSQL pool initialized'
    );

    return this.pool;
  }

  /**
   * Get the pool instance
   * @returns {Pool} PostgreSQL pool
   */
  getPool() {
    if (!this.pool) {
      throw new Error('PostgreSQL pool not initialized. Call initialize() first.');
    }
    if (this.isShuttingDown) {
      throw new Error('PostgreSQL pool is shutting down');
    }
    return this.pool;
  }

  /**
   * Health check: verify database connectivity
   * @returns {Promise<{healthy: boolean, latency: number, error?: string}>}
   */
  async health() {
    const startTime = Date.now();

    try {
      const pool = this.getPool();
      await pool.query('SELECT 1');
      const latency = Date.now() - startTime;

      logger.debug({ latency }, 'PostgreSQL health check passed');

      return {
        healthy: true,
        latency,
      };
    } catch (error) {
      const latency = Date.now() - startTime;

      logger.error({ error: error.message, latency }, 'PostgreSQL health check failed');

      return {
        healthy: false,
        latency,
        error: error.message,
      };
    }
  }

  /**
   * Gracefully shutdown the pool
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this.isShuttingDown) {
      logger.warn('PostgreSQL pool shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;

    if (!this.pool) {
      logger.info('PostgreSQL pool not initialized, nothing to shutdown');
      return;
    }

    try {
      logger.info('Shutting down PostgreSQL pool...');
      await this.pool.end();
      logger.info('PostgreSQL pool shutdown complete');
      this.pool = null;
    } catch (error) {
      logger.error({ error: error.message }, 'Error during PostgreSQL pool shutdown');
      throw error;
    } finally {
      this.isShuttingDown = false;
    }
  }

  /**
   * Execute a query with a client from the pool
   * @param {string} text - SQL query text
   * @param {Array} params - Query parameters
   * @returns {Promise<Object>} Query result
   */
  async query(text, params = []) {
    const pool = this.getPool();
    const startTime = Date.now();

    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - startTime;

      logger.debug({ duration, rowCount: result.rowCount }, 'Query executed');

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(
        {
          error: error.message,
          duration,
          query: text.substring(0, 100), // Log first 100 chars of query
        },
        'Query execution failed'
      );

      throw error;
    }
  }

  /**
   * Execute a read-only query with safety enforcements
   * 
   * Enforces:
   * - READ ONLY transaction
   * - Query timeout
   * - Server-side LIMIT (never trust client)
   * - Max rows enforcement (post-execution truncation)
   * 
   * @param {string} query - SQL SELECT query
   * @param {Array} params - Query parameters
   * @param {Object} options - Execution options
   * @param {number} options.timeout - Query timeout in milliseconds (default: 10000)
   * @param {number} options.maxRows - Maximum rows to return (default: 100, max: 1000)
   * @returns {Promise<{rows, fields, rowCount, executionTime, truncated, appliedLimit}>}
   */
  async executeSafeRead(query, params = [], options = {}) {
    const { timeout = 10000, maxRows = 100 } = options;
    
    // Enforce server-side max limit (never trust client)
    const enforcedLimit = Math.min(Math.max(1, maxRows), 1000);
    
    // Inject LIMIT if missing, clamp if present
    const limitedQuery = this._enforceLimitClause(query, enforcedLimit);
    
    const pool = this.getPool();
    const client = await pool.connect();
    const startTime = Date.now();

    try {
      // Begin READ ONLY transaction
      await client.query('BEGIN READ ONLY');
      
      // Set statement timeout (server-side enforcement)
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      
      // Execute the query
      const result = await client.query(limitedQuery, params);
      
      // Commit transaction
      await client.query('COMMIT');
      
      const executionTime = Date.now() - startTime;
      
      // Post-execution truncation (defense in depth)
      // If database returned more than limit, truncate
      let truncated = false;
      let rows = result.rows;
      
      if (rows.length > enforcedLimit) {
        rows = rows.slice(0, enforcedLimit);
        truncated = true;
        logger.warn(
          { returnedRows: result.rows.length, enforcedLimit },
          'Query returned more rows than limit, truncated'
        );
      }
      
      logger.debug(
        { 
          executionTime, 
          rowCount: rows.length, 
          truncated,
          appliedLimit: enforcedLimit
        }, 
        'Safe read query executed'
      );
      
      return {
        rows,
        fields: result.fields,
        rowCount: rows.length,
        executionTime,
        truncated,
        appliedLimit: enforcedLimit
      };
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      // MANDATORY: Always ROLLBACK on error to prevent dangling transactions
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error(
          { error: rollbackError.message },
          'Failed to ROLLBACK transaction after error'
        );
      }
      
      logger.error(
        {
          error: error.message,
          executionTime,
          timeout,
          enforcedLimit
        },
        'Safe read query failed'
      );
      
      throw error;
      
    } finally {
      // Always release client back to pool
      client.release();
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
      // Preserve trailing whitespace/semicolons
      const trimmed = query.trimEnd();
      return `${trimmed} LIMIT ${maxLimit}`;
    }
  }
}

// Export singleton instance
export const pgPool = new PostgresPool();

// Handle graceful shutdown on process termination
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await pgPool.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await pgPool.shutdown();
  process.exit(0);
});

export default pgPool;
