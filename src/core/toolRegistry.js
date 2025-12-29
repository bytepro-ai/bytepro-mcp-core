import { z } from 'zod';
import { logger, auditLog } from '../utils/logger.js';
import { adapterRegistry } from '../adapters/adapterRegistry.js';
import * as responseFormatter from './responseFormatter.js';
import { isValidSessionContext } from './sessionContext.js';
import { CapabilityAction, evaluateCapability } from '../security/capabilities.js';
import { QuotaDenialReason } from '../security/quotas.js';

// Import tools
import { listTablesTool } from '../tools/listTables.js';
import { describeTableTool } from '../tools/describeTable.js';
import { queryReadTool } from '../tools/queryRead.js';

/**
 * Tool registry for managing and executing MCP tools
 * Validates inputs, enforces security, and routes to adapters
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.server = null;
    // SECURITY: Session context injected at initialization (immutable)
    this.sessionContext = null;
  }

  /**
   * Initialize the tool registry and register all tools
   * @param {Server} server - MCP server instance
   * @param {SessionContext} sessionContext - Bound session context (immutable)
   */
  async initialize(server, sessionContext) {
    this.server = server;
    
    // SECURITY: Assert session context is bound before proceeding
    if (!sessionContext || !sessionContext.isBound) {
      throw new Error('ToolRegistry: Session context must be bound before initialization');
    }

    // SECURITY: Verify session context is genuine
    if (!isValidSessionContext(sessionContext)) {
      throw new Error('SECURITY VIOLATION: Invalid session context instance');
    }
    
    this.sessionContext = sessionContext;

    // Register all available tools
    this.registerTool(listTablesTool);
    this.registerTool(describeTableTool);
    this.registerTool(queryReadTool);

    logger.info({
      tools: Array.from(this.tools.keys()),
      identity: this.sessionContext.identity,
      tenant: this.sessionContext.tenant,
    }, 'Tool registry initialized with session context');
  }

  /**
   * Register a tool
   * @param {Object} tool - Tool configuration
   * @param {string} tool.name - Tool name
   * @param {string} tool.description - Tool description
   * @param {Object} tool.inputSchema - Zod schema for input validation
   * @param {Function} tool.handler - Tool handler function
   */
  registerTool(tool) {
    const { name, description, inputSchema, handler } = tool;

    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }

    this.tools.set(name, {
      name,
      description,
      inputSchema,
      handler,
    });

    logger.debug({ tool: name }, 'Tool registered');
  }

  /**
   * List all registered tools in MCP format
   * 
   * BLOCK 2: Respects capabilities - only lists tools the session is authorized to invoke
   * 
   * @returns {Array} List of tool definitions
   */
  listTools() {
    // Get all tool definitions
    const allTools = Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: this.zodToJsonSchema(tool.inputSchema),
    }));

    // BLOCK 2: Filter tools based on capabilities (if attached)
    if (this.sessionContext && this.sessionContext.hasCapabilities) {
      const capabilities = this.sessionContext.capabilities;
      
      // Only include tools that have explicit grants
      const authorizedTools = allTools.filter((tool) => {
        const authzResult = evaluateCapability(
          capabilities,
          CapabilityAction.TOOL_INVOKE,
          tool.name
        );
        return authzResult.allowed;
      });

      logger.debug({
        totalTools: allTools.length,
        authorizedTools: authorizedTools.length,
      }, 'Tool list filtered by capabilities');

      return authorizedTools;
    }

    // If no capabilities attached (shouldn't happen in normal flow), return empty list (default deny)
    logger.warn('listTools called without capabilities attached (default deny)');
    return [];
  }

  /**
   * Execute a tool
   * @param {string} name - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<Object>} Tool execution result
   */
  async executeTool(name, args) {
    const startTime = Date.now();

    try {
      // SECURITY: Defensive assertion - session MUST be bound for data-plane ops
      if (!this.sessionContext || !this.sessionContext.isBound) {
        throw new Error('SECURITY VIOLATION: Tool execution attempted without bound session context');
      }

      // SECURITY: Verify session context is genuine
      if (!isValidSessionContext(this.sessionContext)) {
        throw new Error('SECURITY VIOLATION: Invalid session context instance');
      }

      // SECURITY: Validate tool exists FIRST (before any authorization or audit state)
      // This prevents invalid tool names from creating authorization decisions or audit logs
      const tool = this.tools.get(name);

      if (!tool) {
        throw new Error(`Tool "${name}" not found`);
      }

      // BLOCK 2: AUTHORIZATION CHECK (after tool validation)
      // This is the primary enforcement point for capability-based authorization
      const authzResult = evaluateCapability(
        this.sessionContext.capabilities,
        CapabilityAction.TOOL_INVOKE,
        name,
        {
          identity: this.sessionContext.identity,
          tenant: this.sessionContext.tenant,
          sessionId: this.sessionContext.sessionId,
        }
      );

      // Log authorization decision (audit)
      auditLog({
        action: 'authz',
        tool: name,
        identity: this.sessionContext.identity,
        tenant: this.sessionContext.tenant,
        decision: authzResult.allowed ? 'ALLOW' : 'DENY',
        reason: authzResult.reason,
        capSetId: this.sessionContext.capabilities?.capSetId,
        duration: Date.now() - startTime,
        outcome: authzResult.allowed ? 'success' : 'denied',
      });

      // INVARIANT: Fail-closed - if not authorized, do NOT proceed
      if (!authzResult.allowed) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                responseFormatter.error({
                  code: 'AUTHORIZATION_DENIED',
                  message: 'Insufficient permissions to invoke this tool',
                  details: { tool: name },
                }),
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // Authorization passed - proceed with tool execution

      // BLOCK 3: QUOTA CHECK (after authorization, before validation/execution)
      // This is the primary enforcement point for quota/rate limiting
      let quotaSemaphoreKey = null;
      
      if (this.sessionContext.hasQuotaEngine) {
        const quotaEngine = this.sessionContext.quotaEngine;
        
        const quotaResult = quotaEngine.checkAndReserve({
          tenant: this.sessionContext.tenant,
          identity: this.sessionContext.identity,
          sessionId: this.sessionContext.sessionId,
          capSetId: this.sessionContext.capabilities?.capSetId,
          action: CapabilityAction.TOOL_INVOKE,
          target: name,
        });

        // Log quota decision (audit)
        auditLog({
          action: 'quota',
          tool: name,
          identity: this.sessionContext.identity,
          tenant: this.sessionContext.tenant,
          decision: quotaResult.allowed ? 'ALLOW' : 'DENY',
          reason: quotaResult.reason,
          duration: Date.now() - startTime,
          outcome: quotaResult.allowed ? 'success' : 'denied',
        });

        // INVARIANT: Fail-closed - if quota exceeded or error, do NOT proceed
        if (!quotaResult.allowed) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  responseFormatter.error({
                    code: 'RATE_LIMITED',
                    message: 'Request denied by quota policy',
                    details: { 
                      tool: name,
                      reason: quotaResult.reason,
                    },
                  }),
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        if (quotaResult.allowed) {
          quotaSemaphoreKey = quotaResult.semaphoreKey;
        }
      }

      // Validate input
      const validationResult = tool.inputSchema.safeParse(args);

      if (!validationResult.success) {
        const errors = validationResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');

        auditLog({
          action: name,
          adapter: 'n/a',
          identity: this.sessionContext.identity,
          tenant: this.sessionContext.tenant,
          input: args,
          duration: Date.now() - startTime,
          outcome: 'error',
          error: `Validation failed: ${errors}`,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                responseFormatter.error({
                  code: responseFormatter.ErrorCodes.VALIDATION_ERROR,
                  message: 'Invalid input',
                  details: { errors },
                }),
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // Get adapter
      const adapter = adapterRegistry.getAdapter();

      // SECURITY: Inject session context into adapter execution
      // Execute tool with bound context (identity + tenant)
      let result;
      try {
        result = await tool.handler(validationResult.data, adapter, this.sessionContext);
      } finally {
        // BLOCK 3: Always release concurrency slot in finally block (prevent leaks)
        if (this.sessionContext.hasQuotaEngine && quotaSemaphoreKey) {
          this.sessionContext.quotaEngine.release(quotaSemaphoreKey);
        }
      }

      // Log audit with identity and tenant
      auditLog({
        action: name,
        adapter: adapter.name,
        identity: this.sessionContext.identity,
        tenant: this.sessionContext.tenant,
        input: validationResult.data,
        duration: Date.now() - startTime,
        outcome: 'success',
      });

      // Format response
      const response = responseFormatter.success({
        data: result,
        meta: {
          tool: name,
          adapter: adapter.name,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (error) {
      // Log audit with session context
      auditLog({
        action: name,
        adapter: adapterRegistry.activeAdapter?.name || 'unknown',
        identity: this.sessionContext?.identity || 'unknown',
        tenant: this.sessionContext?.tenant || 'unknown',
        input: args,
        duration: Date.now() - startTime,
        outcome: 'error',
        error: error.message,
      });

      // Format error response
      const errorResponse = responseFormatter.fromError(error);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(errorResponse, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Convert Zod schema to JSON Schema format for MCP
   * @param {ZodSchema} zodSchema - Zod schema
   * @returns {Object} JSON Schema
   */
  zodToJsonSchema(zodSchema) {
    // Simple conversion - can be enhanced with zod-to-json-schema package
    const shape = zodSchema._def.shape?.();

    if (!shape) {
      return {
        type: 'object',
        properties: {},
      };
    }

    const properties = {};
    const required = [];

    for (const [key, value] of Object.entries(shape)) {
      const typeName = value._def.typeName;

      // Basic type mapping
      if (typeName === 'ZodString') {
        properties[key] = {
          type: 'string',
          description: value._def.description || '',
        };
      } else if (typeName === 'ZodNumber') {
        properties[key] = {
          type: 'number',
          description: value._def.description || '',
        };
      } else if (typeName === 'ZodBoolean') {
        properties[key] = {
          type: 'boolean',
          description: value._def.description || '',
        };
      } else {
        properties[key] = {
          type: 'string',
          description: value._def.description || '',
        };
      }

      // Check if optional
      if (!value.isOptional()) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required,
    };
  }
}

// Export singleton instance
export const toolRegistry = new ToolRegistry();

export default toolRegistry;
