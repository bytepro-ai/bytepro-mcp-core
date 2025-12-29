import { logger } from '../utils/logger.js';

/**
 * BLOCK 3: Quota and Rate Limiting System
 * 
 * Security Invariants:
 * 1. Quotas are enforced server-side only (no client hints)
 * 2. Enforcement occurs AFTER authorization (Block 2) and BEFORE validation/execution
 * 3. Fail-closed on any ambiguity or counter errors
 * 4. Scoped by tenant + identity + action + target (server-derived only)
 * 5. No data-plane leakage (no SQL parsing, no schema inspection)
 */

/**
 * Quota dimension types (closed enum)
 */
export const QuotaDimension = Object.freeze({
  RATE_PER_MINUTE: 'rate.per_minute',
  RATE_PER_10_SECONDS: 'rate.per_10_seconds',
  CONCURRENCY: 'concurrency.max',
  COST_PER_MINUTE: 'cost.per_minute',
});

/**
 * Quota denial reasons (for audit logging)
 */
export const QuotaDenialReason = Object.freeze({
  POLICY_MISSING: 'QUOTA_POLICY_MISSING',
  POLICY_AMBIGUOUS: 'QUOTA_POLICY_AMBIGUOUS',
  RATE_EXCEEDED: 'RATE_EXCEEDED',
  CONCURRENCY_EXCEEDED: 'CONCURRENCY_EXCEEDED',
  COST_EXCEEDED: 'COST_EXCEEDED',
  COUNTER_ERROR: 'COUNTER_ERROR',
  CLOCK_AMBIGUITY: 'CLOCK_AMBIGUITY',
});

/**
 * Tool cost table (adapter-agnostic, server-defined)
 * Units are arbitrary "cost units" per invocation
 */
const TOOL_COSTS = Object.freeze({
  list_tables: 1,
  describe_table: 2,
  query_read: 5,
});

/**
 * QuotaPolicy: Immutable quota limits for a scope
 */
export class QuotaPolicy {
  constructor({ tenant, identity, capSetId, limits }) {
    // INVARIANT: All required fields must be present
    if (!tenant || typeof tenant !== 'string') {
      throw new Error('QuotaPolicy: tenant is required');
    }

    if (!limits || typeof limits !== 'object') {
      throw new Error('QuotaPolicy: limits object is required');
    }

    this.tenant = tenant;
    this.identity = identity || null; // null = tenant-wide policy
    this.capSetId = capSetId || null; // null = not capability-specific
    this.limits = Object.freeze({ ...limits });

    // Make immutable
    Object.freeze(this);
  }

  /**
   * Get limit for a specific dimension
   * @param {string} dimension - QuotaDimension value
   * @returns {number|null} Limit value or null if not set
   */
  getLimit(dimension) {
    return this.limits[dimension] ?? null;
  }

  /**
   * Check if this policy applies to a given scope
   */
  appliesTo(tenant, identity, capSetId) {
    if (this.tenant !== tenant) return false;
    if (this.identity && this.identity !== identity) return false;
    if (this.capSetId && this.capSetId !== capSetId) return false;
    return true;
  }
}

/**
 * Token bucket for rate limiting
 */
class TokenBucket {
  constructor(capacity, refillRate, windowMs) {
    this.capacity = capacity; // Max tokens
    this.refillRate = refillRate; // Tokens per window
    this.windowMs = windowMs; // Window duration
    this.tokens = capacity; // Current tokens
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume tokens
   * @param {number} amount - Tokens to consume
   * @returns {boolean} True if consumed, false if insufficient
   */
  tryConsume(amount = 1) {
    const now = Date.now();
    
    // INVARIANT: Fail-closed on clock errors
    if (now < this.lastRefill) {
      logger.error({ now, lastRefill: this.lastRefill }, 'QUOTA: Clock went backwards');
      return false; // Clock skew - deny
    }

    // Refill tokens based on elapsed time
    const elapsed = now - this.lastRefill;
    const refillAmount = (elapsed / this.windowMs) * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + refillAmount);
    this.lastRefill = now;

    // Try to consume
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }

    return false;
  }

  /**
   * Get current token count (for debugging)
   */
  getTokens() {
    return this.tokens;
  }
}

/**
 * Semaphore for concurrency limiting
 */
class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.current = 0;
  }

  /**
   * Attempt to acquire a slot
   * @returns {boolean} True if acquired, false if at capacity
   */
  tryAcquire() {
    if (this.current >= this.maxConcurrent) {
      return false;
    }
    this.current++;
    return true;
  }

  /**
   * Release a slot
   */
  release() {
    if (this.current > 0) {
      this.current--;
    }
  }

  /**
   * Get current count (for debugging)
   */
  getCurrent() {
    return this.current;
  }
}

/**
 * QuotaEngine: In-memory quota enforcement with token buckets and semaphores
 */
export class QuotaEngine {
  constructor(policies = []) {
    this.policies = policies;
    
    // In-memory state (keyed by scope string)
    this.rateBuckets = new Map(); // key -> TokenBucket
    this.costBuckets = new Map(); // key -> TokenBucket
    this.semaphores = new Map(); // key -> Semaphore
    this.lastAccessTime = new Map(); // key -> timestamp (for TTL eviction)
    
    // Configuration
    this.maxKeys = 10000; // Defensive limit on state size
    this.ttlMs = 3600000; // 1 hour TTL for unused keys

    logger.info({ policyCount: policies.length }, 'QuotaEngine: Initialized');
  }

  /**
   * Build scope key from session context and operation
   * SECURITY: All inputs are server-derived (Block 1 + Block 2)
   */
  _buildScopeKey(tenant, identity, capSetId, action, target) {
    // INVARIANT: Fail-closed on missing required components
    if (!tenant || !action || !target) {
      return null; // Ambiguous scope
    }

    // Build hierarchical key
    let key = `tenant:${tenant}`;
    if (identity) {
      key += `:identity:${identity}`;
    }
    if (capSetId) {
      key += `:capset:${capSetId}`;
    }
    key += `:action:${action}:target:${target}`;

    return key;
  }

  /**
   * Find applicable policies for a scope
   * SECURITY: Must be unambiguous (single policy or explicit merge)
   */
  _findApplicablePolicies(tenant, identity, capSetId) {
    const applicable = this.policies.filter(p => 
      p.appliesTo(tenant, identity, capSetId)
    );

    // INVARIANT: For now, we require exactly one policy (fail-closed on ambiguity)
    // Future: could support explicit merge rules
    if (applicable.length === 0) {
      return null; // No policy
    }

    if (applicable.length > 1) {
      logger.warn({
        tenant,
        identity,
        capSetId,
        count: applicable.length,
      }, 'QUOTA: Multiple policies found (ambiguous)');
      return null; // Ambiguous - fail closed
    }

    return applicable[0];
  }

  /**
   * Get or create token bucket for rate limiting
   */
  _getOrCreateBucket(key, dimension, limit, windowMs) {
    const bucketKey = `${key}:${dimension}`;
    
    if (!this.rateBuckets.has(bucketKey)) {
      // INVARIANT: Enforce max key limit (prevent memory exhaustion)
      if (this.rateBuckets.size >= this.maxKeys) {
        this._evictStaleKeys();
        if (this.rateBuckets.size >= this.maxKeys) {
          logger.error({ size: this.rateBuckets.size }, 'QUOTA: Max keys exceeded');
          return null; // Cannot create - fail closed
        }
      }

      this.rateBuckets.set(bucketKey, new TokenBucket(limit, limit, windowMs));
    }

    this.lastAccessTime.set(bucketKey, Date.now());
    return this.rateBuckets.get(bucketKey);
  }

  /**
   * Get or create cost bucket
   */
  _getOrCreateCostBucket(key, limit, windowMs) {
    const bucketKey = `${key}:cost`;
    
    if (!this.costBuckets.has(bucketKey)) {
      if (this.costBuckets.size >= this.maxKeys) {
        this._evictStaleKeys();
        if (this.costBuckets.size >= this.maxKeys) {
          logger.error({ size: this.costBuckets.size }, 'QUOTA: Max keys exceeded');
          return null;
        }
      }

      this.costBuckets.set(bucketKey, new TokenBucket(limit, limit, windowMs));
    }

    this.lastAccessTime.set(bucketKey, Date.now());
    return this.costBuckets.get(bucketKey);
  }

  /**
   * Get or create semaphore for concurrency limiting
   */
  _getOrCreateSemaphore(key, maxConcurrent) {
    const semKey = `${key}:sem`;
    
    if (!this.semaphores.has(semKey)) {
      if (this.semaphores.size >= this.maxKeys) {
        this._evictStaleKeys();
        if (this.semaphores.size >= this.maxKeys) {
          logger.error({ size: this.semaphores.size }, 'QUOTA: Max keys exceeded');
          return null;
        }
      }

      this.semaphores.set(semKey, new Semaphore(maxConcurrent));
    }

    this.lastAccessTime.set(semKey, Date.now());
    return this.semaphores.get(semKey);
  }

  /**
   * Evict stale keys based on TTL
   */
  _evictStaleKeys() {
    const now = Date.now();
    let evicted = 0;

    for (const [key, lastAccess] of this.lastAccessTime.entries()) {
      if (now - lastAccess > this.ttlMs) {
        this.rateBuckets.delete(key);
        this.costBuckets.delete(key);
        this.semaphores.delete(key);
        this.lastAccessTime.delete(key);
        evicted++;
      }
    }

    if (evicted > 0) {
      logger.info({ evicted }, 'QUOTA: Evicted stale keys');
    }
  }

  /**
   * Check and reserve quota for an operation
   * 
   * SECURITY: This is the primary enforcement point
   * Must be called AFTER Block 2 authorization and BEFORE validation/execution
   * 
   * @param {Object} context - Session and operation context
   * @param {string} context.tenant - Tenant ID (from Block 1)
   * @param {string} context.identity - Identity ID (from Block 1)
   * @param {string} context.sessionId - Session ID (from Block 1)
   * @param {string} context.capSetId - Capability set ID (from Block 2)
   * @param {string} context.action - Action being performed (from Block 2)
   * @param {string} context.target - Target (tool name, etc.)
   * @returns {Object} { allowed: boolean, reason: string, semaphoreKey: string|null }
   */
  checkAndReserve(context) {
    const { tenant, identity, sessionId, capSetId, action, target } = context;

    // Find applicable policy FIRST to determine scope granularity
    const policy = this._findApplicablePolicies(tenant, identity, capSetId);
    if (!policy) {
      logger.warn({ tenant, identity, capSetId }, 'QUOTA: No policy found (fail-closed)');
      return { allowed: false, reason: QuotaDenialReason.POLICY_MISSING };
    }

    // INVARIANT: Build scope key based on POLICY granularity
    // If policy is tenant-wide, ignore identity/capSetId for the key
    // This prevents "scope bypass" where rotating credentials resets the quota
    const scopeKey = this._buildScopeKey(
      tenant, 
      policy.identity ? identity : null, 
      policy.capSetId ? capSetId : null, 
      action, 
      target
    );

    if (!scopeKey) {
      logger.error({ context }, 'QUOTA: Failed to build scope key (ambiguous)');
      return { allowed: false, reason: QuotaDenialReason.POLICY_AMBIGUOUS };
    }

    // Check rate limits
    const ratePerMinute = policy.getLimit(QuotaDimension.RATE_PER_MINUTE);
    if (ratePerMinute !== null) {
      const bucket = this._getOrCreateBucket(scopeKey, QuotaDimension.RATE_PER_MINUTE, ratePerMinute, 60000);
      if (!bucket) {
        return { allowed: false, reason: QuotaDenialReason.COUNTER_ERROR };
      }
      if (!bucket.tryConsume(1)) {
        return { allowed: false, reason: QuotaDenialReason.RATE_EXCEEDED };
      }
    }

    const ratePer10s = policy.getLimit(QuotaDimension.RATE_PER_10_SECONDS);
    if (ratePer10s !== null) {
      const bucket = this._getOrCreateBucket(scopeKey, QuotaDimension.RATE_PER_10_SECONDS, ratePer10s, 10000);
      if (!bucket) {
        return { allowed: false, reason: QuotaDenialReason.COUNTER_ERROR };
      }
      if (!bucket.tryConsume(1)) {
        return { allowed: false, reason: QuotaDenialReason.RATE_EXCEEDED };
      }
    }

    // Check cost budget
    const costPerMinute = policy.getLimit(QuotaDimension.COST_PER_MINUTE);
    if (costPerMinute !== null) {
      const toolCost = TOOL_COSTS[target] || 1; // Default cost if tool not in table
      const bucket = this._getOrCreateCostBucket(scopeKey, costPerMinute, 60000);
      if (!bucket) {
        return { allowed: false, reason: QuotaDenialReason.COUNTER_ERROR };
      }
      if (!bucket.tryConsume(toolCost)) {
        return { allowed: false, reason: QuotaDenialReason.COST_EXCEEDED };
      }
    }

    // Check concurrency
    const maxConcurrent = policy.getLimit(QuotaDimension.CONCURRENCY);
    let semaphoreKey = null;
    if (maxConcurrent !== null) {
      const sem = this._getOrCreateSemaphore(scopeKey, maxConcurrent);
      if (!sem) {
        return { allowed: false, reason: QuotaDenialReason.COUNTER_ERROR };
      }
      if (!sem.tryAcquire()) {
        return { allowed: false, reason: QuotaDenialReason.CONCURRENCY_EXCEEDED };
      }
      semaphoreKey = `${scopeKey}:sem`; // Return for later release
    }

    // All checks passed
    return { allowed: true, reason: null, semaphoreKey };
  }

  /**
   * Release concurrency slot after execution
   * MUST be called in finally block to prevent leaks
   */
  release(semaphoreKey) {
    if (!semaphoreKey) return;

    const sem = this.semaphores.get(semaphoreKey);
    if (sem) {
      sem.release();
    }
  }
}

/**
 * Load quota policies from control-plane environment
 * 
 * Expected format for MCP_QUOTA_POLICIES:
 * {
 *   "policies": [
 *     {
 *       "tenant": "tenant-123",
 *       "identity": "user@example.com",
 *       "capSetId": "cap-abc",
 *       "limits": {
 *         "rate.per_minute": 60,
 *         "rate.per_10_seconds": 10,
 *         "concurrency.max": 2,
 *         "cost.per_minute": 100
 *       }
 *     }
 *   ]
 * }
 * 
 * @returns {QuotaEngine} Initialized quota engine
 */
export function loadQuotaEngineFromEnv() {
  const policiesJson = process.env.MCP_QUOTA_POLICIES;
  const isProduction = process.env.NODE_ENV === 'production';

  // INVARIANT: Fail-closed in production if policies are missing
  if (!policiesJson) {
    if (isProduction) {
      logger.fatal('QUOTA: MCP_QUOTA_POLICIES required for production deployment (fail-closed)');
      throw new Error('SECURITY: Quota policies required for production deployment');
    }
    
    // Non-production: Allow empty engine for development/testing
    logger.warn('QUOTA: MCP_QUOTA_POLICIES not set (no quotas enforced - development mode only)');
    return new QuotaEngine([]);
  }

  try {
    const parsed = JSON.parse(policiesJson);
    
    if (!parsed.policies || !Array.isArray(parsed.policies)) {
      logger.fatal('QUOTA: Invalid MCP_QUOTA_POLICIES format (missing policies array)');
      throw new Error('Invalid quota policies format');
    }

    const policies = parsed.policies.map(p => new QuotaPolicy(p));
    
    logger.info({
      policyCount: policies.length,
    }, 'QUOTA: Policies loaded from control-plane');

    return new QuotaEngine(policies);
  } catch (err) {
    logger.fatal({
      error: err.message,
    }, 'FATAL: Failed to parse quota policies (fail-closed)');
    throw new Error('Failed to load quota policies');
  }
}

/**
 * Create a default quota engine with permissive limits (for testing)
 */
export function createDefaultQuotaEngine(tenant, identity = null) {
  const policy = new QuotaPolicy({
    tenant,
    identity,
    capSetId: null,
    limits: {
      [QuotaDimension.RATE_PER_MINUTE]: 100,
      [QuotaDimension.RATE_PER_10_SECONDS]: 20,
      [QuotaDimension.CONCURRENCY]: 5,
      [QuotaDimension.COST_PER_MINUTE]: 500,
    },
  });

  return new QuotaEngine([policy]);
}
