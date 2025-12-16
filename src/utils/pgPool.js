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
