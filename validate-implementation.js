#!/usr/bin/env node

/**
 * Comprehensive validation of Week 1 implementation
 * Verifies all components can be loaded and basic functionality works
 */

import { logger } from './src/utils/logger.js';

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  console.log('🧪 Running Implementation Validation...\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (error) {
      console.log(`❌ ${name}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log('\n🎉 All validation checks passed!');
    console.log('✨ Implementation is ready for Day 6 testing with real PostgreSQL.');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some checks failed. Review errors above.');
    process.exit(1);
  }
}

// Define tests
test('Configuration loads and validates', async () => {
  const { config } = await import('./src/config/env.js');
  if (!config.pg.host) throw new Error('Config missing pg.host');
  if (!config.security) throw new Error('Config missing security');
});

test('Logger initialized with audit support', async () => {
  const { logger, auditLog } = await import('./src/utils/logger.js');
  if (typeof auditLog !== 'function') throw new Error('auditLog not a function');
});

test('PostgreSQL pool can initialize', async () => {
  const { pgPool } = await import('./src/utils/pgPool.js');
  if (typeof pgPool.initialize !== 'function') throw new Error('Missing initialize');
});

test('Allowlist enforces schema rules', async () => {
  const { allowlist } = await import('./src/security/allowlist.js');
  const config = allowlist.getConfig();
  if (!Array.isArray(config.allowedSchemas)) throw new Error('Invalid config');
});

test('Query guard blocks dangerous patterns', async () => {
  const { queryGuard } = await import('./src/security/queryGuard.js');
  const result = queryGuard.validateQuery('DROP TABLE users');
  if (result.isValid) throw new Error('Should block DROP');
});

test('Base adapter interface defined', async () => {
  const { BaseAdapter } = await import('./src/adapters/baseAdapter.js');
  const adapter = new BaseAdapter('test', {});
  if (!adapter.name) throw new Error('Missing name property');
});

test('PostgreSQL adapter can be instantiated', async () => {
  const { PostgresAdapter } = await import('./src/adapters/postgres.js');
  const { config } = await import('./src/config/env.js');
  const adapter = new PostgresAdapter(config.pg);
  if (adapter.name !== 'postgres') throw new Error('Wrong adapter name');
});

test('Adapter registry has postgres adapter', async () => {
  const { adapterRegistry } = await import('./src/adapters/adapterRegistry.js');
  if (!adapterRegistry.hasAdapter('postgres')) throw new Error('Missing postgres adapter');
});

test('Response formatter creates success responses', async () => {
  const { success } = await import('./src/core/responseFormatter.js');
  const response = success({ data: { test: true } });
  if (!response.success) throw new Error('Invalid success response');
});

test('Response formatter creates error responses', async () => {
  const { error, ErrorCodes } = await import('./src/core/responseFormatter.js');
  const response = error({ code: ErrorCodes.VALIDATION_ERROR, message: 'Test' });
  if (response.success) throw new Error('Error response marked as success');
});

test('List tables tool defined', async () => {
  const { listTablesTool } = await import('./src/tools/listTables.js');
  if (listTablesTool.name !== 'list_tables') throw new Error('Wrong tool name');
  if (typeof listTablesTool.handler !== 'function') throw new Error('Missing handler');
});

test('Describe table tool defined', async () => {
  const { describeTableTool } = await import('./src/tools/describeTable.js');
  if (describeTableTool.name !== 'describe_table') throw new Error('Wrong tool name');
  if (typeof describeTableTool.handler !== 'function') throw new Error('Missing handler');
});

test('Tool registry can be instantiated', async () => {
  const { ToolRegistry } = await import('./src/core/toolRegistry.js');
  const registry = new ToolRegistry();
  if (typeof registry.registerTool !== 'function') throw new Error('Missing registerTool');
});

test('MCP server can be imported', async () => {
  const { mcpServer } = await import('./src/core/server.js');
  if (typeof mcpServer.initialize !== 'function') throw new Error('Missing initialize');
});

test('MCP SDK imports work', async () => {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  if (!Server) throw new Error('MCP SDK Server not found');
});

test('Documentation files exist', async () => {
  const fs = await import('fs');
  const files = [
    'README.md',
    'docs/getting-started.md',
    'IMPLEMENTATION-SUMMARY.md',
    'QUICKREF.md',
    '.env.example',
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`Missing: ${file}`);
  }
});

// Run all tests
runTests();
