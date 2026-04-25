import { createLogger } from '../utils/logger.js';

const logger = createLogger();

/**
 * DB-Backed Policy Engine (v2)
 *
 * Enforces table-level and time-based access control using policies stored in the database.
 *
 * Security Model:
 * - Policies are loaded from `ai_db_policies` table
 * - Cached in memory with TTL-based refresh
 * - Fail-closed: missing policy = deny
 * - Deterministic resolution: independent of database row order
 * - Deny dominance: at equal priority, deny beats allow
 * - Priority stratification: higher priority tier wins absolutely
 * - Time windows enforced in UTC; support midnight-crossing windows
 *
 * Policy Schema (v2):
 * - tenant_id:  VARCHAR  — tenant identifier
 * - role:       VARCHAR  — role identifier
 * - table_name: VARCHAR  — table name without schema qualifier
 * - effect:     VARCHAR  — 'allow' | 'deny'
 * - priority:   INT      — higher integer = higher precedence tier
 * - version:    INT      — monotonic; higher = most-recent within (tenant,role,table,priority)
 * - is_active:  BOOLEAN  — FALSE = soft-deactivated; never physically deleted
 * - start_time: TIME NULL — UTC HH:MM:SS; NULL = no lower bound
 * - end_time:   TIME NULL — UTC HH:MM:SS; NULL = no upper bound
 *
 * Backward compatibility:
 * - Rows with `allowed` BOOLEAN (v1) and no `effect` column are accepted.
 *   allowed=true → effect='allow'; allowed=false → effect='deny'.
 *   Missing priority/version/is_active default to 0/1/true respectively.
 *
 * See: docs/architecture/policy-resolution-v2.md
 * See: docs/security/SECURITY-INVARIANTS.md — Invariants I-1 through I-9
 */

/**
 * Policy denial reasons.
 * NO_ACTIVE_POLICY is distinct from NO_POLICY:
 *   NO_POLICY       — no row in the table matches (tenant, role, table) at all
 *   NO_ACTIVE_POLICY — rows exist but all have is_active=false or are outside their time window
 */
const PolicyDenialReason = Object.freeze({
  NO_POLICY: 'NO_POLICY',
  NO_ACTIVE_POLICY: 'NO_ACTIVE_POLICY',
  TABLE_DENIED: 'TABLE_DENIED',
  TIME_WINDOW: 'TIME_WINDOW',
});

/**
 * DB-backed policy engine for table-level access control (v2)
 *
 * Use a two-stage lifecycle: construct the engine, then initialize it with an
 * already-connected adapter and bound session context before enforcing access.
 *
 * @example
 * const policyEngine = new DBPolicyEngine({ ttlMs: 300000 });
 * await policyEngine.initialize(adapter, sessionContext);
 * await policyEngine.assertAllowed({
 *   tenant: sessionContext.tenant,
 *   role: 'analyst',
 *   tables: ['customers'],
 *   now: Date.now(),
 * });
 */
export class DBPolicyEngine {
  constructor({ ttlMs = 300000 } = {}) {
    this.ttlMs = ttlMs; // Default: 5 minutes
    // key: `${tenant}:${role}:${table}` → Policy[]  (all rows for that key)
    this.policies = new Map();
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
   * Assert that access is allowed for all specified tables.
   *
   * Enforcement rules (v2 deterministic algorithm):
   * 1. If cache expired, reload policies
   * 2. For each table:
   *    a. Look up the Policy[] array for (tenant, role, table)
   *    b. No rows → DENY (NO_POLICY)
   *    c. Delegate to _resolve(rows, now) for the deterministic decision
   *    d. _resolve result DENY → throw structured error
   * 3. All tables pass → return true
   *
   * Resolution is order-independent: the same set of rows always produces
   * the same result regardless of the order they appear in the DB or cache.
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

    // Reload cache if expired
    if (this.lastLoaded === null || (now - this.lastLoaded) > this.ttlMs) {
      logger.info('DBPolicyEngine: Cache expired, reloading policies');
      await this._loadPolicies();
    }

    // Check each table using the deterministic resolution algorithm
    for (const table of tables) {
      const tableName = this._normalizeTableName(table);
      const policyKey = this._buildPolicyKey(tenant, role, tableName);
      const rows = this.policies.get(policyKey);

      // No rows for this (tenant, role, table) key → fail-closed (I-2)
      if (!rows || rows.length === 0) {
        logger.warn(
          { tenant, role, table: tableName, reason: PolicyDenialReason.NO_POLICY },
          'DBPolicyEngine: Access denied (no policy)'
        );
        throw this._createDenialError(tenant, role, tableName, PolicyDenialReason.NO_POLICY);
      }

      // Deterministic resolution over the full row set for this key
      const resolution = this._resolve(rows, now);

      if (!resolution.allowed) {
        logger.warn(
          {
            tenant,
            role,
            table: tableName,
            reason: resolution.reason,
            winningPriority: resolution.winningPriority ?? null,
          },
          'DBPolicyEngine: Access denied'
        );
        throw this._createDenialError(tenant, role, tableName, resolution.reason);
      }

      logger.debug(
        { tenant, role, table: tableName, winningPriority: resolution.winningPriority },
        'DBPolicyEngine: Table access allowed'
      );
    }

    logger.debug({ tenant, role, tables }, 'DBPolicyEngine: Access allowed');
    return true;
  }

  /**
   * Load policies from database into the in-memory cache.
   *
   * Each (tenant, role, table) key maps to a Policy[] containing ALL rows for
   * that key. _resolve() then applies the deterministic algorithm over the full
   * array, so this method must not pre-filter rows.
   *
   * Backward compatibility: if a row has `allowed` BOOLEAN but no `effect`
   * column, effect is derived as 'allow'|'deny'. Missing priority/version/
   * is_active default to 0/1/true.
   *
   * @private
   */
  async _loadPolicies() {
    const startTime = Date.now();

    try {
      // Use schema-qualified table name to satisfy adapter validation
      const database = this.adapter?.config?.database;
      if (!database) {
        throw new Error('DBPolicyEngine: Adapter config missing database for policy loading');
      }
      const policyTable = `${database}.ai_db_policies`;

      const query = `
        SELECT
          tenant_id,
          role,
          table_name,
          effect,
          priority,
          version,
          is_active,
          start_time,
          end_time
        FROM ${policyTable}
        ORDER BY tenant_id, role, table_name, priority DESC, version DESC
      `;

      // Normalize internal SQL to avoid control-character rejection
      const normalizedQuery = query.replace(/\s+/g, ' ').trim();

      const result = await this.adapter.executeQuery(
        { query: normalizedQuery, params: [] },
        this.sessionContext,
        { internal: true }
      );

      // Clear existing policies
      this.policies.clear();

      // Handle both result.rows and result array formats
      const rows = result.rows || result;

      if (!Array.isArray(rows)) {
        throw new Error('Expected result to be an array or contain rows array');
      }

      // Build policy map: key → Policy[]
      for (const row of rows) {
        const policyKey = this._buildPolicyKey(
          row.tenant_id,
          row.role,
          row.table_name
        );

        // --- Backward compatibility shim ---
        // v1 rows have `allowed` BOOLEAN; v2 rows have `effect` VARCHAR.
        // If `effect` is absent or null, derive it from `allowed`.
        let effect = row.effect;
        if (effect == null) {
          effect = (row.allowed === true || row.allowed === 1) ? 'allow' : 'deny';
        }

        // Validate effect value; reject unknown values fail-closed (treat as deny)
        if (effect !== 'allow' && effect !== 'deny') {
          logger.warn(
            { policyKey, effect },
            'DBPolicyEngine: Unknown effect value in policy row; treating as deny'
          );
          effect = 'deny';
        }

        const priority  = row.priority  ?? 0;
        const version   = row.version   ?? 1;
        // is_active may be boolean (PG/MySQL BOOLEAN) or 0/1 (MSSQL BIT)
        const is_active = row.is_active != null
          ? (row.is_active === true || row.is_active === 1)
          : true;

        const policy = {
          tenant:     row.tenant_id,
          role:       row.role,
          table:      row.table_name,
          effect,
          priority,
          version,
          is_active,
          start_time: row.start_time ?? null,
          end_time:   row.end_time   ?? null,
        };

        if (!this.policies.has(policyKey)) {
          this.policies.set(policyKey, []);
        }
        this.policies.get(policyKey).push(policy);
      }

      this.lastLoaded = Date.now();

      const duration = Date.now() - startTime;

      logger.info(
        { policyCount: this.policies.size, duration },
        'DBPolicyEngine: Policies loaded successfully'
      );
    } catch (error) {
      logger.error(
        { error: error.message, duration: Date.now() - startTime },
        'DBPolicyEngine: Failed to load policies'
      );

      throw new Error(`Failed to load DB policies: ${error.message}`);
    }
  }

  /**
   * Deterministic resolution algorithm (v2).
   *
   * Orchestrates the five pipeline steps in strict order. Pure function over
   * the provided row array: no database access, no cache access, no external
   * state. Given identical inputs always produces identical output regardless
   * of row order.
   *
   * Pipeline (mirrors docs/architecture/deterministic-resolution-v1.md §4):
   *   1. _filterActive          → retain is_active=true rows
   *   2. _deduplicateByVersion  → per priority group, retain max(version) peers
   *   3. _filterByTimeWindow    → retain rows within UTC time window
   *   4. _selectHighestPriorityTier → keep only the max-priority rows
   *   5. _applyDenyDominance    → deny if any row in tier is 'deny'; else allow
   *
   * Invariants satisfied:
   *   I-2  Fail-closed       (empty at any stage → DENY)
   *   I-3  Deny dominance    (any deny in tier → DENY)
   *   I-4  Priority monotonicity
   *   I-5  Order independence (pure set operations)
   *   I-6  Version canonicity (max version per priority group)
   *   I-7  Time window is a filter, not a default-allow
   *   I-8  No implicit allow
   *
   * @param {Object[]} rows - Policy rows for a single (tenant, role, table) key
   * @param {number} nowMs  - Current UTC timestamp (Date.now())
   * @returns {{ allowed: boolean, reason: string|null, winningPriority: number|null }}
   * @private
   */
  _resolve(rows, nowMs) {
    // Step 1 — Active filter (I-2, I-7)
    const active = this._filterActive(rows);
    if (active.length === 0) {
      return { allowed: false, reason: PolicyDenialReason.NO_ACTIVE_POLICY, winningPriority: null };
    }

    // Step 2 — Version deduplication per priority group (I-6)
    const deduped = this._deduplicateByVersion(active);

    // Step 3 — Time validity filter (I-7)
    const timeValid = this._filterByTimeWindow(deduped, nowMs);
    if (timeValid.length === 0) {
      return { allowed: false, reason: PolicyDenialReason.TIME_WINDOW, winningPriority: null };
    }

    // Step 4 — Priority stratification (I-4)
    const tier = this._selectHighestPriorityTier(timeValid);

    // Steps 5 & 6 — Deny dominance and allow (I-3, I-8)
    return this._applyDenyDominance(tier);
  }

  /**
   * Step 1 — Active filter.
   *
   * Retains only rows where is_active === true. Rows with is_active=false are
   * soft-deactivated and must never participate in resolution. Pure; does not
   * mutate the input array.
   *
   * @param {Object[]} rows - All cached rows for a (tenant, role, table) key
   * @returns {Object[]} Rows where is_active === true
   * @private
   */
  _filterActive(rows) {
    return rows.filter(p => p.is_active === true);
  }

  /**
   * Step 2 — Version deduplication per priority group.
   *
   * For each distinct priority level, identifies the canonical version:
   * max(version) over all rows at that priority. Then retains every row whose
   * (priority, version) matches (priority, canonicalVersion). Rows at the same
   * priority but a lower version are discarded.
   *
   * Rows sharing the same (priority, canonicalVersion) but differing in effect
   * are all retained so that deny dominance (Step 5) can resolve them.
   *
   * Pure; does not mutate the input array. Input must be the active-only set
   * produced by _filterActive.
   *
   * @param {Object[]} rows - Active policy rows
   * @returns {Object[]} Deduplicated rows (flat array, one or more per priority)
   * @private
   */
  _deduplicateByVersion(rows) {
    // Pass 1: find canonical version (max) per priority group
    const canonicalVersion = new Map();
    for (const p of rows) {
      const current = canonicalVersion.get(p.priority);
      if (current === undefined || p.version > current) {
        canonicalVersion.set(p.priority, p.version);
      }
    }

    // Pass 2: retain all rows whose (priority, version) matches the canonical
    return rows.filter(p => canonicalVersion.get(p.priority) === p.version);
  }

  /**
   * Step 3 — Time validity filter.
   *
   * Retains only rows whose UTC time window includes the instant represented
   * by nowMs. Rows with no time bounds (start_time=null, end_time=null) always
   * pass. Midnight-crossing windows are handled by _isWithinTimeWindow.
   *
   * Pure; does not mutate the input array.
   *
   * @param {Object[]} rows - Deduplicated rows from _deduplicateByVersion
   * @param {number} nowMs  - Current UTC timestamp (Date.now())
   * @returns {Object[]} Rows whose time window includes nowMs
   * @private
   */
  _filterByTimeWindow(rows, nowMs) {
    const currentTime = this._getUTCTimeString(nowMs);
    return rows.filter(p => this._isWithinTimeWindow(currentTime, p.start_time, p.end_time));
  }

  /**
   * Step 4 — Priority stratification.
   *
   * Finds the maximum priority value present in the input and returns only the
   * rows at that priority level. All lower-priority rows are discarded. The
   * winning tier is absolute: no row below max(priority) participates in the
   * deny-dominance decision.
   *
   * Pure; does not mutate the input array. Input must be non-empty (caller
   * checks timeValid.length === 0 before calling this method).
   *
   * @param {Object[]} rows - Time-valid rows from _filterByTimeWindow
   * @returns {Object[]} Rows at max(priority) only
   * @private
   */
  _selectHighestPriorityTier(rows) {
    const maxPriority = Math.max(...rows.map(p => p.priority));
    return rows.filter(p => p.priority === maxPriority);
  }

  /**
   * Steps 5 & 6 — Deny dominance and allow.
   *
   * Applies deny dominance within the winning tier: if any row has
   * effect='deny', the result is DENY (TABLE_DENIED) regardless of how many
   * allow rows are present. Only if all rows have effect='allow' is the result
   * ALLOW.
   *
   * Pure; does not mutate the input array. Input is the winning tier produced
   * by _selectHighestPriorityTier and is guaranteed non-empty.
   *
   * @param {Object[]} tier - Rows at the highest priority tier
   * @returns {{ allowed: boolean, reason: string|null, winningPriority: number }}
   * @private
   */
  _applyDenyDominance(tier) {
    const winningPriority = tier[0].priority;
    const hasDeny = tier.some(p => p.effect === 'deny');
    if (hasDeny) {
      return { allowed: false, reason: PolicyDenialReason.TABLE_DENIED, winningPriority };
    }
    return { allowed: true, reason: null, winningPriority };
  }

  /**
   * Check if current time is within allowed time window.
   * Handles windows that cross midnight (e.g., 22:00:00 to 06:00:00).
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
