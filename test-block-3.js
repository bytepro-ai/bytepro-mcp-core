import assert from 'assert';
import { SessionContext } from './src/core/sessionContext.js';
import { CapabilitySet, CapabilityAction } from './src/security/capabilities.js';
import { QuotaPolicy, QuotaEngine, QuotaDimension, QuotaDenialReason, createDefaultQuotaEngine } from './src/security/quotas.js';

console.log('=== Block 3: Quota & Rate Limiting Test Suite ===\n');

// --- Test 1: QuotaPolicy creation ---
function testQuotaPolicyCreation() {
  console.log('Test 1: QuotaPolicy creation and validation');

  const policy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: 'user@example.com',
    capSetId: 'cap-abc',
    limits: {
      [QuotaDimension.RATE_PER_MINUTE]: 60,
      [QuotaDimension.CONCURRENCY]: 5,
    },
  });

  assert.equal(policy.tenant, 'tenant-123');
  assert.equal(policy.identity, 'user@example.com');
  assert.equal(policy.getLimit(QuotaDimension.RATE_PER_MINUTE), 60);
  assert.equal(policy.getLimit(QuotaDimension.CONCURRENCY), 5);
  assert.equal(policy.getLimit(QuotaDimension.COST_PER_MINUTE), null);

  console.log('   ✅ PASS: QuotaPolicy created successfully\n');
}

// --- Test 2: QuotaEngine with missing policy ---
function testMissingPolicy() {
  console.log('Test 2: Quota check with missing policy (fail-closed)');

  const engine = new QuotaEngine([]); // No policies

  const result = engine.checkAndReserve({
    tenant: 'tenant-123',
    identity: 'user@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read',
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, QuotaDenialReason.POLICY_MISSING);

  console.log('   ✅ PASS: Missing policy results in denial\n');
}

// --- Test 3: Rate limiting enforcement ---
function testRateLimiting() {
  console.log('Test 3: Rate limiting enforcement');

  const policy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: null,
    capSetId: null,
    limits: {
      [QuotaDimension.RATE_PER_MINUTE]: 3, // Very low limit for testing
    },
  });

  const engine = new QuotaEngine([policy]);

  const context = {
    tenant: 'tenant-123',
    identity: 'user@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read',
  };

  // First 3 requests should succeed
  for (let i = 0; i < 3; i++) {
    const result = engine.checkAndReserve(context);
    assert.equal(result.allowed, true, `Request ${i + 1} should succeed`);
  }

  // 4th request should fail
  const result4 = engine.checkAndReserve(context);
  assert.equal(result4.allowed, false);
  assert.equal(result4.reason, QuotaDenialReason.RATE_EXCEEDED);

  console.log('   ✅ PASS: Rate limiting enforced correctly\n');
}

// --- Test 4: Concurrency limiting ---
function testConcurrencyLimiting() {
  console.log('Test 4: Concurrency limiting enforcement');

  const policy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: null,
    capSetId: null,
    limits: {
      [QuotaDimension.CONCURRENCY]: 2, // Max 2 concurrent
    },
  });

  const engine = new QuotaEngine([policy]);

  const context = {
    tenant: 'tenant-123',
    identity: 'user@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read',
  };

  // First 2 requests should succeed and get semaphore keys
  const result1 = engine.checkAndReserve(context);
  assert.equal(result1.allowed, true);
  assert.ok(result1.semaphoreKey, 'Should have semaphore key');

  const result2 = engine.checkAndReserve(context);
  assert.equal(result2.allowed, true);
  assert.ok(result2.semaphoreKey, 'Should have semaphore key');

  // 3rd request should fail (concurrency limit reached)
  const result3 = engine.checkAndReserve(context);
  assert.equal(result3.allowed, false);
  assert.equal(result3.reason, QuotaDenialReason.CONCURRENCY_EXCEEDED);

  // Release one slot
  engine.release(result1.semaphoreKey);

  // Now 4th request should succeed
  const result4 = engine.checkAndReserve(context);
  assert.equal(result4.allowed, true);

  // Cleanup
  engine.release(result2.semaphoreKey);
  engine.release(result4.semaphoreKey);

  console.log('   ✅ PASS: Concurrency limiting enforced correctly\n');
}

// --- Test 5: Cost-based limiting ---
function testCostLimiting() {
  console.log('Test 5: Cost-based quota enforcement');

  const policy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: null,
    capSetId: null,
    limits: {
      [QuotaDimension.COST_PER_MINUTE]: 15, // Just enough for 3 query_reads
    },
  });

  const engine = new QuotaEngine([policy]);

  // query_read costs 5 units, list_tables costs 1 unit
  const context1 = {
    tenant: 'tenant-123',
    identity: 'user@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read', // 5 units
  };

  // First query_read (5 units) - should succeed (5/15 used)
  const result1 = engine.checkAndReserve(context1);
  assert.equal(result1.allowed, true, 'First query_read should succeed');

  // Second query_read (5 units) - should succeed (10/15 used)
  const result2 = engine.checkAndReserve(context1);
  assert.equal(result2.allowed, true, 'Second query_read should succeed');

  // Third query_read (5 units) - should succeed (15/15 used)
  const result3 = engine.checkAndReserve(context1);
  assert.equal(result3.allowed, true, 'Third query_read should succeed');

  // Fourth query_read (5 units) - should fail (would be 20/15)
  const result4 = engine.checkAndReserve(context1);
  assert.equal(result4.allowed, false, 'Fourth query_read should fail');
  assert.equal(result4.reason, QuotaDenialReason.COST_EXCEEDED);

  console.log('   ✅ PASS: Cost-based quota enforced correctly\n');
}

// --- Test 6: Policy applicability (tenant vs identity) ---
function testPolicyApplicability() {
  console.log('Test 6: Policy applicability (tenant vs identity scoping)');

  const tenantPolicy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: null, // Tenant-wide
    capSetId: null,
    limits: { [QuotaDimension.RATE_PER_MINUTE]: 100 },
  });

  const identityPolicy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: 'user@example.com', // Identity-specific
    capSetId: null,
    limits: { [QuotaDimension.RATE_PER_MINUTE]: 10 },
  });

  // Only tenant policy - should apply to any identity
  const engine1 = new QuotaEngine([tenantPolicy]);
  const result1 = engine1.checkAndReserve({
    tenant: 'tenant-123',
    identity: 'other@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read',
  });
  assert.equal(result1.allowed, true);

  // Only identity policy - should NOT apply to different identity
  const engine2 = new QuotaEngine([identityPolicy]);
  const result2 = engine2.checkAndReserve({
    tenant: 'tenant-123',
    identity: 'other@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read',
  });
  assert.equal(result2.allowed, false);
  assert.equal(result2.reason, QuotaDenialReason.POLICY_MISSING);

  console.log('   ✅ PASS: Policy applicability works correctly\n');
}

// --- Test 7: SessionContext integration ---
function testSessionContextIntegration() {
  console.log('Test 7: SessionContext quota engine attachment');

  const ctx = new SessionContext();
  ctx.bind('user@example.com', 'tenant-123', 'session-1');

  const caps = new CapabilitySet({
    capSetId: 'cap-1',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3600000,
    issuer: 'test',
    grants: [{ action: CapabilityAction.TOOL_INVOKE, target: '*' }],
  });
  ctx.attachCapabilities(caps);

  // Should not have quota engine yet
  assert.equal(ctx.hasQuotaEngine, false);

  // Attach quota engine
  const engine = createDefaultQuotaEngine('tenant-123', 'user@example.com');
  ctx.attachQuotaEngine(engine);

  // Should now have quota engine
  assert.equal(ctx.hasQuotaEngine, true);
  assert.ok(ctx.quotaEngine);
  assert.equal(ctx.quotaEngine, engine);

  // Try to re-attach (should fail)
  try {
    ctx.attachQuotaEngine(engine);
    assert.fail('Should not allow re-attachment');
  } catch (err) {
    assert.ok(err.message.includes('already attached'));
  }

  console.log('   ✅ PASS: SessionContext quota engine attachment works\n');
}

// --- Test 8: Ambiguous scope (fail-closed) ---
function testAmbiguousScope() {
  console.log('Test 8: Ambiguous scope results in denial');

  const policy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: null,
    capSetId: null,
    limits: { [QuotaDimension.RATE_PER_MINUTE]: 100 },
  });

  const engine = new QuotaEngine([policy]);

  // Missing tenant (ambiguous)
  const result1 = engine.checkAndReserve({
    tenant: '',
    identity: 'user@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read',
  });
  assert.equal(result1.allowed, false);
  assert.equal(result1.reason, QuotaDenialReason.POLICY_AMBIGUOUS);

  // Missing action (ambiguous)
  const result2 = engine.checkAndReserve({
    tenant: 'tenant-123',
    identity: 'user@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: '',
    target: 'query_read',
  });
  assert.equal(result2.allowed, false);
  assert.equal(result2.reason, QuotaDenialReason.POLICY_AMBIGUOUS);

  console.log('   ✅ PASS: Ambiguous scope denied correctly\n');
}

// --- Test 9: Multi-dimensional limits ---
function testMultiDimensionalLimits() {
  console.log('Test 9: Multiple quota dimensions enforced together');

  const policy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: null,
    capSetId: null,
    limits: {
      [QuotaDimension.RATE_PER_MINUTE]: 10,
      [QuotaDimension.CONCURRENCY]: 2,
      [QuotaDimension.COST_PER_MINUTE]: 50,
    },
  });

  const engine = new QuotaEngine([policy]);

  const context = {
    tenant: 'tenant-123',
    identity: 'user@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read', // 5 cost units
  };

  // Should succeed with all dimensions satisfied
  const result1 = engine.checkAndReserve(context);
  assert.equal(result1.allowed, true);
  assert.ok(result1.semaphoreKey);

  const result2 = engine.checkAndReserve(context);
  assert.equal(result2.allowed, true);
  assert.ok(result2.semaphoreKey);

  // Third request - concurrency limit reached
  const result3 = engine.checkAndReserve(context);
  assert.equal(result3.allowed, false);
  assert.equal(result3.reason, QuotaDenialReason.CONCURRENCY_EXCEEDED);

  // Release one slot
  engine.release(result1.semaphoreKey);

  // Now should succeed again
  const result4 = engine.checkAndReserve(context);
  assert.equal(result4.allowed, true);

  // Cleanup
  engine.release(result2.semaphoreKey);
  engine.release(result4.semaphoreKey);

  console.log('   ✅ PASS: Multi-dimensional limits enforced correctly\n');
}

// --- Test 10: Token bucket refill ---
async function testTokenBucketRefill() {
  console.log('Test 10: Token bucket refill over time');

  const policy = new QuotaPolicy({
    tenant: 'tenant-123',
    identity: null,
    capSetId: null,
    limits: {
      [QuotaDimension.RATE_PER_10_SECONDS]: 2, // 2 per 10 seconds
    },
  });

  const engine = new QuotaEngine([policy]);

  const context = {
    tenant: 'tenant-123',
    identity: 'user@example.com',
    sessionId: 'session-1',
    capSetId: 'cap-abc',
    action: CapabilityAction.TOOL_INVOKE,
    target: 'query_read',
  };

  // Consume 2 tokens
  const result1 = engine.checkAndReserve(context);
  assert.equal(result1.allowed, true);

  const result2 = engine.checkAndReserve(context);
  assert.equal(result2.allowed, true);

  // 3rd should fail (tokens exhausted)
  const result3 = engine.checkAndReserve(context);
  assert.equal(result3.allowed, false);

  // Wait for partial refill (100ms = 1% of window, should refill 0.02 tokens - not enough)
  await new Promise(resolve => setTimeout(resolve, 100));

  const result4 = engine.checkAndReserve(context);
  assert.equal(result4.allowed, false); // Still not enough tokens

  console.log('   ✅ PASS: Token bucket refill behavior correct\n');
}

// Run all tests
async function runAllTests() {
  try {
    testQuotaPolicyCreation();
    testMissingPolicy();
    testRateLimiting();
    testConcurrencyLimiting();
    testCostLimiting();
    testPolicyApplicability();
    testSessionContextIntegration();
    testAmbiguousScope();
    testMultiDimensionalLimits();
    await testTokenBucketRefill();

    console.log('=== ✅ ALL TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('\n=== ❌ TEST EXECUTION FAILED ===');
    console.error(err);
    process.exit(1);
  }
}

runAllTests();
