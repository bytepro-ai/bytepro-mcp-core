import { z } from 'zod';
import { logger, auditLog } from '../utils/logger.js';
import { adapterRegistry } from '../adapters/adapterRegistry.js';
import * as responseFormatter from './responseFormatter.js';

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
  }

  /**
   * Initialize the tool registry and register all tools
   * @param {Server} server - MCP server instance
   */
  async initialize(server) {
    this.server = server;

    // Register all available tools
    this.registerTool(listTablesTool);
    this.registerTool(describeTableTool);
    this.registerTool(queryReadTool);

    logger.info({ tools: Array.from(this.tools.keys()) }, 'Tool registry initialized');
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
   * @returns {Array} List of tool definitions
   */
  listTools() {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: this.zodToJsonSchema(tool.inputSchema),
    }));
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
      // Get tool
      const tool = this.tools.get(name);

      if (!tool) {
        throw new Error(`Tool "${name}" not found`);
      }

      // Validate input
      const validationResult = tool.inputSchema.safeParse(args);

      if (!validationResult.success) {
        const errors = validationResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');

        auditLog({
          action: name,
          adapter: 'n/a',
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

      // Execute tool
      const result = await tool.handler(validationResult.data, adapter);

      // Log audit
      auditLog({
        action: name,
        adapter: adapter.name,
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
      // Log audit
      auditLog({
        action: name,
        adapter: adapterRegistry.activeAdapter?.name || 'unknown',
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
