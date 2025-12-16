import { logger } from '../utils/logger.js';

/**
 * Base adapter interface for database connections
 * All database adapters must extend this class
 */
export class BaseAdapter {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.connected = false;
  }

  /**
   * Connect to the database
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('connect() must be implemented by adapter');
  }

  /**
   * Disconnect from the database
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by adapter');
  }

  /**
   * Health check - verify database connectivity
   * @returns {Promise<{healthy: boolean, latency: number, error?: string}>}
   */
  async health() {
    throw new Error('health() must be implemented by adapter');
  }

  /**
   * List all tables in the database
   * @param {Object} [params] - Query parameters
   * @param {string} [params.schema] - Optional schema filter
   * @returns {Promise<Array<{name: string, schema: string}>>}
   */
  async listTables(params = {}) {
    throw new Error('listTables() must be implemented by adapter');
  }

  /**
   * Describe a specific table's schema
   * @param {Object} params - Query parameters
   * @param {string} params.schema - Schema name
   * @param {string} params.table - Table name
   * @returns {Promise<Array<{name: string, type: string, nullable: boolean, default: any, isPrimaryKey: boolean}>>}
   */
  async describeTable(params) {
    throw new Error('describeTable() must be implemented by adapter');
  }

  /**
   * Get adapter metadata
   * @returns {Object} Adapter information
   */
  getInfo() {
    return {
      name: this.name,
      connected: this.connected,
      type: this.constructor.name,
    };
  }

  /**
   * Log adapter operation
   * @param {string} operation - Operation name
   * @param {Object} params - Operation parameters
   * @param {number} startTime - Operation start time
   * @param {*} result - Operation result
   */
  logOperation(operation, params, startTime, result) {
    const duration = Date.now() - startTime;
    logger.debug(
      {
        adapter: this.name,
        operation,
        params,
        duration,
        resultCount: Array.isArray(result) ? result.length : undefined,
      },
      `Adapter operation: ${operation}`
    );
  }

  /**
   * Log adapter error
   * @param {string} operation - Operation name
   * @param {Object} params - Operation parameters
   * @param {Error} error - Error object
   */
  logError(operation, params, error) {
    logger.error(
      {
        adapter: this.name,
        operation,
        params,
        error: error.message,
        stack: error.stack,
      },
      `Adapter error: ${operation}`
    );
  }
}

export default BaseAdapter;
