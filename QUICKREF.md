# Quick Reference - BytePro MCP Core

## 🚀 Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with PostgreSQL credentials

# 3. Run
npm run dev
```

## 🔧 Environment Variables

### Required
```env
PG_HOST=localhost
PG_PORT=5432
PG_USER=your_username
PG_PASSWORD=your_password
PG_DATABASE=your_database
```

### Optional
```env
PG_SSL=false
PG_MAX_CONNECTIONS=10
READ_ONLY=true
ALLOWLIST_SCHEMAS=public
ALLOWLIST_TABLES=
MAX_TABLES=100
MAX_COLUMNS=200
LOG_LEVEL=info
LOG_PRETTY=false
```

## 🛠️ Available Tools

### list_tables
List all tables in allowed schemas.

**Input:**
```json
{
  "schema": "public"  // optional
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "tables": [
      { "name": "users", "schema": "public" },
      { "name": "orders", "schema": "public" }
    ],
    "count": 2
  }
}
```

### describe_table
Get detailed schema for a specific table.

**Input:**
```json
{
  "schema": "public",
  "table": "users"
}
```

**Response:**
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
        "default": "nextval(...)",
        "isPrimaryKey": true
      }
    ],
    "columnCount": 1
  }
}
```

## 🔒 Security

- ✅ Read-only by default
- ✅ Schema allowlist required
- ✅ Query pattern blocking (DROP, ALTER, etc.)
- ✅ Result limits enforced
- ✅ Full audit logging

## 🧪 Testing

### MCP Inspector
```bash
npx @modelcontextprotocol/inspector

# Connection:
# - Transport: stdio
# - Command: node
# - Args: src/core/server.js
# - Directory: /path/to/bytepro-mcp-core
```

### Direct Testing
```bash
# Test imports
node test-server-init.js

# Test config
node test-config.js

# Test security
node test-day2.js
```

## 📊 Scripts

```bash
npm run dev      # Run with nodemon (auto-reload)
npm start        # Run server
npm run lint     # Lint code
npm run format   # Format code
```

## 🔍 Troubleshooting

### Can't Connect to PostgreSQL
```bash
# Test connection manually
psql -h localhost -U your_username -d your_database
```

### Configuration Errors
```bash
# Validate config loads
node -e "import('./src/config/env.js').then(m => console.log(m.config))"
```

### Check Logs
```env
# In .env, set:
LOG_LEVEL=debug
LOG_PRETTY=true
```

## 📚 Documentation

- [Getting Started](docs/getting-started.md) - Full setup guide
- [Implementation Plan](plan-week1Implementation.prompt.md) - Week 1 roadmap
- [Testing Guide](tests/manual/run-tools.md) - Manual testing
- [Summary](IMPLEMENTATION-SUMMARY.md) - What's been built

## 🏗️ Project Structure

```
src/
├── core/           # MCP server, tool registry, responses
├── adapters/       # Database adapters (PostgreSQL)
├── security/       # Allowlist, query guards
├── tools/          # MCP tool implementations
├── config/         # Configuration, validation
└── utils/          # Logger, connection pool
```

## ⚡ Common Tasks

### Add Schema to Allowlist
```env
# In .env:
ALLOWLIST_SCHEMAS=public,app_data,reporting
```

### Limit Table Access
```env
# In .env:
ALLOWLIST_TABLES=users,orders,products
```

### Enable Write Mode (Dangerous!)
```env
# In .env:
READ_ONLY=false  # Not recommended for community edition
```

### Increase Result Limits
```env
# In .env:
MAX_TABLES=200
MAX_COLUMNS=500
```

## 🆘 Support

Check these in order:
1. [Getting Started Guide](docs/getting-started.md)
2. [Testing Guide](tests/manual/run-tools.md)
3. [PostgreSQL Connection](tests/manual/connect-postgres.md)
4. Logs (set `LOG_LEVEL=debug`)

## 📦 Version

Current: v0.1.0 (Week 1 Prototype)

Community Edition - PostgreSQL only
