import crypto from 'crypto';
import { logger } from '../utils/logger.js';

// SECURITY: WeakSet to track valid SessionContext instances
// This prevents duck-typing attacks where a fake object mimics the interface
const validInstances = new WeakSet();

// BLOCK 2: WeakMaps to store capabilities externally (allows attachment after freeze)
const capabilitiesMap = new WeakMap();
const capabilitiesAttachedMap = new WeakMap();

// BLOCK 3: WeakMap to store quota engine externally (allows attachment after freeze)
const quotaEngineMap = new WeakMap();
const quotaEngineAttachedMap = new WeakMap();

/**
 * SessionContext: Immutable identity and tenant binding for MCP sessions
 * 
 * Security Invariants:
 * 1. Context is bound exactly once per session (UNBOUND -> BOUND transition only)
 * 2. Identity and tenant are immutable after binding
 * 3. No client-supplied data can influence binding
 * 4. All data-plane operations MUST verify context is bound
 * 5. Fail-closed: missing or invalid binding terminates session
 */
export class SessionContext {
  constructor() {
    // Session state: UNBOUND -> BOUND (immutable transition)
    this._state = 'UNBOUND';
    
    // Immutable binding fields (null until bound)
    this._identity = null;
    this._tenant = null;
    this._boundAt = null;
    this._sessionId = null;
    
    // Register this instance as valid
    validInstances.add(this);
    
    // Prevent extension and modification after construction
    Object.preventExtensions(this);
  }

  /**
   * Bind identity and tenant to this session (one-time operation)
   * 
   * @param {string} identity - Verified identity (from control plane)
   * @param {string} tenant - Verified tenant (from control plane)
   * @param {string} sessionId - Unique session identifier
   * @throws {Error} If binding fails validation or state is already BOUND
   */
  bind(identity, tenant, sessionId) {
    // INVARIANT: Bind exactly once (prevent rebinding)
    if (this._state === 'BOUND') {
      const error = new Error('SessionContext: Attempted to rebind an already-bound session (immutability violation)');
      logger.fatal({
        state: this._state,
        existingIdentity: this._identity,
        existingTenant: this._tenant,
        attemptedIdentity: identity,
        attemptedTenant: tenant,
      }, 'SECURITY VIOLATION: Session rebinding attempt');
      throw error;
    }

    // INVARIANT: Fail-closed on missing identity or tenant
    if (!identity || typeof identity !== 'string' || identity.trim().length === 0) {
      const error = new Error('SessionContext: Invalid identity (must be non-empty string)');
      logger.error({ identity }, 'Session binding failed: invalid identity');
      throw error;
    }

    if (!tenant || typeof tenant !== 'string' || tenant.trim().length === 0) {
      const error = new Error('SessionContext: Invalid tenant (must be non-empty string)');
      logger.error({ tenant }, 'Session binding failed: invalid tenant');
      throw error;
    }

    if (!sessionId || typeof sessionId !== 'string') {
      const error = new Error('SessionContext: Invalid sessionId (must be non-empty string)');
      logger.error({ sessionId }, 'Session binding failed: invalid sessionId');
      throw error;
    }

    // Perform binding (state transition)
    this._identity = identity.trim();
    this._tenant = tenant.trim();
    this._sessionId = sessionId;
    this._boundAt = Date.now();
    this._state = 'BOUND';

    // Make binding properties read-only
    Object.freeze(this);

    logger.info({
      identity: this._identity,
      tenant: this._tenant,
      sessionId: this._sessionId,
      boundAt: this._boundAt,
    }, 'SessionContext: Successfully bound');
  }

  /**
   * Assert that session is bound (defensive check for data-plane operations)
   * 
   * SECURITY: All data-plane operations MUST call this before proceeding
   * 
   * @throws {Error} If session is not bound
   */
  assertBound() {
    if (this._state !== 'BOUND') {
      const error = new Error('SessionContext: Operation attempted on unbound session (fail-closed)');
      logger.error({ state: this._state }, 'SECURITY VIOLATION: Unbound session operation');
      throw error;
    }
  }

  /**
   * Get identity (read-only)
   * 
   * @returns {string} Bound identity
   * @throws {Error} If session is not bound
   */
  get identity() {
    this.assertBound();
    return this._identity;
  }

  /**
   * Get tenant (read-only)
   * 
   * @returns {string} Bound tenant
   * @throws {Error} If session is not bound
   */
  get tenant() {
    this.assertBound();
    return this._tenant;
  }

  /**
   * Get session ID (read-only)
   * 
   * @returns {string} Session identifier
   * @throws {Error} If session is not bound
   */
  get sessionId() {
    this.assertBound();
    return this._sessionId;
  }

  /**
   * Get binding timestamp (read-only)
   * 
   * @returns {number} Unix timestamp when session was bound
   * @throws {Error} If session is not bound
   */
  get boundAt() {
    this.assertBound();
    return this._boundAt;
  }

  /**
   * Check if session is bound
   * 
   * @returns {boolean} True if session is bound
   */
  get isBound() {
    return this._state === 'BOUND';
  }

  /**
   * Get session state
   * 
   * @returns {string} Session state ('UNBOUND' or 'BOUND')
   */
  get state() {
    return this._state;
  }

  /**
   * BLOCK 2: Attach capabilities to this session (one-time operation)
   * 
   * SECURITY: Capabilities must be attached after binding and before any tool execution
   * 
   * @param {CapabilitySet|null} capabilities - Capability set from control-plane
   * @throws {Error} If capabilities already attached or session not bound
   */
  attachCapabilities(capabilities) {
    // INVARIANT: Session must be bound before attaching capabilities
    if (this._state !== 'BOUND') {
      throw new Error('SessionContext: Cannot attach capabilities to unbound session');
    }

    // INVARIANT: Attach exactly once (prevent re-attachment)
    if (capabilitiesAttachedMap.get(this)) {
      throw new Error('SessionContext: Capabilities already attached (immutability violation)');
    }

    // Store capabilities externally (allows attachment after freeze)
    capabilitiesMap.set(this, capabilities);
    capabilitiesAttachedMap.set(this, true);

    logger.info({
      sessionId: this._sessionId,
      hasCapabilities: !!capabilities,
      capSetId: capabilities?.capSetId,
      grantCount: capabilities?.grants?.length || 0,
    }, 'SessionContext: Capabilities attached');
  }

  /**
   * BLOCK 3: Attach quota engine to this session (one-time operation)
   * 
   * SECURITY: Quota engine must be attached after binding and before any tool execution
   * 
   * @param {QuotaEngine} quotaEngine - Quota engine from control-plane
   * @throws {Error} If quota engine already attached or session not bound
   */
  attachQuotaEngine(quotaEngine) {
    // INVARIANT: Session must be bound before attaching quota engine
    if (this._state !== 'BOUND') {
      throw new Error('SessionContext: Cannot attach quota engine to unbound session');
    }

    // INVARIANT: Attach exactly once (prevent re-attachment)
    if (quotaEngineAttachedMap.get(this)) {
      throw new Error('SessionContext: Quota engine already attached (immutability violation)');
    }

    // Store quota engine externally (allows attachment after freeze)
    quotaEngineMap.set(this, quotaEngine);
    quotaEngineAttachedMap.set(this, true);

    logger.info({
      sessionId: this._sessionId,
      hasQuotaEngine: !!quotaEngine,
    }, 'SessionContext: Quota engine attached');
  }

  /**
   * BLOCK 3: Get quota engine (read-only)
   * 
   * @returns {QuotaEngine|null} Quota engine or null
   * @throws {Error} If session is not bound or quota engine not attached
   */
  get quotaEngine() {
    this.assertBound();

    // INVARIANT: Quota engine must be explicitly attached before access
    if (!quotaEngineAttachedMap.get(this)) {
      throw new Error('SessionContext: Quota engine not yet attached');
    }

    return quotaEngineMap.get(this) || null;
  }

  /**
   * BLOCK 3: Check if quota engine is attached
   * 
   * @returns {boolean} True if quota engine is attached
   */
  get hasQuotaEngine() {
    return !!quotaEngineAttachedMap.get(this);
  }

  /**
   * BLOCK 2: Get capabilities (read-only)
   * 
   * @returns {CapabilitySet|null} Capability set or null
   * @throws {Error} If session is not bound or capabilities not attached
   */
  get capabilities() {
    this.assertBound();

    // INVARIANT: Capabilities must be explicitly attached before access
    if (!capabilitiesAttachedMap.get(this)) {
      throw new Error('SessionContext: Capabilities not yet attached');
    }

    return capabilitiesMap.get(this) || null;
  }

  /**
   * BLOCK 2: Check if capabilities are attached
   * 
   * @returns {boolean} True if capabilities are attached
   */
  get hasCapabilities() {
    return !!capabilitiesAttachedMap.get(this);
  }

  /**
   * Get safe context summary (for logging, excludes sensitive data)
   * 
   * @returns {Object} Context summary
   */
  toJSON() {
    if (this._state === 'UNBOUND') {
      return { state: 'UNBOUND' };
    }

    const summary = {
      state: this._state,
      identity: this._identity,
      tenant: this._tenant,
      sessionId: this._sessionId,
      boundAt: this._boundAt,
    };

    // BLOCK 2: Include capability summary if attached
    if (capabilitiesAttachedMap.get(this)) {
      const caps = capabilitiesMap.get(this);
      summary.capabilities = caps?.toJSON() || null;
    }

    // BLOCK 3: Include quota engine status if attached
    if (quotaEngineAttachedMap.get(this)) {
      summary.quotaEngine = { attached: true };
    }

    return summary;
  }
}

/**
 * Create a session context from control-plane environment variables
 * 
 * Control plane MUST provide:
 * - MCP_SESSION_IDENTITY: Verified identity from trusted launcher
 * - MCP_SESSION_TENANT: Verified tenant from trusted launcher
 * 
 * @returns {SessionContext} Initialized and bound session context
 * @throws {Error} If binding material is missing or invalid (fail-closed)
 */
export function createSessionContextFromEnv() {
  const identity = process.env.MCP_SESSION_IDENTITY;
  const tenant = process.env.MCP_SESSION_TENANT;

  // INVARIANT: Fail-closed if control-plane binding is missing
  if (!identity || !tenant) {
    logger.fatal({
      hasIdentity: !!identity,
      hasTenant: !!tenant,
    }, 'FATAL: Control-plane binding missing (MCP_SESSION_IDENTITY or MCP_SESSION_TENANT not set)');
    
    throw new Error(
      'Control-plane binding failed: MCP_SESSION_IDENTITY and MCP_SESSION_TENANT must be set by trusted launcher'
    );
  }

  // Generate unique session ID
  const sessionId = crypto.randomBytes(16).toString('hex');

  // Create and bind context
  const context = new SessionContext();
  context.bind(identity, tenant, sessionId);

  return context;
}

/**
 * Verify if an object is a valid SessionContext instance created by this module
 * 
 * @param {Object} context - Object to verify
 * @returns {boolean} True if valid
 */
export function isValidSessionContext(context) {
  return validInstances.has(context);
}

export default SessionContext;
