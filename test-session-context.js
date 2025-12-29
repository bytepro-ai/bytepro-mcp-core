/**
 * Test Suite: Session Context Implementation
 * Validates Block 1: Identity & Tenant Binding
 * 
 * Tests:
 * 1. SessionContext creation and binding
 * 2. Immutability enforcement
 * 3. Fail-closed behavior
 * 4. Integration with server initialization
 */

import { strict as assert } from 'assert';
import { SessionContext, createSessionContextFromEnv } from './src/core/sessionContext.js';

console.log('=== Session Context Test Suite ===\n');

// Test 1: Basic SessionContext creation and binding
function testSessionContextBinding() {
  console.log('Test 1: SessionContext binding');
  
  const context = new SessionContext();
  assert.equal(context.state, 'UNBOUND', 'Initial state should be UNBOUND');
  assert.equal(context.isBound, false, 'isBound should be false initially');
  
  // Bind identity and tenant
  context.bind('user@example.com', 'tenant-abc-123', 'session-xyz-789');
  
  assert.equal(context.state, 'BOUND', 'State should be BOUND after binding');
  assert.equal(context.isBound, true, 'isBound should be true after binding');
  assert.equal(context.identity, 'user@example.com', 'Identity should match');
  assert.equal(context.tenant, 'tenant-abc-123', 'Tenant should match');
  assert.equal(context.sessionId, 'session-xyz-789', 'SessionId should match');
  assert.ok(context.boundAt > 0, 'boundAt should be set');
  
  console.log('✅ PASS: Basic binding works\n');
}

// Test 2: Immutability enforcement (cannot rebind)
function testImmutability() {
  console.log('Test 2: Immutability enforcement');
  
  const context = new SessionContext();
  context.bind('user1@example.com', 'tenant-1', 'session-1');
  
  // Attempt to rebind should throw
  try {
    context.bind('user2@example.com', 'tenant-2', 'session-2');
    assert.fail('Should have thrown on rebind attempt');
  } catch (error) {
    assert.ok(error.message.includes('rebind'), 'Should indicate rebinding violation');
    console.log('✅ PASS: Rebinding blocked');
  }
  
  // Verify original binding unchanged
  assert.equal(context.identity, 'user1@example.com', 'Identity should be unchanged');
  assert.equal(context.tenant, 'tenant-1', 'Tenant should be unchanged');
  
  // Attempt to modify frozen object should fail silently (or throw in strict mode)
  try {
    context._identity = 'hacker@evil.com';
    // In non-strict mode, this silently fails; in strict mode, it throws
  } catch (error) {
    // Expected in strict mode
  }
  
  assert.equal(context.identity, 'user1@example.com', 'Identity should remain immutable');
  
  console.log('✅ PASS: Immutability enforced\n');
}

// Test 3: Fail-closed on invalid inputs
function testFailClosed() {
  console.log('Test 3: Fail-closed on invalid inputs');
  
  // Empty identity
  try {
    const ctx1 = new SessionContext();
    ctx1.bind('', 'tenant-1', 'session-1');
    assert.fail('Should reject empty identity');
  } catch (error) {
    assert.ok(error.message.includes('Invalid identity'), 'Should reject empty identity');
    console.log('✅ PASS: Empty identity rejected');
  }
  
  // Empty tenant
  try {
    const ctx2 = new SessionContext();
    ctx2.bind('user@example.com', '', 'session-1');
    assert.fail('Should reject empty tenant');
  } catch (error) {
    assert.ok(error.message.includes('Invalid tenant'), 'Should reject empty tenant');
    console.log('✅ PASS: Empty tenant rejected');
  }
  
  // Null identity
  try {
    const ctx3 = new SessionContext();
    ctx3.bind(null, 'tenant-1', 'session-1');
    assert.fail('Should reject null identity');
  } catch (error) {
    assert.ok(error.message.includes('Invalid identity'), 'Should reject null identity');
    console.log('✅ PASS: Null identity rejected');
  }
  
  // Whitespace-only identity
  try {
    const ctx4 = new SessionContext();
    ctx4.bind('   ', 'tenant-1', 'session-1');
    assert.fail('Should reject whitespace-only identity');
  } catch (error) {
    assert.ok(error.message.includes('Invalid identity'), 'Should reject whitespace identity');
    console.log('✅ PASS: Whitespace-only identity rejected');
  }
  
  console.log('✅ PASS: All invalid inputs rejected (fail-closed)\n');
}

// Test 4: assertBound enforcement
function testAssertBound() {
  console.log('Test 4: assertBound enforcement');
  
  const context = new SessionContext();
  
  // Accessing properties before binding should throw
  try {
    const identity = context.identity;
    assert.fail('Should throw on unbound identity access');
  } catch (error) {
    assert.ok(error.message.includes('unbound'), 'Should indicate unbound session');
    console.log('✅ PASS: Unbound identity access blocked');
  }
  
  try {
    const tenant = context.tenant;
    assert.fail('Should throw on unbound tenant access');
  } catch (error) {
    assert.ok(error.message.includes('unbound'), 'Should indicate unbound session');
    console.log('✅ PASS: Unbound tenant access blocked');
  }
  
  // After binding, access should work
  context.bind('user@example.com', 'tenant-1', 'session-1');
  assert.doesNotThrow(() => context.identity, 'Identity access should work after binding');
  assert.doesNotThrow(() => context.tenant, 'Tenant access should work after binding');
  
  console.log('✅ PASS: assertBound works correctly\n');
}

// Test 5: Environment-based binding
function testEnvBinding() {
  console.log('Test 5: Environment-based binding');
  
  // Save original env
  const originalIdentity = process.env.MCP_SESSION_IDENTITY;
  const originalTenant = process.env.MCP_SESSION_TENANT;
  
  // Set test env vars
  process.env.MCP_SESSION_IDENTITY = 'test-user@example.com';
  process.env.MCP_SESSION_TENANT = 'test-tenant-123';
  
  try {
    const context = createSessionContextFromEnv();
    assert.equal(context.isBound, true, 'Context should be bound from env');
    assert.equal(context.identity, 'test-user@example.com', 'Identity from env');
    assert.equal(context.tenant, 'test-tenant-123', 'Tenant from env');
    assert.ok(context.sessionId, 'SessionId should be generated');
    
    console.log('✅ PASS: Environment binding works');
  } finally {
    // Restore original env
    if (originalIdentity) {
      process.env.MCP_SESSION_IDENTITY = originalIdentity;
    } else {
      delete process.env.MCP_SESSION_IDENTITY;
    }
    if (originalTenant) {
      process.env.MCP_SESSION_TENANT = originalTenant;
    } else {
      delete process.env.MCP_SESSION_TENANT;
    }
  }
  
  console.log('');
}

// Test 6: Fail-closed on missing environment binding
function testMissingEnvBinding() {
  console.log('Test 6: Fail-closed on missing environment binding');
  
  // Save original env
  const originalIdentity = process.env.MCP_SESSION_IDENTITY;
  const originalTenant = process.env.MCP_SESSION_TENANT;
  
  // Remove env vars
  delete process.env.MCP_SESSION_IDENTITY;
  delete process.env.MCP_SESSION_TENANT;
  
  try {
    createSessionContextFromEnv();
    assert.fail('Should fail when env vars are missing');
  } catch (error) {
    assert.ok(
      error.message.includes('Control-plane binding failed'),
      'Should indicate control-plane binding failure'
    );
    console.log('✅ PASS: Missing env vars cause fail-closed behavior');
  } finally {
    // Restore original env
    if (originalIdentity) {
      process.env.MCP_SESSION_IDENTITY = originalIdentity;
    }
    if (originalTenant) {
      process.env.MCP_SESSION_TENANT = originalTenant;
    }
  }
  
  console.log('');
}

// Test 7: toJSON (safe serialization)
function testSafeSerialization() {
  console.log('Test 7: Safe serialization');
  
  const context = new SessionContext();
  
  // Unbound serialization
  const unboundJSON = context.toJSON();
  assert.equal(unboundJSON.state, 'UNBOUND', 'Unbound state serialized');
  assert.equal(unboundJSON.identity, undefined, 'No identity when unbound');
  
  // Bound serialization
  context.bind('user@example.com', 'tenant-1', 'session-1');
  const boundJSON = context.toJSON();
  assert.equal(boundJSON.state, 'BOUND', 'Bound state serialized');
  assert.equal(boundJSON.identity, 'user@example.com', 'Identity serialized');
  assert.equal(boundJSON.tenant, 'tenant-1', 'Tenant serialized');
  assert.equal(boundJSON.sessionId, 'session-1', 'SessionId serialized');
  
  console.log('✅ PASS: Safe serialization works\n');
}

// Run all tests
try {
  testSessionContextBinding();
  testImmutability();
  testFailClosed();
  testAssertBound();
  testEnvBinding();
  testMissingEnvBinding();
  testSafeSerialization();
  
  console.log('=== ✅ ALL TESTS PASSED ===');
  process.exit(0);
} catch (error) {
  console.error('\n=== ❌ TEST FAILED ===');
  console.error(error);
  process.exit(1);
}
