import assert from 'assert';
import { loadQuotaEngineFromEnv } from './src/security/quotas.js';

console.log('=== Quota Fail-Closed Security Hardening Test ===\n');

const originalEnv = process.env.NODE_ENV;
const originalPolicies = process.env.MCP_QUOTA_POLICIES;

async function runTests() {
  try {
    // Test 1: Production mode with missing MCP_QUOTA_POLICIES should throw
    console.log('Test 1: Production mode with missing quota policies (fail-closed)');
    
    process.env.NODE_ENV = 'production';
    delete process.env.MCP_QUOTA_POLICIES;
    
    try {
      loadQuotaEngineFromEnv();
      console.log('   ❌ FAIL: Should have thrown error in production mode');
      process.exit(1);
    } catch (err) {
      assert.ok(err.message.includes('production') || err.message.includes('SECURITY'), 
        'Error message should mention production or security');
      assert.ok(err.message.includes('Quota policies required'), 
        'Error message should indicate quota policies are required');
      console.log('   ✅ PASS: Production mode correctly throws on missing policies');
      console.log(`   Error: ${err.message}\n`);
    }

    // Test 2: Non-production mode should allow missing policies
    console.log('Test 2: Development mode with missing quota policies (allowed)');
    
    process.env.NODE_ENV = 'development';
    delete process.env.MCP_QUOTA_POLICIES;
    
    try {
      const engine = loadQuotaEngineFromEnv();
      assert.ok(engine, 'Engine should be created');
      assert.equal(engine.policies.length, 0, 'Engine should have no policies');
      console.log('   ✅ PASS: Development mode allows missing policies');
      console.log('   Engine created with 0 policies\n');
    } catch (err) {
      console.log('   ❌ FAIL: Development mode should not throw');
      console.log(`   Unexpected error: ${err.message}`);
      process.exit(1);
    }

    // Test 3: Production mode with valid policies should work
    console.log('Test 3: Production mode with valid quota policies (allowed)');
    
    process.env.NODE_ENV = 'production';
    process.env.MCP_QUOTA_POLICIES = JSON.stringify({
      policies: [
        {
          tenant: 'test-tenant',
          identity: null,
          capSetId: null,
          limits: {
            'rate.per_minute': 100
          }
        }
      ]
    });
    
    try {
      const engine = loadQuotaEngineFromEnv();
      assert.ok(engine, 'Engine should be created');
      assert.equal(engine.policies.length, 1, 'Engine should have 1 policy');
      console.log('   ✅ PASS: Production mode with valid policies works correctly');
      console.log('   Engine created with 1 policy\n');
    } catch (err) {
      console.log('   ❌ FAIL: Production mode should accept valid policies');
      console.log(`   Unexpected error: ${err.message}`);
      process.exit(1);
    }

    // Test 4: Malformed policies should fail-closed (existing behavior)
    console.log('Test 4: Malformed quota policies (fail-closed)');
    
    process.env.NODE_ENV = 'production';
    process.env.MCP_QUOTA_POLICIES = 'invalid json';
    
    try {
      loadQuotaEngineFromEnv();
      console.log('   ❌ FAIL: Should have thrown error for malformed policies');
      process.exit(1);
    } catch (err) {
      assert.ok(err.message.includes('Failed to load quota policies'), 
        'Error should indicate policy loading failure');
      console.log('   ✅ PASS: Malformed policies correctly rejected');
      console.log(`   Error: ${err.message}\n`);
    }

    // Test 5: Empty NODE_ENV (undefined) should allow missing policies
    console.log('Test 5: Undefined NODE_ENV with missing quota policies (allowed)');
    
    delete process.env.NODE_ENV;
    delete process.env.MCP_QUOTA_POLICIES;
    
    try {
      const engine = loadQuotaEngineFromEnv();
      assert.ok(engine, 'Engine should be created');
      assert.equal(engine.policies.length, 0, 'Engine should have no policies');
      console.log('   ✅ PASS: Undefined NODE_ENV allows missing policies (non-production)');
      console.log('   Engine created with 0 policies\n');
    } catch (err) {
      console.log('   ❌ FAIL: Undefined NODE_ENV should not throw');
      console.log(`   Unexpected error: ${err.message}`);
      process.exit(1);
    }

    console.log('=== ✅ ALL SECURITY HARDENING TESTS PASSED ===\n');
    console.log('Summary:');
    console.log('  ✅ Production + Missing policies → FAIL-CLOSED (throws)');
    console.log('  ✅ Development + Missing policies → Allowed (empty engine)');
    console.log('  ✅ Production + Valid policies → Works correctly');
    console.log('  ✅ Malformed policies → FAIL-CLOSED (throws)');
    console.log('  ✅ Undefined NODE_ENV + Missing policies → Allowed (non-production)');
    
    process.exit(0);
  } catch (err) {
    console.error('\n=== ❌ TEST EXECUTION FAILED ===');
    console.error(err);
    process.exit(1);
  } finally {
    // Restore original environment
    if (originalEnv !== undefined) {
      process.env.NODE_ENV = originalEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (originalPolicies !== undefined) {
      process.env.MCP_QUOTA_POLICIES = originalPolicies;
    } else {
      delete process.env.MCP_QUOTA_POLICIES;
    }
  }
}

runTests();
