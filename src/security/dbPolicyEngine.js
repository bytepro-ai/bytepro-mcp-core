import { logger } from '../utils/logger.js';

/**
 * DB-Backed Policy Engine
 * 
 * Enforces table-level and time-based access control using policies stored in the database.
 * 
 * Security Model:
 * - Policies are loaded from `ai_db_policies` table
 * - Cached in memory with TTL-based refresh
 * - Fail-closed: missing policy = deny
 * - Explicit deny overrides implicit allow
 * - Time windows enforced in UTC
 * - Supports time windows crossing midnight
 * 
 * Policy Schema:
 * - tenant_id: VARCHAR (tenant identifier)
 * - role: VARCHAR (role identifier)
 * - table_name: VARCHAR (table name without schema qualifier)
 * - allowed: BOOLEAN (explicit allow/deny)
 * - start_time: TIME NULL (UTC start time for allowed window)
 * - end_time: TIME NULL (UTC end time for allowed window)
 */

/**
 * Policy denial reasons
 */
const PolicyDenialReason = Object.freeze({
  NO_POLICY: 'NO_POLICY',
  TABLE_DENIED: 'TABLE_DENIED',
  TIME_WINDOW: 'TIME_WINDOW',
});

/**
 * DB-backed policy engine for table-level access control
 */
export class DBPolicyEngine {
  constructor({ ttlMs = 300000 } = {}) {
    this.ttlMs = ttlMs; // Default: 5 minutes
    this.policies = new Map(); // key: `${tenant}:${role}:${table}` -> policy object
    this.lastLoaded = null;
    this.adapter = null;
    this.sessionContext = null;

    logger.info({ ttlMs: this.ttlMs }, 'DBPolicyEngine: Initialized');
  }

  /**
   * Initialize the policy engine with a database adapter and session context
   * Loads policies from `ai_db_policies` table
   * 
   * @param {BaseAdapter} adapter - Database adapter instance
   * @param {SessionContext} sessionContext - Session context for policy loading
   * @throws {Error} If policy loading fails
   */
  async initialize(adapter, sessionContext) {
    if (!adapter) {
      throw new Error('DBPolicyEngine: Adapter is required');
    }

    if (!sessionContext) {
      throw new Error('DBPolicyEngine: SessionContext is required');
    }

    this.adapter = adapter;
    this.sessionContext = sessionContext;
    await this._loadPolicies();

    logger.info(
      {
        policyCount: this.policies.size,
        ttlMs: this.ttlMs,
      },
      'DBPolicyEngine: Policies loaded'
    );
  }

  /**
   * Assert that access is allowed for all specified tables
   * 
   * Enforcement rules:
   * 1. If cache expired, reload policies
   * 2. For each table:
   *    - Find matching policy (tenant + role + table)
   *    - No policy → deny
   *    - allowed === false → deny
   *    - Time window violation → deny
   * 3. If all checks pass → return true
   * 4. On any denial → throw structured error
   * 
   * @param {Object} context - Access check context
   * @param {string} context.tenant - Tenant identifier
   * @param {string} context.role - Role identifier
   * @param {string[]} context.tables - Table names to check
   * @param {number} context.now - Current timestamp (Date.now())
   * @throws {Error} If access is denied
   */
  async assertAllowed({ tenant, role, tables, now }) {
    if (!this.adapter) {
      throw new Error('DBPolicyEngine: Not initialized (call initialize() first)');
    }

    if (!tenant || typeof tenant !== 'string') {
      throw new Error('DBPolicyEngine: tenant must be a non-empty string');
    }

    if (!role || typeof role !== 'string') {
      throw new Error('DBPolicyEngine: role must be a non-empty string');
    }

    if (!Array.isArray(tables) || tables.length === 0) {
      throw new Error('DBPolicyEngine: tables must be a non-empty array');
    }

    if (typeof now !== 'number' || now <= 0) {
      throw new Error('DBPolicyEngine: now must be a positive number');
    }

    // Check if cache expired and reload if necessary
    if (this.lastLoaded === null || (now - this.lastLoaded) > this.ttlMs) {
      logger.info('DBPolicyEngine: Cache expired, reloading policies');
      await this._loadPolicies();
    }

    // Check each table
    for (const table of tables) {
      const tableName = this._normalizeTableName(table);
      const policyKey = this._buildPolicyKey(tenant, role, tableName);
      const policy = this.policies.get(policyKey);

      // No policy → deny
      if (!policy) {
        logger.warn(
          {
            tenant,
            role,
            table: tableName,
            reason: PolicyDenialReason.NO_POLICY,
          },
          'DBPolicyEngine: Access denied (no policy)'
        );

        throw this._createDenialError(
          tenant,
          role,
          tableName,
          PolicyDenialReason.NO_POLICY
        );
      }

      // Explicit deny
      if (policy.allowed === false) {
        logger.warn(
          {
            tenant,
            role,
            table: tableName,
            reason: PolicyDenialReason.TABLE_DENIED,
          },
          'DBPolicyEngine: Access denied (explicit deny)'
        );

        throw this._createDenialError(
          tenant,
          role,
          tableName,
          PolicyDenialReason.TABLE_DENIED
        );
      }

      // Time window check
      if (policy.start_time || policy.end_time) {
        const currentTime = this._getUTCTimeString(now);
        const allowed = this._isWithinTimeWindow(
          currentTime,
          policy.start_time,
          policy.end_time
        );

        if (!allowed) {
          logger.warn(
            {
              tenant,
              role,
              table: tableName,
              currentTime,
              startTime: policy.start_time,
              endTime: policy.end_time,
              reason: PolicyDenialReason.TIME_WINDOW,
            },
            'DBPolicyEngine: Access denied (outside time window)'
          );

          throw this._createDenialError(
            tenant,
            role,
            tableName,
            PolicyDenialReason.TIME_WINDOW
          );
        }
      }
    }

    // All checks passed
    logger.debug(
      {
        tenant,
        role,
        tables,
      },
      'DBPolicyEngine: Access allowed'
    );

    return true;
  }

  /**
   * Load policies from database
   * @private
   */
  async _loadPolicies() {
    const startTime = Date.now();

    try {
      const query = `
        SELECT 
          tenant_id,
          role,
          table_name,
          allowed,
          start_time,
          end_time
        FROM ai_db_policies
        ORDER BY tenant_id, role, table_name
      `;

      // Normalize internal SQL to avoid control-character rejection
      const normalizedQuery = query.replace(/\s+/g, ' ').trim();

      const result = await this.adapter.executeQuery(
        { query: normalizedQuery, params: [] },
        this.sessionContext
      );

      // Clear existing policies
      this.policies.clear();

      // Handle both result.rows and result array formats
      const rows = result.rows || result;

      if (!Array.isArray(rows)) {
        throw new Error('Expected result to be an array or contain rows array');
      }

      // Build policy map
      for (const row of rows) {
        const policyKey = this._buildPolicyKey(
          row.tenant_id,
          row.role,
          row.table_name
        );

        this.policies.set(policyKey, {
          tenant: row.tenant_id,
          role: row.role,
          table: row.table_name,
          allowed: row.allowed,
          start_time: row.start_time,
          end_time: row.end_time,
        });
      }

      this.lastLoaded = Date.now();

      const duration = Date.now() - startTime;

      logger.info(
        {
          policyCount: this.policies.size,
          duration,
        },
        'DBPolicyEngine: Policies loaded successfully'
      );
    } catch (error) {
      logger.error(
        {
          error: error.message,
          duration: Date.now() - startTime,
        },
        'DBPolicyEngine: Failed to load policies'
      );

      throw new Error(`Failed to load DB policies: ${error.message}`);
    }
  }

  /**
   * Check if current time is within allowed time window
   * Handles windows that cross midnight (e.g., 22:00:00 to 06:00:00)
   * @private
   */
  _isWithinTimeWindow(currentTime, startTime, endTime) {
    // If no time constraints, allow
    if (!startTime && !endTime) {
      return true;
    }

    // If only start_time is set, check if current >= start
    if (startTime && !endTime) {
      return currentTime >= startTime;
    }

    // If only end_time is set, check if current <= end
    if (!startTime && endTime) {
      return currentTime <= endTime;
    }

    // Both start and end are set
    // Check if window crosses midnight
    if (startTime > endTime) {
      // Window crosses midnight (e.g., 22:00:00 to 06:00:00)
      // Allow if current >= start OR current <= end
      return currentTime >= startTime || currentTime <= endTime;
    } else {
      // Normal window (e.g., 09:00:00 to 17:00:00)
      // Allow if current >= start AND current <= end
      return currentTime >= startTime && currentTime <= endTime;
    }
  }

  /**
   * Build policy key from tenant, role, and table
   * @private
   */
  _buildPolicyKey(tenant, role, table) {
    return `${tenant}:${role}:${table}`;
  }

  /**
   * Normalize table name (remove schema prefix if present)
   * @private
   */
  _normalizeTableName(table) {
    if (table.includes('.')) {
      return table.split('.').pop();
    }
    return table;
  }

  /**
   * Get UTC time string in HH:MM:SS format from timestamp
   * @private
   */
  _getUTCTimeString(timestamp) {
    const date = new Date(timestamp);
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * Create structured denial error
   * @private
   */
  _createDenialError(tenant, role, table, reason) {
    const error = new Error('Access denied by DB policy');
    error.code = 'POLICY_DENIED';
    error.details = {
      tenant,
      role,
      table,
      reason,
    };
    return error;
  }
}

export default DBPolicyEngine;
