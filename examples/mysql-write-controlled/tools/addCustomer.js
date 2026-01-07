import { z } from 'zod';
import { logger } from '../../../src/utils/logger.js';
import { isValidSessionContext } from '../../../src/core/sessionContext.js';

/**
 * Add Customer Tool (Write-Enabled)
 * 
 * SAFETY CONTROLS (Defense in Depth):
 * 
 * Execution Boundary (Core Library):
 * 1. Read-only mode blocks execution (enforced at boundary before tool runs)
 * 2. Authorization requires TOOL_INVOKE capability on 'add_customer'
 * 3. Quota enforcement (rate/concurrency/cost limits)
 * 4. Session context validation (bound, branded, authentic)
 * 
 * Tool-Specific (This Implementation):
 * 5. Single operation: INSERT INTO sakila.customer only
 * 6. Parameterized query (no SQL injection possible)
 * 7. Database allowlist: only 'sakila' database (hard-coded check)
 * 8. Input validation: Zod schema with strict constraints
 * 9. No arbitrary SQL execution
 * 10. Full audit logging (identity, tenant, parameters, outcome)
 * 
 * OPERATOR RESPONSIBILITIES:
 * - Use dedicated MySQL user with INSERT-only privileges on sakila.customer
 * - Configure appropriate quota policies for mutation operations
 * - Monitor audit logs for unauthorized attempts or anomalies
 * - Implement alerting for authorization denials and quota violations
 */

// Input schema - strict validation
export const addCustomerInputSchema = z.object({
  store_id: z.number().int().min(1).max(2).describe('Store ID (1 or 2 in Sakila)'),
  first_name: z.string().min(1).max(45).describe('Customer first name'),
  last_name: z.string().min(1).max(45).describe('Customer last name'),
  email: z.string().email().max(50).optional().describe('Customer email (optional)'),
  address_id: z.number().int().min(1).describe('Address ID (must exist in sakila.address)'),
});

/**
 * Tool handler
 * @param {Object} input - Validated input from Zod schema
 * @param {Object} adapter - Database adapter instance
 * @param {SessionContext} sessionContext - Immutable session context (identity + tenant)
 * @returns {Promise<Object>} Insert result with customer_id
 */
async function handler(input, adapter, sessionContext) {
  const startTime = Date.now();

  // SECURITY: Defensive assertion - context MUST be bound
  // This check is redundant (core enforces it) but demonstrates defense in depth
  if (!sessionContext || !sessionContext.isBound) {
    throw new Error('SECURITY: add_customer called without bound session context');
  }

  // SECURITY: Verify session context is genuine (branded check)
  if (!isValidSessionContext(sessionContext)) {
    throw new Error('SECURITY VIOLATION: Invalid session context instance');
  }

  // SECURITY: Database allowlist enforcement (tool-level)
  // This tool ONLY operates on the 'sakila' database
  const allowedDatabase = 'sakila';
  if (adapter.config.database !== allowedDatabase) {
    logger.error(
      {
        operation: 'add_customer',
        identity: sessionContext.identity,
        tenant: sessionContext.tenant,
        expectedDb: allowedDatabase,
        actualDb: adapter.config.database,
      },
      'Database allowlist violation'
    );
    throw new Error(`SECURITY: add_customer requires database='${allowedDatabase}', got '${adapter.config.database}'`);
  }

  try {
    // Audit log: mutation initiated (no sensitive data in logs)
    logger.info(
      {
        operation: 'add_customer',
        identity: sessionContext.identity,
        tenant: sessionContext.tenant,
        store_id: input.store_id,
        hasEmail: !!input.email,
        address_id: input.address_id,
      },
      'Customer insert initiated'
    );

    // Parameterized INSERT query (no SQL injection possible)
    // Query is fixed - only values are parameterized
    const query = `
      INSERT INTO sakila.customer (store_id, first_name, last_name, email, address_id, create_date)
      VALUES (?, ?, ?, ?, ?, NOW())
    `;

    const params = [
      input.store_id,
      input.first_name,
      input.last_name,
      input.email || null,
      input.address_id,
    ];

    // Execute via adapter's connection pool
    // NOTE: This bypasses the adapter's read-only enforcement
    // which is why read-only mode at the boundary is critical
    const connection = await adapter.pool.getConnection();
    
    try {
      const [result] = await connection.query(query, params);
      
      const customer_id = result.insertId;

      // Audit log: successful mutation (minimal metadata, no sensitive data)
      logger.info(
        {
          operation: 'add_customer',
          identity: sessionContext.identity,
          tenant: sessionContext.tenant,
          customer_id,
          executionTime: Date.now() - startTime,
        },
        'Customer insert completed'
      );

      return {
        success: true,
        customer_id,
        store_id: input.store_id,
        first_name: input.first_name,
        last_name: input.last_name,
        email: input.email || null,
        address_id: input.address_id,
        inserted_at: new Date().toISOString(),
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    // Audit log: mutation failed (error details, no sensitive data)
    logger.error(
      {
        operation: 'add_customer',
        identity: sessionContext.identity,
        tenant: sessionContext.tenant,
        errorCode: error.code || 'UNKNOWN',
        errorMessage: error.message,
        errorSqlState: error.sqlState,
        totalTime: Date.now() - startTime,
      },
      'Customer insert failed'
    );

    // Throw structured error for MCP error handling
    throw {
      code: 'INSERT_FAILED',
      message: 'Failed to insert customer',
      details: {
        error: error.message,
        sqlState: error.sqlState,
      },
    };
  }
}

// Tool definition (MCP)
export const addCustomerTool = {
  name: 'add_customer',
  description:
    'Insert a new customer record into the Sakila database. ' +
    'Requires write capability (TOOL_INVOKE on add_customer). ' +
    'Blocked in read-only mode. ' +
    'Only operates on sakila.customer table. ' +
    'All inputs are validated and parameterized (SQL injection safe). ' +
    'Foreign key constraints are enforced by MySQL (address_id must exist).',
  inputSchema: addCustomerInputSchema,
  handler,
};

export default addCustomerTool;
