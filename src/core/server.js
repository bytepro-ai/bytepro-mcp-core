import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { adapterRegistry } from '../adapters/adapterRegistry.js';
import { toolRegistry } from './toolRegistry.js';

/**
 * MCP Server Core
 * Implements the Model Context Protocol server using official SDK
 */
class MCPServer {
  constructor() {
    this.server = null;
    this.transport = null;
    this.isRunning = false;
  }

  /**
   * Initialize the MCP server
   */
  async initialize() {
    try {
      logger.info('Initializing MCP server...');

      // Initialize database adapter
      await adapterRegistry.initializeAdapter('postgres', config.pg);

      // Create MCP server instance
      this.server = new Server(
        {
          name: config.app.name,
          version: config.app.version,
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      // Register MCP handlers
      this.registerHandlers();

      // Initialize tool registry
      await toolRegistry.initialize(this.server);

      logger.info(
        {
          name: config.app.name,
          version: config.app.version,
          tools: toolRegistry.listTools().length,
        },
        'MCP server initialized'
      );
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to initialize MCP server');
      throw error;
    }
  }

  /**
   * Register MCP protocol handlers
   */
  registerHandlers() {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = toolRegistry.listTools();
      logger.debug({ count: tools.length }, 'List tools request');
      return { tools };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      logger.info({ tool: name, arguments: args }, 'Tool call request');

      try {
        const result = await toolRegistry.executeTool(name, args || {});
        return result;
      } catch (error) {
        logger.error({ tool: name, error: error.message }, 'Tool execution failed');

        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });

    logger.debug('MCP handlers registered');
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start() {
    if (this.isRunning) {
      logger.warn('MCP server already running');
      return;
    }

    try {
      await this.initialize();

      // Create stdio transport
      this.transport = new StdioServerTransport();

      // Connect server to transport
      await this.server.connect(this.transport);

      this.isRunning = true;

      logger.info('MCP server started on stdio transport');

      // Keep process alive
      process.stdin.resume();
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to start MCP server');
      await this.shutdown();
      process.exit(1);
    }
  }

  /**
   * Shutdown the MCP server gracefully
   */
  async shutdown() {
    if (!this.isRunning) {
      return;
    }

    try {
      logger.info('Shutting down MCP server...');

      // Close server
      if (this.server) {
        await this.server.close();
      }

      // Shutdown adapter
      await adapterRegistry.shutdown();

      this.isRunning = false;

      logger.info('MCP server shutdown complete');
    } catch (error) {
      logger.error({ error: error.message }, 'Error during MCP server shutdown');
    }
  }
}

// Export singleton instance
export const mcpServer = new MCPServer();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  await mcpServer.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await mcpServer.shutdown();
  process.exit(0);
});

// Start server if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  mcpServer.start().catch((error) => {
    logger.fatal({ error: error.message }, 'Fatal error starting MCP server');
    process.exit(1);
  });
}

export default mcpServer;
