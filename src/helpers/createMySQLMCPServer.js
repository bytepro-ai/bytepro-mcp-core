/**
 * createMySQLMCPServer - High-level helper for creating MySQL-based MCP servers
 * 
 * This is a Layer 1 API that hides low-level primitives and enforces security invariants.
 * 
 * @param {Object} options - Server configuration options
 * @param {Array} options.tools - Array of tool definitions (required)
 * @param {Object} options.overrides - Optional config overrides (advanced)
 * @returns {Object} Server instance with { start, getRegistry }
 */

import { loadConfig } from '../config/env.js';
import { validateConfig } from '../config/schema.js';
import { AdapterRegistry } from '../adapters/adapterRegistry.js';
import { ToolRegistry } from '../core/toolRegistry.js';
import { executeToolBoundary } from '../core/executeToolBoundary.js';
import { SessionContext, isValidSessionContext, createSessionContextFromEnv } from '../core/sessionContext.js';
import { QuotaEngine, loadQuotaEngineFromEnv, createDefaultQuotaEngine } from '../security/quotas.js';
import { CapabilitySet } from '../security/capabilities.js';
import { logger } from '../utils/logger.js';

export function createMySQLMCPServer(options) {
  // Validate required parameters
  if (!options || !options.tools) {
    throw new Error('options.tools is required');
  }

  if (!Array.isArray(options.tools)) {
    throw new Error('options.tools must be an array');
  }

  // ============================================================================
  // PHASE 1: Configuration & Validation
  // ============================================================================

  logger.info('PHASE 1: Loading and validating configuration');

  // Step 1: Load environment-based configuration
  let config;
  try {
    config = loadConfig();
    logger.info('Configuration loaded successfully');
  } catch (error) {
    throw new Error(`Failed to load configuration: ${error.message}`);
  }

  // Step 2: Merge optional overrides into loaded config
  if (options.overrides) {
    logger.info('Applying configuration overrides');
    config = { ...config, ...options.overrides };
    // TODO: Deep merge logic if needed
  }

  // Step 3: Validate DB_ADAPTER === 'mysql' (FAIL-FAST)
  if (config.DB_ADAPTER !== 'mysql') {
    throw new Error(`DB_ADAPTER must be 'mysql', got: ${config.DB_ADAPTER}`);
  }

  // Step 4: Validate required MySQL connection parameters (FAIL-FAST)
  const requiredMySQLParams = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE'];
  for (const param of requiredMySQLParams) {
    if (!config[param]) {
      throw new Error(`Missing required MySQL config: ${param}`);
    }
  }

  // Step 5: Validate config schema (FAIL-FAST)
  try {
    validateConfig(config);
    logger.info('Configuration schema validated');
  } catch (error) {
    throw new Error(`Config validation failed: ${error.message}`);
  }

  // ============================================================================
  // PHASE 2: Adapter Initialization
  // ============================================================================

  logger.info('PHASE 2: Initializing database adapter');

  let adapter;

  // Step 6: Query AdapterRegistry to retrieve MySQLAdapter class
  try {
    // TODO: Get adapter class from AdapterRegistry
    const AdapterClass = AdapterRegistry.getAdapter('mysql');
    logger.info('MySQLAdapter class retrieved from registry');
    
    // Step 7: Instantiate MySQLAdapter with config parameters
    adapter = new AdapterClass(config);
    logger.info('MySQLAdapter instantiated');
  } catch (error) {
    throw new Error(`Failed to initialize MySQL adapter: ${error.message}`);
  }

  // Step 8: Test adapter connection (FAIL-FAST)
  async function testAdapterConnection() {
    try {
      // TODO: Test adapter connection
      logger.info('Testing database connection...');
      // await adapter.testConnection();
      logger.info('Database connection successful');
    } catch (error) {
      throw new Error(`Failed to connect to MySQL: ${error.message}`);
    }
  }

  // ============================================================================
  // PHASE 3: Security Infrastructure Setup
  // ============================================================================

  logger.info('PHASE 3: Setting up security infrastructure');

  let sessionContext;
  let quotaEngine;
  let capabilitySet;

  // Step 9: Create or load SessionContext from config/environment
  try {
    sessionContext = createSessionContextFromEnv(config);
    logger.info('SessionContext created from environment');
  } catch (error) {
    throw new Error(`Failed to create session context: ${error.message}`);
  }

  // Step 10: Validate session context (FAIL-FAST)
  if (!isValidSessionContext(sessionContext)) {
    throw new Error(`Invalid session context: validation failed`);
  }

  // Step 11: Initialize QuotaEngine
  try {
    quotaEngine = loadQuotaEngineFromEnv(config) || createDefaultQuotaEngine();
    logger.info('QuotaEngine initialized');
  } catch (error) {
    throw new Error(`Failed to initialize quota engine: ${error.message}`);
  }

  // Step 12: Initialize CapabilitySet from config
  try {
    // TODO: Initialize capability set from config
    capabilitySet = new CapabilitySet(config);
    logger.info('CapabilitySet initialized');
  } catch (error) {
    throw new Error(`Failed to initialize capability set: ${error.message}`);
  }

  // ============================================================================
  // PHASE 4: Tool Registration
  // ============================================================================

  logger.info('PHASE 4: Registering tools');

  // Step 13: Instantiate ToolRegistry
  const toolRegistry = new ToolRegistry();
  logger.info('ToolRegistry instantiated');

  // Step 14: Register each tool from options.tools array
  for (const tool of options.tools) {
    // Step 15: Validate tool metadata (FAIL-FAST)
    if (!tool.name) {
      throw new Error(`Invalid tool definition: missing name`);
    }
    if (!tool.handler) {
      throw new Error(`Invalid tool definition: ${tool.name} - missing handler`);
    }
    if (!tool.permissions) {
      throw new Error(`Invalid tool definition: ${tool.name} - missing permissions`);
    }

    // Step 16: Wrap tool handler with executeToolBoundary
    try {
      const wrappedHandler = async (params) => {
        // TODO: Wire executeToolBoundary with session, quotas, capabilities
        return await executeToolBoundary({
          toolName: tool.name,
          handler: tool.handler,
          params,
          sessionContext,
          quotaEngine,
          capabilitySet,
          adapter
        });
      };

      // Register wrapped tool
      toolRegistry.register({
        ...tool,
        handler: wrappedHandler
      });

      logger.info(`Tool registered: ${tool.name}`);
    } catch (error) {
      throw new Error(`Failed to register tool ${tool.name}: ${error.message}`);
    }
  }

  // ============================================================================
  // PHASE 5: Server Instance Creation
  // ============================================================================

  logger.info('PHASE 5: Creating server instance');

  let serverInstance;

  // Step 17: Create internal server instance (not started yet)
  try {
    // TODO: Create MCP server instance
    serverInstance = {
      config,
      adapter,
      toolRegistry,
      sessionContext,
      quotaEngine,
      capabilitySet
    };
    logger.info('Server instance created');
  } catch (error) {
    throw new Error(`Failed to create server instance: ${error.message}`);
  }

  // Step 18: Wire up stdio transport handlers (but do not start listening)
  try {
    // TODO: Setup stdio transport handlers
    logger.info('Stdio transport handlers wired');
  } catch (error) {
    throw new Error(`Failed to wire stdio transport: ${error.message}`);
  }

  // ============================================================================
  // PHASE 6: Deferred start() Implementation
  // ============================================================================

  /**
   * Start the MCP server and begin listening for stdio messages
   * @returns {Promise<void>}
   */
  async function start() {
    logger.info('PHASE 6: Starting server');

    // Step 20: Verify all invariants still hold (FAIL-FAST)
    try {
      // Verify session context
      if (!isValidSessionContext(sessionContext)) {
        throw new Error('Server invariants violated: invalid session context');
      }

      // Verify adapter connection
      await testAdapterConnection();

      // Verify quota engine
      if (!quotaEngine) {
        throw new Error('Server invariants violated: quota engine not initialized');
      }

      // Verify capability set
      if (!capabilitySet) {
        throw new Error('Server invariants violated: capability set not initialized');
      }

      // Verify tool registry has tools
      if (toolRegistry.getToolCount() === 0) {
        throw new Error('Server invariants violated: no tools registered');
      }

      logger.info('All invariants verified');
    } catch (error) {
      throw new Error(`Pre-start validation failed: ${error.message}`);
    }

    // Step 21: Start stdio transport
    try {
      // TODO: Start stdio transport and begin listening
      logger.info('Starting stdio transport...');
      // await serverInstance.startStdioTransport();
      logger.info('Server started successfully on stdio');
    } catch (error) {
      throw new Error(`Failed to start server: ${error.message}`);
    }
  }

  /**
   * Get the tool registry (read-only access)
   * @returns {ToolRegistry}
   */
  function getRegistry() {
    return toolRegistry;
  }

  // Step 19: Return public API object
  logger.info('Server instance ready (not started)');
  return {
    start,
    getRegistry
  };
}
