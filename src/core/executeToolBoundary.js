import { isValidSessionContext } from './sessionContext.js';
import { CapabilityAction, evaluateCapability } from '../security/capabilities.js';
import { auditLog } from '../utils/logger.js';
import { extractTables } from '../security/queryValidator.js';

/**
 * Internal canonical execution boundary
 * Separates control-plane enforcement from tool execution
 * 
 * @param {Object} request - Execution request
 * @returns {Promise<Object>} Execution response
 */
export async function executeToolBoundary(request) {
  const {
    toolName,
    input,
    sessionContext,
    toolRegistry,
    adapters,
    mode,
    meta
  } = request;

  const startTime = meta?.nowMs || Date.now();

  // 1. Fail-closed on missing/invalid SessionContext
  if (!sessionContext || !sessionContext.isBound) {
    return {
      ok: false,
      error: {
        code: 'SESSION_CONTEXT_INVALID',
        message: 'Session context must be bound'
      }
    };
  }

  if (!isValidSessionContext(sessionContext)) {
    return {
      ok: false,
      error: {
        code: 'SESSION_CONTEXT_INVALID',
        message: 'Invalid session context instance'
      }
    };
  }

  // 2. Tool Lookup
  const tool = toolRegistry.tools.get(toolName);

  if (!tool) {
    return {
      ok: false,
      error: {
        code: 'TOOL_NOT_FOUND',
        message: `Tool "${toolName}" not found`
      }
    };
  }

  // 3. Read-only enforcement
  if (mode?.readOnly) {
    return {
      ok: false,
      error: {
        code: 'READ_ONLY',
        message: 'Write operations are not allowed in read-only mode'
      }
    };
  }

  // 4. Authorization
  const authzResult = evaluateCapability(
    sessionContext.capabilities,
    CapabilityAction.TOOL_INVOKE,
    toolName,
    {
      identity: sessionContext.identity,
      tenant: sessionContext.tenant,
      sessionId: sessionContext.sessionId,
    }
  );

  auditLog({
    action: 'authz',
    tool: toolName,
    identity: sessionContext.identity,
    tenant: sessionContext.tenant,
    decision: authzResult.allowed ? 'ALLOW' : 'DENY',
    reason: authzResult.reason,
    capSetId: sessionContext.capabilities?.capSetId,
    duration: Date.now() - startTime,
    outcome: authzResult.allowed ? 'success' : 'denied',
  });

  if (!authzResult.allowed) {
    return {
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Insufficient permissions to invoke this tool',
        details: { tool: toolName }
      }
    };
  }

  // 5. Quota
  let quotaSemaphoreKey = null;
  
  if (sessionContext.hasQuotaEngine) {
    const quotaEngine = sessionContext.quotaEngine;
    
    const quotaResult = quotaEngine.checkAndReserve({
      tenant: sessionContext.tenant,
      identity: sessionContext.identity,
      sessionId: sessionContext.sessionId,
      capSetId: sessionContext.capabilities?.capSetId,
      action: CapabilityAction.TOOL_INVOKE,
      target: toolName,
    });

    auditLog({
      action: 'quota',
      tool: toolName,
      identity: sessionContext.identity,
      tenant: sessionContext.tenant,
      decision: quotaResult.allowed ? 'ALLOW' : 'DENY',
      reason: quotaResult.reason,
      duration: Date.now() - startTime,
      outcome: quotaResult.allowed ? 'success' : 'denied',
    });

    if (!quotaResult.allowed) {
      return {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Request denied by quota policy',
          details: { 
            tool: toolName,
            reason: quotaResult.reason,
          }
        }
      };
    }

    if (quotaResult.allowed) {
      quotaSemaphoreKey = quotaResult.semaphoreKey;
    }
  }



  // 6. Input Validation
  const validationResult = tool.inputSchema.safeParse(input);

  if (!validationResult.success) {
    const errors = validationResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');

    auditLog({
      action: toolName,
      adapter: 'n/a',
      identity: sessionContext.identity,
      tenant: sessionContext.tenant,
      input: input,
      duration: Date.now() - startTime,
      outcome: 'error',
      error: `Validation failed: ${errors}`,
    });

    if (sessionContext.hasQuotaEngine && quotaSemaphoreKey) {
      sessionContext.quotaEngine.release(quotaSemaphoreKey);
    }

    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
        details: { errors }
      }
    };
  }

  // 6.5. DB Policy Enforcement (if policy engine attached)
  if (sessionContext.policyEngine && validationResult.data.query) {
    try {
      // Extract table names from the query
      const tables = extractTables(validationResult.data.query);

      // Enforce DB policy if tables were extracted
      if (tables && tables.length > 0) {
        // Determine role from capabilities or use a default
        const role = sessionContext.capabilities?.role || 'default';

        await sessionContext.policyEngine.assertAllowed({
          tenant: sessionContext.tenant,
          role: role,
          tables: tables,
          now: Date.now(),
        });

        auditLog({
          action: 'db_policy',
          tool: toolName,
          identity: sessionContext.identity,
          tenant: sessionContext.tenant,
          tables: tables,
          role: role,
          decision: 'ALLOW',
          duration: Date.now() - startTime,
          outcome: 'success',
        });
      }
    } catch (error) {
      auditLog({
        action: 'db_policy',
        tool: toolName,
        identity: sessionContext.identity,
        tenant: sessionContext.tenant,
        decision: 'DENY',
        reason: error.code,
        duration: Date.now() - startTime,
        outcome: 'denied',
      });

      if (sessionContext.hasQuotaEngine && quotaSemaphoreKey) {
        sessionContext.quotaEngine.release(quotaSemaphoreKey);
      }

      // Handle POLICY_DENIED errors gracefully
      if (error.code === 'POLICY_DENIED') {
        return {
          ok: false,
          error: {
            code: 'POLICY_DENIED',
            message: error.message,
            details: error.details,
          }
        };
      }

      // Re-throw unexpected errors
      throw error;
    }
  }

  // 7. Execution
  try {
    const adapter = adapters.getAdapter();
    
    const result = await tool.handler(validationResult.data, adapter, sessionContext);

    auditLog({
      action: toolName,
      adapter: adapter.name,
      identity: sessionContext.identity,
      tenant: sessionContext.tenant,
      input: validationResult.data,
      duration: Date.now() - startTime,
      outcome: 'success',
    });

    return {
      ok: true,
      toolName,
      value: result,
      meta: {
        adapter: adapter.name
      }
    };

  } catch (error) {
    auditLog({
      action: toolName,
      adapter: adapters.activeAdapter?.name || 'unknown',
      identity: sessionContext?.identity || 'unknown',
      tenant: sessionContext?.tenant || 'unknown',
      input: input,
      duration: Date.now() - startTime,
      outcome: 'error',
      error: error.message,
    });

    return {
      ok: false,
      error: {
        code: 'ADAPTER_FAILURE',
        message: error.message,
        originalError: error
      }
    };
  } finally {
    if (sessionContext.hasQuotaEngine && quotaSemaphoreKey) {
      sessionContext.quotaEngine.release(quotaSemaphoreKey);
    }
  }
}
