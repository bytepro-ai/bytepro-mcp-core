import { pgPool } from './src/utils/pgPool.js';
import { allowlist } from './src/security/allowlist.js';
import { queryGuard } from './src/security/queryGuard.js';
import { logger } from './src/utils/logger.js';

async function testDay2() {
  try {
    logger.info('=== Testing Day 2 Deliverables ===');

    // Test 1: Allowlist
    logger.info('\n--- Test 1: Allowlist ---');
    console.log('Allowlist config:', allowlist.getConfig());
    console.log('Is "public" allowed?', allowlist.isSchemaAllowed('public'));
    console.log('Is "private" allowed?', allowlist.isSchemaAllowed('private'));

    // Test 2: Query Guard
    logger.info('\n--- Test 2: Query Guard ---');
    console.log('Guard config:', queryGuard.getConfig());

    const queries = [
      'SELECT * FROM users',
      'DROP TABLE users',
      'DELETE FROM users WHERE id=1',
      'SELECT id, email FROM users WHERE id=$1',
    ];

    queries.forEach((query) => {
      const result = queryGuard.validateQuery(query);
      console.log(`Query: ${query.substring(0, 50)}...`);
      console.log(`Valid: ${result.isValid}`, result.isValid ? '' : `- ${result.reasons.join(', ')}`);
    });

    // Test 3: PostgreSQL Pool (without actual DB connection)
    logger.info('\n--- Test 3: PostgreSQL Pool ---');
    pgPool.initialize();
    console.log('Pool initialized successfully');

    // Note: Health check will fail without real DB, but that's expected
    const health = await pgPool.health();
    console.log('Health check result:', health);

    logger.info('\n✅ Day 2 tests completed!');
  } catch (error) {
    logger.error({ error: error.message }, 'Day 2 test failed');
    console.error(error);
  } finally {
    // Cleanup
    await pgPool.shutdown();
  }
}

testDay2();
