#!/usr/bin/env node
/**
 * Validation Script for Block 1: Identity & Tenant Binding
 * 
 * Validates that all code is syntactically correct and imports successfully
 * without requiring a full database connection.
 */

console.log('=== Block 1 Implementation Validation ===\n');

// Set minimal required env vars for import validation
process.env.MCP_SESSION_IDENTITY = 'validation-user@example.com';
process.env.MCP_SESSION_TENANT = 'validation-tenant';
process.env.AUDIT_SECRET = 'a'.repeat(32); // Dummy 32-char secret for validation

let errors = 0;

// Test 1: SessionContext module
console.log('1. Validating sessionContext.js...');
try {
  const { SessionContext, createSessionContextFromEnv } = await import('./src/core/sessionContext.js');
  
  // Test basic functionality
  const ctx = new SessionContext();
  ctx.bind('test', 'test', 'test');
  if (!ctx.isBound) throw new Error('Binding failed');
  
  console.log('   ✅ sessionContext.js - OK\n');
} catch (error) {
  console.error('   ❌ sessionContext.js - FAILED:', error.message, '\n');
  errors++;
}

// Test 2: Server module (with context binding)
console.log('2. Validating server.js...');
try {
  await import('./src/core/server.js');
  console.log('   ✅ server.js - OK (imports successfully)\n');
} catch (error) {
  console.error('   ❌ server.js - FAILED:', error.message, '\n');
  errors++;
}

// Test 3: Tool Registry module
console.log('3. Validating toolRegistry.js...');
try {
  const { toolRegistry } = await import('./src/core/toolRegistry.js');
  if (!toolRegistry) throw new Error('toolRegistry not exported');
  console.log('   ✅ toolRegistry.js - OK\n');
} catch (error) {
  console.error('   ❌ toolRegistry.js - FAILED:', error.message, '\n');
  errors++;
}

// Test 4: Tool modules
console.log('4. Validating tool handlers...');
try {
  await import('./src/tools/listTables.js');
  await import('./src/tools/describeTable.js');
  await import('./src/tools/queryRead.js');
  console.log('   ✅ All tool handlers - OK\n');
} catch (error) {
  console.error('   ❌ Tool handlers - FAILED:', error.message, '\n');
  errors++;
}

// Test 5: Adapter modules
console.log('5. Validating adapters...');
try {
  await import('./src/adapters/baseAdapter.js');
  await import('./src/adapters/postgres.js');
  console.log('   ✅ All adapters - OK\n');
} catch (error) {
  console.error('   ❌ Adapters - FAILED:', error.message, '\n');
  errors++;
}

// Summary
console.log('=== Validation Summary ===');
if (errors === 0) {
  console.log('✅ ALL MODULES VALIDATED SUCCESSFULLY\n');
  console.log('Block 1 implementation is syntactically correct and ready for integration testing.\n');
  console.log('Next steps:');
  console.log('  1. Set MCP_SESSION_IDENTITY and MCP_SESSION_TENANT environment variables');
  console.log('  2. Set database connection environment variables (PG_HOST, PG_USER, etc.)');
  console.log('  3. Start the MCP server: node src/core/server.js');
  process.exit(0);
} else {
  console.error(`❌ ${errors} VALIDATION ERROR(S)\n`);
  console.error('Please fix the errors above before proceeding.\n');
  process.exit(1);
}
