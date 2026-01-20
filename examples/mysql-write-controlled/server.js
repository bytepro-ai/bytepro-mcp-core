import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from '../../src/utils/logger.js';
import { adapterRegistry } from '../../src/adapters/adapterRegistry.js';
import { createSessionContextFromEnv } from '../../src/core/sessionContext.js';
import { loadCapabilitiesFromEnv } from '../../src/security/capabilities.js';
import { loadQuotaEngineFromEnv } from '../../src/security/quotas.js';
import * as responseFormatter from '../../src/core/responseFormatter.js';
import { executeToolBoundary } from '../../src/core/executeToolBoundary.js';
import { ToolRegistry } from '../../src/core/toolRegistry.js';

// Import write-enabled tool
import { addCustomerTool } from './tools/addCustomer.js';

/**
 * Write-Enabled MCP Server Example
 * 
 * OPERATOR RESPONSIBILITY:
 * - This example demonstrates tool-level write capability
 * - Write safety is NOT a core library guarantee
 * - You are responsible for credential isolation, monitoring, and security review
 * 
 * Uses canonical execution boundary - no reimplementation.
 */
class WriteEnabledMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'bytepro-mcp-write-example',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.sessionContext = null;
    this.toolRegistry = new ToolRegistry();
  }

  async initialize() {
    logger.info('Initializing write-enabled MCP server example');

    // Connect to MySQL (Sakila)
    await adapterRegistry.initialize();

    // Create session context from environment
    this.sessionContext = createSessionContextFromEnv();

    // Load capabilities from environment
    const capabilities = loadCapabilitiesFromEnv();
    if (capabilities) {
      this.sessionContext.attachCapabilities(capabilities);
      logger.info(
        { capSetId: capabilities.capSetId, grants: capabilities.grants.length },
        'Capabilities attached'
      );
    }

    // Load quota engine from environment
    const quotaEngine = loadQuotaEngineFromEnv(
      this.sessionContext.tenant,
      this.sessionContext.identity
    );
    if (quotaEngine) {
      this.sessionContext.attachQuotaEngine(quotaEngine);
      logger.info('Quota engine attached');
    }

    // Initialize tool registry with session context
    // NOTE: We're creating a custom registry instance, not using the singleton
    await this.toolRegistry.initialize(this.server, this.sessionContext);

    // Register write-enabled tool
    this.toolRegistry.registerTool(addCustomerTool);
    logger.info({ tool: 'add_customer' }, 'Write-enabled tool registered');

    this.registerHandlers();

    logger.info('Write-enabled MCP server example initialized');
  }

  registerHandlers() {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.toolRegistry.listTools();
      logger.debug({ count: tools.length }, 'List tools request');
      return { tools };
    });

    // Call tool handler - uses canonical execution boundary
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      logger.info({ tool: name, arguments: args }, 'Tool call request');

      // SECURITY: Use canonical execution boundary (no bypass)
      const result = await executeToolBoundary({
        toolName: name,
        input: args || {},
        sessionContext: this.sessionContext,
        toolRegistry: this.toolRegistry,
        adapters: adapterRegistry,
        mode: { readOnly: false }, // Allow writes
        meta: { 
          requestId: request.params._meta?.requestId,
        },
      });

      // Handle boundary response
      if (!result.ok) {
        const errorResponse = responseFormatter.error({
          code: result.error.code,
          message: result.error.message,
          details: result.error.details,
        });

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

      // Success response
      const successResponse = responseFormatter.success({
        data: result.value,
        meta: {
          tool: name,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(successResponse, null, 2),
          },
        ],
      };
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    logger.info('Write-enabled MCP server example running on stdio');
  }
}

// Initialize and start server
const server = new WriteEnabledMCPServer();

await server.initialize();
await server.start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await adapterRegistry.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down');
  await adapterRegistry.disconnect();
  process.exit(0);
});
