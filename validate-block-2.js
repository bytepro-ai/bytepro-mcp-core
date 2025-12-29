import assert from 'assert';
import { SessionContext } from './src/core/sessionContext.js';
import { CapabilitySet, CapabilityAction } from './src/security/capabilities.js';
import { ToolRegistry } from './src/core/toolRegistry.js';
import { PostgresAdapter } from './src/adapters/postgres.js';

// Mock server for ToolRegistry
const mockServer = {};

async function runValidation() {
  console.log('=== Block 2 Security Validation ===\n');
  let failures = 0;

  // --- Scenario 1: Tool execution without capability ---
  try {
    console.log('Scenario 1: Tool execution without capability');
    const ctx = new SessionContext();
    ctx.bind('user', 'tenant', 'session-1');
    
    // Grant only tool.list, NOT tool.invoke
    const caps = new CapabilitySet({
      capSetId: 'cap-1',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      issuer: 'test',
      grants: [{ action: CapabilityAction.TOOL_LIST, target: '*' }]
    });
    ctx.attachCapabilities(caps);

    const registry = new ToolRegistry();
    await registry.initialize(mockServer, ctx);

    const result = await registry.executeTool('list_tables', {});
    
    if (result.isError && result.content[0].text.includes('AUTHORIZATION_DENIED')) {
      console.log('✅ PASS: Tool execution denied as expected');
    } else {
      console.error('❌ FAIL: Tool execution was not denied correctly');
      console.error('Result:', JSON.stringify(result, null, 2));
      failures++;
    }
  } catch (err) {
    console.error('❌ FAIL: Unexpected error in Scenario 1:', err);
    failures++;
  }
  console.log('');

  // --- Scenario 2: Fake SessionContext (Duck Typing) ---
  try {
    console.log('Scenario 2: Fake SessionContext (Duck Typing)');
    const fakeCtx = {
      isBound: true,
      identity: 'admin',
      tenant: 'admin-tenant',
      sessionId: 'fake-session',
      hasCapabilities: true,
      capabilities: {
        grants: [{ action: CapabilityAction.TOOL_INVOKE, target: '*' }]
      }
    };

    const registry = new ToolRegistry();
    try {
      await registry.initialize(mockServer, fakeCtx);
      console.error('❌ FAIL: ToolRegistry accepted fake context');
      failures++;
    } catch (err) {
      if (err.message.includes('SECURITY VIOLATION: Invalid session context instance')) {
        console.log('✅ PASS: Fake context rejected by ToolRegistry');
      } else {
        console.error('❌ FAIL: Unexpected error message:', err.message);
        failures++;
      }
    }
  } catch (err) {
    console.error('❌ FAIL: Unexpected error in Scenario 2:', err);
    failures++;
  }
  console.log('');

  // --- Scenario 3: Mutated SessionContext ---
  try {
    console.log('Scenario 3: Mutated SessionContext');
    const ctx = new SessionContext();
    ctx.bind('user', 'tenant', 'session-3');
    
    // Try to overwrite capabilities property
    try {
      Object.defineProperty(ctx, 'capabilities', {
        value: { grants: [] }
      });
      console.error('❌ FAIL: Successfully redefined capabilities property');
      failures++;
    } catch (err) {
      console.log('✅ PASS: Failed to redefine capabilities property (Object.freeze/preventExtensions)');
    }

    // Try to attach capabilities twice
    const caps = new CapabilitySet({
      capSetId: 'cap-3',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      issuer: 'test',
      grants: []
    });
    
    ctx.attachCapabilities(caps);
    
    try {
      ctx.attachCapabilities(caps);
      console.error('❌ FAIL: Successfully attached capabilities twice');
      failures++;
    } catch (err) {
      if (err.message.includes('Capabilities already attached')) {
        console.log('✅ PASS: Re-attachment rejected');
      } else {
        console.error('❌ FAIL: Unexpected error on re-attachment:', err.message);
        failures++;
      }
    }
  } catch (err) {
    console.error('❌ FAIL: Unexpected error in Scenario 3:', err);
    failures++;
  }
  console.log('');

  // --- Scenario 4: Adapter Bypass ---
  try {
    console.log('Scenario 4: Adapter Bypass');
    const adapter = new PostgresAdapter({});
    const fakeCtx = {
      isBound: true,
      identity: 'admin',
      tenant: 'admin-tenant'
    };

    try {
      await adapter.listTables({}, fakeCtx);
      console.error('❌ FAIL: Adapter accepted fake context');
      failures++;
    } catch (err) {
      if (err.message.includes('SECURITY VIOLATION: Invalid session context instance')) {
        console.log('✅ PASS: Adapter rejected fake context');
      } else {
        // It might fail with "Adapter called without bound session context" if isBound check comes first and fails differently?
        // But fakeCtx has isBound: true.
        console.error('❌ FAIL: Unexpected error message:', err.message);
        failures++;
      }
    }
  } catch (err) {
    console.error('❌ FAIL: Unexpected error in Scenario 4:', err);
    failures++;
  }
  console.log('');

  // --- Scenario 5: Confused Deputy / Ambiguity ---
  try {
    console.log('Scenario 5: Confused Deputy / Ambiguity');
    const ctx = new SessionContext();
    ctx.bind('user', 'tenant', 'session-5');
    
    // Grant tool.list on * (wildcard)
    // But try to invoke tool.invoke on list_tables
    // This tests that wildcard on one action doesn't bleed to another
    const caps = new CapabilitySet({
      capSetId: 'cap-5',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      issuer: 'test',
      grants: [{ action: CapabilityAction.TOOL_LIST, target: '*' }]
    });
    ctx.attachCapabilities(caps);

    const registry = new ToolRegistry();
    await registry.initialize(mockServer, ctx);

    const result = await registry.executeTool('list_tables', {});
    
    if (result.isError && result.content[0].text.includes('AUTHORIZATION_DENIED')) {
      console.log('✅ PASS: Wildcard on different action did not grant access');
    } else {
      console.error('❌ FAIL: Wildcard leaked permissions');
      console.error('Result:', JSON.stringify(result, null, 2));
      failures++;
    }
  } catch (err) {
    console.error('❌ FAIL: Unexpected error in Scenario 5:', err);
    failures++;
  }
  console.log('');

  if (failures > 0) {
    console.error(`\n❌ Validation FAILED with ${failures} errors`);
    process.exit(1);
  } else {
    console.log('\n✅ Validation PASSED');
    process.exit(0);
  }
}

runValidation();
