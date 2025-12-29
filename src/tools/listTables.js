import { z } from 'zod';
import { isValidSessionContext } from '../core/sessionContext.js';

/**
 * List Tables Tool
 * Lists all tables in allowed schemas
 */

// Input schema
export const listTablesInputSchema = z.object({
  schema: z.string().optional().describe('Optional schema name to filter tables'),
});

// Tool handler
// SECURITY: sessionContext is injected by toolRegistry (immutable binding)
async function handler(input, adapter, sessionContext) {
  // SECURITY: Defensive assertion - context MUST be bound
  if (!sessionContext || !sessionContext.isBound) {
    throw new Error('SECURITY: list_tables called without bound session context');
  }

  // SECURITY: Verify session context is genuine
  if (!isValidSessionContext(sessionContext)) {
    throw new Error('SECURITY VIOLATION: Invalid session context instance');
  }

  const result = await adapter.listTables(input, sessionContext);

  return {
    tables: result,
    count: result.length,
  };
}

// Tool definition
export const listTablesTool = {
  name: 'list_tables',
  description:
    'List all tables in the database. Optionally filter by schema. Only returns tables in allowed schemas according to the security allowlist.',
  inputSchema: listTablesInputSchema,
  handler,
};

export default listTablesTool;
