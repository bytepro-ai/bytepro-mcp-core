import { z } from 'zod';
import { isValidSessionContext } from '../core/sessionContext.js';

/**
 * Describe Table Tool
 * Returns detailed schema information for a specific table
 */

// Input schema
export const describeTableInputSchema = z.object({
  schema: z.string().min(1).describe('Schema name where the table is located'),
  table: z.string().min(1).describe('Table name to describe'),
});

// Tool handler
// SECURITY: sessionContext is injected by toolRegistry (immutable binding)
async function handler(input, adapter, sessionContext) {
  // SECURITY: Defensive assertion - context MUST be bound
  if (!sessionContext || !sessionContext.isBound) {
    throw new Error('SECURITY: describe_table called without bound session context');
  }

  // SECURITY: Verify session context is genuine
  if (!isValidSessionContext(sessionContext)) {
    throw new Error('SECURITY VIOLATION: Invalid session context instance');
  }

  const { schema, table } = input;

  const columns = await adapter.describeTable({ schema, table }, sessionContext);

  return {
    schema,
    table,
    columns,
    columnCount: columns.length,
  };
}

// Tool definition
export const describeTableTool = {
  name: 'describe_table',
  description:
    'Get detailed schema information for a specific table, including column names, types, nullability, defaults, and primary keys. Table must be in an allowed schema according to the security allowlist.',
  inputSchema: describeTableInputSchema,
  handler,
};

export default describeTableTool;
