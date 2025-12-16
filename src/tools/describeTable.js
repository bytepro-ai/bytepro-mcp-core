import { z } from 'zod';

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
async function handler(input, adapter) {
  const { schema, table } = input;

  const columns = await adapter.describeTable({ schema, table });

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
