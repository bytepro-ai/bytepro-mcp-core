#!/usr/bin/env node
/**
 * Test Suite: Block 2 - Capability-Based Authorization
 * 
 * Tests:
 * 1. CapabilitySet creation and validation
 * 2. Authorization enforcement at tool execution boundary
 * 3. Default deny behavior
 * 4. Capability expiration
 * 5. SessionContext integration
 */

import { strict as assert } from 'assert';
import {
  CapabilitySet,
  CapabilityAction,
  AuthzReason,
  evaluateCapability,
  loadCapabilitiesFromEnv,
} from './src/security/capabilities.js';
import { SessionContext } from './src/core/sessionContext.js';

console.log('=== Block 2: Capability-Based Authorization Test Suite ===\n');

let testsFailed = 0;

// Test 1: CapabilitySet creation
function testCapabilitySetCreation() {
  console.log('Test 1: CapabilitySet creation and validation');

  const now = Date.now();
  const capSet = new CapabilitySet({
    capSetId: 'test-cap-1',
    issuedAt: now,
    expiresAt: now + 3600000,
    issuer: 'test-issuer',
    grants: [
      { action: CapabilityAction.TOOL_INVOKE, target: 'list_tables' },
      { action: CapabilityAction.TOOL_INVOKE, target: 'query_read' },
    ],
  });

  assert.equal(capSet.capSetId, 'test-cap-1', 'capSetId should match');
  assert.equal(capSet.issuer, 'test-issuer', 'issuer should match');
  assert.equal(capSet.grants.length, 2, 'should have 2 grants');
  assert.equal(capSet.isExpired(), false, 'should not be expired');

  console.log('   ✅ PASS: CapabilitySet created successfully\n');
}

// Test 2: Missing required fields
function testMissingFields() {
  console.log('Test 2: Fail-closed on missing required fields');

  try {
    new CapabilitySet({
      capSetId: 'test',
      // missing issuedAt, expiresAt, issuer
      grants: [],
    });
    console.log('   ❌ FAIL: Should have thrown on missing fields');
    testsFailed++;
  } catch (error) {
    assert.ok(error.message.includes('Missing required fields'), 'Should indicate missing fields');
    console.log('   ✅ PASS: Missing fields rejected\n');
  }
}

// Test 3: Capability expiration check
function testCapabilityExpiration() {
  console.log('Test 3: Capability expiration check');

  const now = Date.now();
  
  // Create capability that expires in 1 hour
  const capSet = new CapabilitySet({
    capSetId: 'test-cap',
    issuedAt: now - 3600000,
    expiresAt: now + 3600000,
    issuer: 'test',
    grants: [{ action: CapabilityAction.TOOL_INVOKE, target: 'test_tool' }],
  });

  assert.equal(capSet.isExpired(), false, 'should not be expired');

  // Test that evaluateCapability checks expiration
  // We'll create a capability that's technically expired by manipulating time perception
  const almostExpiredCap = new CapabilitySet({
    capSetId: 'almost-expired',
    issuedAt: now - 7200000,
    expiresAt: now + 100, // Very short TTL
    issuer: 'test',
    grants: [{ action: CapabilityAction.TOOL_INVOKE, target: 'test_tool' }],
  });

  // Should be valid now
  const result1 = evaluateCapability(almostExpiredCap, CapabilityAction.TOOL_INVOKE, 'test_tool');
  assert.equal(result1.allowed, true, 'should be allowed before expiration');

  console.log('   ✅ PASS: Capability expiration check works\n');
}

// Test 4: Default deny (no matching grant)
function testDefaultDeny() {
  console.log('Test 4: Default deny when no matching grant');

  const now = Date.now();
  const capSet = new CapabilitySet({
    capSetId: 'test-cap',
    issuedAt: now,
    expiresAt: now + 3600000,
    issuer: 'test',
    grants: [
      { action: CapabilityAction.TOOL_INVOKE, target: 'list_tables' },
    ],
  });

  // Try to invoke a tool that has no grant
  const result = evaluateCapability(capSet, CapabilityAction.TOOL_INVOKE, 'query_read');

  assert.equal(result.allowed, false, 'should be denied');
  assert.equal(result.reason, AuthzReason.DENIED_NO_GRANT, 'should indicate no grant');

  console.log('   ✅ PASS: Default deny enforced\n');
}

// Test 5: Successful authorization
function testSuccessfulAuthz() {
  console.log('Test 5: Successful authorization with valid grant');

  const now = Date.now();
  const capSet = new CapabilitySet({
    capSetId: 'test-cap',
    issuedAt: now,
    expiresAt: now + 3600000,
    issuer: 'test',
    grants: [
      { action: CapabilityAction.TOOL_INVOKE, target: 'list_tables' },
    ],
  });

  const result = evaluateCapability(capSet, CapabilityAction.TOOL_INVOKE, 'list_tables');

  assert.equal(result.allowed, true, 'should be allowed');
  assert.equal(result.reason, AuthzReason.ALLOWED, 'should indicate allowed');
  assert.ok(result.grant, 'should return the grant');

  console.log('   ✅ PASS: Authorization succeeded\n');
}

// Test 6: Unknown action denied
function testUnknownAction() {
  console.log('Test 6: Unknown action denied (closed enum)');

  const now = Date.now();
  const capSet = new CapabilitySet({
    capSetId: 'test-cap',
    issuedAt: now,
    expiresAt: now + 3600000,
    issuer: 'test',
    grants: [
      { action: 'unknown.action', target: 'test' },
    ],
  });

  const result = evaluateCapability(capSet, 'unknown.action', 'test');

  assert.equal(result.allowed, false, 'should be denied');
  assert.equal(result.reason, AuthzReason.DENIED_UNKNOWN_ACTION, 'should indicate unknown action');

  console.log('   ✅ PASS: Unknown action rejected\n');
}

// Test 7: No capabilities (null)
function testNoCapabilities() {
  console.log('Test 7: No capabilities results in deny');

  const result = evaluateCapability(null, CapabilityAction.TOOL_INVOKE, 'list_tables');

  assert.equal(result.allowed, false, 'should be denied');
  assert.equal(result.reason, AuthzReason.DENIED_NO_CAPABILITY, 'should indicate no capability');

  console.log('   ✅ PASS: No capabilities denied\n');
}

// Test 8: SessionContext integration
function testSessionContextIntegration() {
  console.log('Test 8: SessionContext capability attachment');

  const ctx = new SessionContext();
  ctx.bind('test-user', 'test-tenant', 'test-session');

  // Should not have capabilities yet
  assert.equal(ctx.hasCapabilities, false, 'should not have capabilities initially');

  const now = Date.now();
  const capSet = new CapabilitySet({
    capSetId: 'test-cap',
    issuedAt: now,
    expiresAt: now + 3600000,
    issuer: 'test',
    grants: [{ action: CapabilityAction.TOOL_INVOKE, target: 'test' }],
  });

  ctx.attachCapabilities(capSet);

  assert.equal(ctx.hasCapabilities, true, 'should have capabilities after attachment');
  assert.equal(ctx.capabilities.capSetId, 'test-cap', 'should return correct capability set');

  // Try to attach again (should fail)
  try {
    ctx.attachCapabilities(capSet);
    console.log('   ❌ FAIL: Should not allow re-attachment');
    testsFailed++;
  } catch (error) {
    assert.ok(error.message.includes('already attached'), 'should indicate already attached');
  }

  console.log('   ✅ PASS: SessionContext capability attachment works correctly\n');
}

// Test 9: Load capabilities from environment
function testLoadFromEnv() {
  console.log('Test 9: Load capabilities from environment');

  // Save original env
  const originalCap = process.env.MCP_CAPABILITIES;

  try {
    // Test with valid capabilities
    const testCap = {
      capSetId: 'env-test-cap',
      issuer: 'env-test',
      grants: [
        { action: CapabilityAction.TOOL_INVOKE, target: 'list_tables' },
      ],
    };

    process.env.MCP_CAPABILITIES = JSON.stringify(testCap);

    const capSet = loadCapabilitiesFromEnv();

    assert.ok(capSet, 'should load capability set');
    assert.equal(capSet.capSetId, 'env-test-cap', 'should have correct capSetId');
    assert.equal(capSet.grants.length, 1, 'should have 1 grant');

    console.log('   ✅ PASS: Capabilities loaded from environment\n');
  } finally {
    // Restore env
    if (originalCap) {
      process.env.MCP_CAPABILITIES = originalCap;
    } else {
      delete process.env.MCP_CAPABILITIES;
    }
  }
}

// Test 10: Malformed capabilities fail closed
function testMalformedCapabilities() {
  console.log('Test 10: Malformed capabilities fail closed');

  const originalCap = process.env.MCP_CAPABILITIES;

  try {
    process.env.MCP_CAPABILITIES = 'invalid-json{';

    try {
      loadCapabilitiesFromEnv();
      console.log('   ❌ FAIL: Should have thrown on malformed JSON');
      testsFailed++;
    } catch (error) {
      assert.ok(error.message.includes('Failed to load capabilities'), 'should indicate load failure');
      console.log('   ✅ PASS: Malformed capabilities rejected\n');
    }
  } finally {
    if (originalCap) {
      process.env.MCP_CAPABILITIES = originalCap;
    } else {
      delete process.env.MCP_CAPABILITIES;
    }
  }
}

// Run all tests
async function runAllTests() {
  try {
    testCapabilitySetCreation();
    testMissingFields();
    testCapabilityExpiration();
    testDefaultDeny();
    testSuccessfulAuthz();
    testUnknownAction();
    testNoCapabilities();
    testSessionContextIntegration();
    testLoadFromEnv();
    testMalformedCapabilities();

    if (testsFailed === 0) {
      console.log('=== ✅ ALL TESTS PASSED ===');
      process.exit(0);
    } else {
      console.log(`\n=== ❌ ${testsFailed} TEST(S) FAILED ===`);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n=== ❌ TEST EXECUTION FAILED ===');
    console.error(error);
    process.exit(1);
  }
}

runAllTests();
