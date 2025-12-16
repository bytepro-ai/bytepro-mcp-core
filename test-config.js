import { config } from './src/config/env.js';
import { logger } from './src/utils/logger.js';

// Test configuration loading
logger.info({ config }, 'Configuration loaded successfully');

// Test audit logging
import { auditLog } from './src/utils/logger.js';

auditLog({
  action: 'test_action',
  adapter: 'postgres',
  input: { schema: 'public', password: 'secret123' },
  duration: 42,
  outcome: 'success',
});

console.log('\n✅ Day 1 configuration and logging test passed!');
