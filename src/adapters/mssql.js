import { BaseAdapter } from './baseAdapter.js';
import { logger } from '../utils/logger.js';
import { isValidSessionContext } from '../core/sessionContext.js';

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

    throw new Error('Not implemented');
  }
}

export default MSSQLAdapter;
