import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { isValidSessionContext } from '../core/sessionContext.js';

/**
 * Query Read Tool
 * Executes read-only SELECT queries with security enforcement
 *
 * Security layers:
 * 1. Input schema validation (Zod)
 * 2. Query structure validation (queryValidator - regex-based)
 * 3. Table permissions check (allowlist enforcement)
 * 4. Safe execution (READ ONLY transaction, LIMIT enforcement, timeout)
 */

// Input schema
export const queryReadInputSchema = z.object({
  query: z.string().min(1).describe('SQL SELECT query to execute'),
  params: z.array(z.any()).optional().default([]).describe('Query parameters for prepared statements'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(100)
    .describe('Maximum number of rows to return (default: 100, max: 1000)'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .default(30000)
    .describe('Query timeout in milliseconds (default: 30000, max: 60000)'),
});

/**
 * Tool handler
 * @param {Object} input - Validated input from Zod schema
 * @param {Object} adapter - Database adapter instance
 * @param {SessionContext} sessionContext - Immutable session context (identity + tenant)
 * @returns {Promise<Object>} Query results with metadata
 */
async function handler(input, adapter, sessionContext) {
  const startTime = Date.now();

  // SECURITY: Defensive assertion - context MUST be bound
  if (!sessionContext || !sessionContext.isBound) {
    throw new Error('SECURITY: query_read called without bound session context');
  }

  // SECURITY: Verify session context is genuine
  if (!isValidSessionContext(sessionContext)) {
    throw new Error('SECURITY VIOLATION: Invalid session context instance');
  }

  try {
    // Audit log: query execution initiated (no sensitive data)
    logger.info(
      {
        operation: 'query_read',
        limit: input.limit,
        timeout: input.timeout,
        hasParams: input.params && input.params.length > 0,
      },
      'Query read initiated'
    );

    // Execute via adapter (orchestrates all security layers)
    // SECURITY: Pass session context for tenant isolation and audit
    const result = await adapter.executeQuery({
      query: input.query,
      params: input.params,
      limit: input.limit,
      timeout: input.timeout,
    }, sessionContext);

    // Audit log: successful execution
    logger.info(
      {
        operation: 'query_read',
        rowCount: result.rowCount,
        executionTime: result.executionTime,
        truncated: result.truncated,
        appliedLimit: result.appliedLimit,
        totalTime: Date.now() - startTime,
      },
      'Query read completed'
    );

    // Return MCP-compliant response
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields,
      metadata: {
        executionTime: result.executionTime,
        truncated: result.truncated,
        appliedLimit: result.appliedLimit,
        requestedLimit: input.limit,
      },
    };
  } catch (error) {
    // Audit log: execution failed (no sensitive data)
    logger.error(
      {
        operation: 'query_read',
        errorCode: error.code || 'UNKNOWN',
        errorMessage: error.message,
        totalTime: Date.now() - startTime,
      },
      'Query read failed'
    );

    // Throw structured error for MCP error handling
    throw {
      code: error.code || 'EXECUTION_ERROR',
      message: error.message || 'Query execution failed',
      details: error.details || null,
    };
  }
}

// Tool definition (MCP)
export const queryReadTool = {
  name: 'query_read',
  description:
    'Execute a read-only SELECT query against the database. ' +
    'Supports parameterized queries for security. ' +
    'All queries are executed in READ ONLY transactions with enforced limits and timeouts. ' +
    'Only allowed tables (per security allowlist) can be queried. ' +
    'Dangerous SQL patterns (writes, UNION, CTEs, etc.) are blocked.',
  inputSchema: queryReadInputSchema,
  handler,
};

export default queryReadTool;
