# Manual Testing Guide: Running MCP Tools

## Prerequisites

- PostgreSQL connection configured (see `connect-postgres.md`)
- MCP Inspector installed
- At least one table in an allowed schema

## Testing with MCP Inspector

### 1. Install MCP Inspector

```bash
npm install -g @modelcontextprotocol/inspector
```

Or use npx:
```bash
npx @modelcontextprotocol/inspector
```

### 2. Start MCP Server

In your terminal:

```bash
npm run dev
```

The server will start on stdio transport and wait for MCP Inspector to connect.

### 3. Connect MCP Inspector

1. Open MCP Inspector in your browser (default: http://localhost:5173)
2. Configure connection:
   - Transport: **stdio**
   - Command: `node`
   - Args: `src/core/server.js`
   - Working Directory: `/path/to/bytepro-mcp-core`

3. Click **Connect**

### 4. Test list_tables Tool

In MCP Inspector:

1. Select tool: **list_tables**
2. Input (optional):
   ```json
   {
     "schema": "public"
   }
   ```
3. Click **Execute**

Expected response:
```json
{
  "success": true,
  "data": {
    "tables": [
      { "name": "users", "schema": "public" },
      { "name": "orders", "schema": "public" }
    ],
    "count": 2
  },
  "meta": {
    "timestamp": "2025-12-15T...",
    "tool": "list_tables",
    "adapter": "postgres"
  }
}
```

### 5. Test describe_table Tool

In MCP Inspector:

1. Select tool: **describe_table**
2. Input:
   ```json
   {
     "schema": "public",
     "table": "users"
   }
   ```
3. Click **Execute**

Expected response:
```json
{
  "success": true,
  "data": {
    "schema": "public",
    "table": "users",
    "columns": [
      {
        "name": "id",
        "type": "integer",
        "nullable": false,
        "default": "nextval('users_id_seq'::regclass)",
        "isPrimaryKey": true
      },
      {
        "name": "email",
        "type": "character varying",
        "nullable": false,
        "default": null,
        "isPrimaryKey": false
      }
    ],
    "columnCount": 2
  },
  "meta": {
    "timestamp": "2025-12-15T...",
    "tool": "describe_table",
    "adapter": "postgres"
  }
}
```

## Testing Security Features

### Test 1: Schema Allowlist

Try accessing a schema not in `ALLOWLIST_SCHEMAS`:

```json
{
  "schema": "secret_schema"
}
```

Expected: Error response with `ACCESS_DENIED` code.

### Test 2: Table Allowlist (if configured)

If you set `ALLOWLIST_TABLES=users,orders`, try accessing a different table:

```json
{
  "schema": "public",
  "table": "forbidden_table"
}
```

Expected: Error response with `ACCESS_DENIED` code.

### Test 3: Invalid Input

Try calling `describe_table` without required fields:

```json
{
  "schema": "public"
}
```

Expected: Error response with `VALIDATION_ERROR` code.

## Testing Without MCP Inspector

You can also test using the MCP protocol directly via stdio:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npm start
```

Or create a test script:

```javascript
// test-mcp-client.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['src/core/server.js'],
});

const client = new Client({
  name: 'test-client',
  version: '1.0.0',
}, {
  capabilities: {},
});

await client.connect(transport);

// List tools
const tools = await client.listTools();
console.log('Available tools:', tools);

// Call list_tables
const result = await client.callTool('list_tables', { schema: 'public' });
console.log('Result:', result);

await client.close();
```

## Checking Logs

View audit logs:

```bash
# Watch logs in real-time
tail -f server.log

# Or set LOG_PRETTY=true in .env for readable output
```

## Troubleshooting

### Server Won't Start

- Check `.env` configuration
- Verify PostgreSQL connection
- Review error logs

### Tools Not Found

- Verify server started successfully
- Check MCP Inspector connection
- Look for errors in server logs

### Permission Errors

- Verify allowlist configuration in `.env`
- Check that schema/table is in allowlist
- Review security logs for details

### Empty Results

- Verify tables exist in database
- Check schema name is correct
- Ensure user has SELECT permissions
