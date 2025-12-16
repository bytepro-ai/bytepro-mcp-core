import { z } from 'zod';

/**
 * List Tables Tool
 * Lists all tables in allowed schemas
 */

// Input schema
export const listTablesInputSchema = z.object({
  schema: z.string().optional().describe('Optional schema name to filter tables'),
});

// Tool handler
async function handler(input, adapter) {
  const result = await adapter.listTables(input);

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
