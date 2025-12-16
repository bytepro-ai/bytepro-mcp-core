#!/usr/bin/env node

/**
 * Simple test to verify MCP server can initialize
 * This tests the server setup without requiring a real database
 */

import { logger } from './src/utils/logger.js';

async function testServerInit() {
  try {
    logger.info('Testing MCP server initialization...');

    // Test 1: Import server module
    const { mcpServer } = await import('./src/core/server.js');
    logger.info('✅ Server module imported successfully');

    // Test 2: Check MCP SDK imports
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    logger.info('✅ MCP SDK imported successfully');

    // Test 3: Check tool registry
    const { toolRegistry } = await import('./src/core/toolRegistry.js');
    logger.info('✅ Tool registry imported successfully');

    // Test 4: Check adapter registry
    const { adapterRegistry } = await import('./src/adapters/adapterRegistry.js');
    logger.info('✅ Adapter registry imported successfully');
    logger.info({ adapters: adapterRegistry.listAdapters() }, 'Available adapters');

    logger.info('\n✅ All server components initialized successfully!');
    logger.info('\nNote: Full server startup requires a PostgreSQL connection.');
    logger.info('Configure .env with valid PostgreSQL credentials to run: npm run dev');

    process.exit(0);
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Server initialization test failed');
    process.exit(1);
  }
}

testServerInit();
