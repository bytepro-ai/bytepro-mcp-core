import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { adapterRegistry } from '../adapters/adapterRegistry.js';
import { toolRegistry } from './toolRegistry.js';
import { createSessionContextFromEnv } from './sessionContext.js';
import { loadCapabilitiesFromEnv } from '../security/capabilities.js';
import { loadQuotaEngineFromEnv } from '../security/quotas.js';
import * as responseFormatter from './responseFormatter.js';
import { executeToolBoundary } from './executeToolBoundary.js';

/**
 * MCP Server Core
 * Implements the Model Context Protocol server using official SDK
 */
class MCPServer {
  constructor() {
    this.server = null;
    this.transport = null;
    this.isRunning = false;
    // SECURITY: Session context bound once at initialization (immutable)
    this.sessionContext = null;
  }

  /**
   * Initialize the MCP server
   */
  async initialize() {
    try {
      logger.info('Initializing MCP server...');

      // Load and validate configuration
      const config = getConfig();

      // SECURITY: Bind session context FIRST (fail-closed if missing)
      // This MUST happen before any data-plane initialization
      try {
        this.sessionContext = createSessionContextFromEnv();
        logger.info({
          identity: this.sessionContext.identity,
          tenant: this.sessionContext.tenant,
          sessionId: this.sessionContext.sessionId,
        }, 'Session context bound');
      } catch (error) {
        logger.fatal({ error: error.message }, 'FATAL: Session context binding failed (terminating)');
        throw new Error(`Session binding failed: ${error.message}`);
      }

      // BLOCK 2: Attach capabilities AFTER binding, BEFORE tool initialization
      try {
        const capabilities = loadCapabilitiesFromEnv();
        this.sessionContext.attachCapabilities(capabilities);
        
        logger.info({
          sessionId: this.sessionContext.sessionId,
          hasCapabilities: !!capabilities,
          capSetId: capabilities?.capSetId,
          grantCount: capabilities?.grants?.length || 0,
        }, 'Capabilities attached to session');
      } catch (error) {
        logger.fatal({ error: error.message }, 'FATAL: Capability attachment failed (terminating)');
        throw new Error(`Capability attachment failed: ${error.message}`);
      }

      // BLOCK 3: Attach quota engine AFTER capabilities, BEFORE tool initialization
      try {
        const quotaEngine = loadQuotaEngineFromEnv();
        this.sessionContext.attachQuotaEngine(quotaEngine);
        
        logger.info({
          sessionId: this.sessionContext.sessionId,
          hasQuotaEngine: !!quotaEngine,
        }, 'Quota engine attached to session');
      } catch (error) {
        logger.fatal({ error: error.message }, 'FATAL: Quota engine attachment failed (terminating)');
        throw new Error(`Quota engine attachment failed: ${error.message}`);
      }

      // INVARIANT: At this point, sessionContext is immutably bound with capabilities and quotas
      // All subsequent operations inherit this context

      // Initialize database adapter (dynamic selection)
      const adapterName = config.adapter;
      const adapterConfig = config[adapterName];

      // SECURITY: Fail-closed validation of adapter selection
      if (!adapterName || typeof adapterName !== 'string') {
        throw new Error('Invalid adapter: config.adapter must be a non-empty string');
      }

      if (!adapterRegistry.hasAdapter(adapterName)) {
        const available = adapterRegistry.listAdapters().join(', ');
        throw new Error(`Unknown adapter "${adapterName}". Available adapters: ${available}`);
      }

      if (!adapterConfig || typeof adapterConfig !== 'object') {
        throw new Error(`Missing configuration for adapter "${adapterName}": config.${adapterName} is required`);
      }

      logger.info({ adapter: adapterName }, 'Database adapter selected');
      await adapterRegistry.initializeAdapter(adapterName, adapterConfig);

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
      await toolRegistry.initialize(this.server, this.sessionContext);

      logger.info(
        {
          name: config.app.name,
          version: config.app.version,
          tools: toolRegistry.listTools().length,
          session: this.sessionContext.toJSON(),
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

      // Use internal boundary for execution
      const result = await executeToolBoundary({
        toolName: name,
        input: args || {},
        sessionContext: this.sessionContext,
        toolRegistry: toolRegistry,
        adapters: adapterRegistry,
        mode: { readOnly: false }, // Default
        meta: { 
          requestId: request.params._meta?.requestId,
          nowMs: Date.now() 
        }
      });

      if (result.ok) {
        const response = responseFormatter.success({
          data: result.value,
          meta: {
            tool: name,
            adapter: result.meta?.adapter,
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
      } else {
        let code = result.error.code;
        if (code === 'UNAUTHORIZED') code = 'AUTHORIZATION_DENIED';
        
        if (result.error.originalError) {
             const errorResponse = responseFormatter.fromError(result.error.originalError);
             return { content: [{ type: 'text', text: JSON.stringify(errorResponse, null, 2) }], isError: true };
        }
        
        const errorResponse = responseFormatter.error({
            code: code,
            message: result.error.message,
            details: result.error.details
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
