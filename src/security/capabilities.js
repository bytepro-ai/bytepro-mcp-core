import { logger } from '../utils/logger.js';

/**
 * Capability-Based Authorization System
 * 
 * Security Invariants:
 * 1. Default deny: no grant = no access
 * 2. Explicit only: unknown action/target = deny
 * 3. Server-side only: capabilities resolved from control-plane, never from client
 * 4. Fail-closed: ambiguity or error = deny
 * 5. Adapter-agnostic: authorization happens before data-plane validation
 */

/**
 * Capability actions (closed enum - unknown actions are denied)
 */
export const CapabilityAction = Object.freeze({
  TOOL_INVOKE: 'tool.invoke',
  TOOL_LIST: 'tool.list',
  RESOURCE_READ: 'resource.read',
  RESOURCE_LIST: 'resource.list',
});

/**
 * Authorization decision reasons (for audit logging)
 */
export const AuthzReason = Object.freeze({
  ALLOWED: 'ALLOWED',
  DENIED_NO_CAPABILITY: 'DENIED_NO_CAPABILITY',
  DENIED_NO_GRANT: 'DENIED_NO_GRANT',
  DENIED_UNKNOWN_ACTION: 'DENIED_UNKNOWN_ACTION',
  DENIED_CONSTRAINT_VIOLATION: 'DENIED_CONSTRAINT_VIOLATION',
  DENIED_EXPIRED: 'DENIED_EXPIRED',
  DENIED_INVALID_CONTEXT: 'DENIED_INVALID_CONTEXT',
  DENIED_AMBIGUITY: 'DENIED_AMBIGUITY',
});

/**
 * CapabilitySet: Immutable set of capability grants for a session
 * 
 * Structure:
 * - capSetId: Unique identifier for this capability set
 * - issuedAt: Timestamp when capabilities were issued
 * - expiresAt: Expiration timestamp (capabilities have TTL)
 * - issuer: Control-plane component that issued capabilities
 * - grants: Array of explicit permission grants
 */
export class CapabilitySet {
  constructor(config) {
    const { capSetId, issuedAt, expiresAt, issuer, grants } = config;

    // INVARIANT: All required fields must be present (fail-closed)
    if (!capSetId || !issuedAt || !expiresAt || !issuer) {
      throw new Error('CapabilitySet: Missing required fields (capSetId, issuedAt, expiresAt, issuer)');
    }

    if (!Array.isArray(grants)) {
      throw new Error('CapabilitySet: grants must be an array');
    }

    // INVARIANT: Capabilities must have reasonable TTL (not expired, not too far future)
    const now = Date.now();
    if (issuedAt > now + 60000) { // Allow 1min clock skew
      throw new Error('CapabilitySet: issuedAt is in the future');
    }

    if (expiresAt <= now) {
      throw new Error('CapabilitySet: Capabilities are expired');
    }

    // Store immutable fields
    this._capSetId = capSetId;
    this._issuedAt = issuedAt;
    this._expiresAt = expiresAt;
    this._issuer = issuer;
    this._grants = Object.freeze(grants.map(g => Object.freeze({ ...g })));

    // Freeze the entire object
    Object.freeze(this);

    logger.debug({
      capSetId: this._capSetId,
      issuer: this._issuer,
      grantCount: this._grants.length,
      expiresAt: new Date(this._expiresAt).toISOString(),
    }, 'CapabilitySet created');
  }

  /**
   * Get capability set ID
   */
  get capSetId() {
    return this._capSetId;
  }

  /**
   * Get issuer
   */
  get issuer() {
    return this._issuer;
  }

  /**
   * Get grants (immutable)
   */
  get grants() {
    return this._grants;
  }

  /**
   * Check if capabilities are expired
   */
  isExpired() {
    return Date.now() >= this._expiresAt;
  }

  /**
   * Find a matching grant for the given action and target
   * 
   * @param {string} action - Action from CapabilityAction enum
   * @param {string} target - Target resource/tool name
   * @returns {Object|null} Matching grant or null
   */
  findGrant(action, target) {
    // INVARIANT: Expired capabilities cannot grant anything
    if (this.isExpired()) {
      return null;
    }

    // Find exact match (action + target)
    return this._grants.find(g => g.action === action && g.target === target) || null;
  }

  /**
   * Safe serialization (for logging)
   */
  toJSON() {
    return {
      capSetId: this._capSetId,
      issuer: this._issuer,
      grantCount: this._grants.length,
      expiresAt: new Date(this._expiresAt).toISOString(),
    };
  }
}

/**
 * Evaluate authorization for a specific action
 * 
 * SECURITY: This is the single authoritative enforcement point
 * 
 * @param {CapabilitySet|null} capabilities - Session capabilities
 * @param {string} action - Action from CapabilityAction enum
 * @param {string} target - Target resource/tool name
 * @param {Object} context - Additional context for logging
 * @returns {Object} { allowed: boolean, reason: string, grant: Object|null }
 */
export function evaluateCapability(capabilities, action, target, context = {}) {
  // INVARIANT: Unknown actions are denied (closed enum enforcement)
  if (!Object.values(CapabilityAction).includes(action)) {
    logger.warn({ action, target }, 'Authorization: Unknown action (denied)');
    return {
      allowed: false,
      reason: AuthzReason.DENIED_UNKNOWN_ACTION,
      grant: null,
    };
  }

  // INVARIANT: No capabilities = deny (default deny)
  if (!capabilities) {
    logger.debug({ action, target }, 'Authorization: No capabilities (denied)');
    return {
      allowed: false,
      reason: AuthzReason.DENIED_NO_CAPABILITY,
      grant: null,
    };
  }

  // INVARIANT: Expired capabilities = deny
  if (capabilities.isExpired()) {
    logger.warn({ action, target, capSetId: capabilities.capSetId }, 'Authorization: Capabilities expired (denied)');
    return {
      allowed: false,
      reason: AuthzReason.DENIED_EXPIRED,
      grant: null,
    };
  }

  // Find matching grant
  const grant = capabilities.findGrant(action, target);

  if (!grant) {
    // No explicit grant = deny (default deny)
    logger.debug({
      action,
      target,
      capSetId: capabilities.capSetId,
    }, 'Authorization: No matching grant (denied)');

    return {
      allowed: false,
      reason: AuthzReason.DENIED_NO_GRANT,
      grant: null,
    };
  }

  // Grant found = allow
  logger.debug({
    action,
    target,
    capSetId: capabilities.capSetId,
  }, 'Authorization: Grant found (allowed)');

  return {
    allowed: true,
    reason: AuthzReason.ALLOWED,
    grant,
  };
}

/**
 * Load capabilities from control-plane environment
 * 
 * Control-plane must provide:
 * - MCP_CAPABILITIES: JSON string with capability set
 * 
 * Format:
 * {
 *   "capSetId": "cap-abc-123",
 *   "issuer": "trusted-launcher",
 *   "grants": [
 *     { "action": "tool.invoke", "target": "list_tables" },
 *     { "action": "tool.invoke", "target": "query_read" }
 *   ]
 * }
 * 
 * @returns {CapabilitySet|null} Capability set or null if not provided
 * @throws {Error} If capabilities are malformed
 */
export function loadCapabilitiesFromEnv() {
  const capJson = process.env.MCP_CAPABILITIES;

  // SECURITY: If no capabilities provided, return null (default deny will apply)
  if (!capJson) {
    logger.info('Control-plane capabilities not provided (MCP_CAPABILITIES not set)');
    return null;
  }

  try {
    const config = JSON.parse(capJson);

    // Set default timestamps if not provided by control-plane
    const now = Date.now();
    const issuedAt = config.issuedAt || now;
    const expiresAt = config.expiresAt || now + 3600000; // Default 1 hour TTL

    const capSet = new CapabilitySet({
      capSetId: config.capSetId,
      issuedAt,
      expiresAt,
      issuer: config.issuer || 'env',
      grants: config.grants || [],
    });

    logger.info({
      capSetId: capSet.capSetId,
      issuer: capSet.issuer,
      grantCount: capSet.grants.length,
    }, 'Capabilities loaded from control-plane');

    return capSet;
  } catch (error) {
    // INVARIANT: Malformed capabilities = fail closed
    logger.fatal({ error: error.message }, 'FATAL: Malformed capabilities (fail-closed)');
    throw new Error(`Failed to load capabilities: ${error.message}`);
  }
}

/**
 * Create a default capability set for development/testing
 * WARNING: Only use in non-production environments
 * 
 * @returns {CapabilitySet} Full-access capability set
 */
export function createDefaultCapabilities() {
  const now = Date.now();

  return new CapabilitySet({
    capSetId: 'default-dev',
    issuedAt: now,
    expiresAt: now + 86400000, // 24 hours
    issuer: 'dev-default',
    grants: [
      { action: CapabilityAction.TOOL_LIST, target: '*' },
      { action: CapabilityAction.TOOL_INVOKE, target: 'list_tables' },
      { action: CapabilityAction.TOOL_INVOKE, target: 'describe_table' },
      { action: CapabilityAction.TOOL_INVOKE, target: 'query_read' },
    ],
  });
}

export default {
  CapabilityAction,
  AuthzReason,
  CapabilitySet,
  evaluateCapability,
  loadCapabilitiesFromEnv,
  createDefaultCapabilities,
};
