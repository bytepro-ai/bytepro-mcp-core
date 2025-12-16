# BytePro MCP Core (Community Edition)

Core runtime for building secure MCP servers that connect PostgreSQL databases to AI systems.

## Features

- 🔒 **Security-First**: Allowlist-based access control, parameterized queries, query guards
- 🔍 **Database Introspection**: List tables and describe schemas
- 📊 **PostgreSQL Support**: Full support with connection pooling
- 📝 **Audit Logging**: Complete audit trail of all operations
- 🚀 **MCP SDK Integration**: Built on official Model Context Protocol SDK
- ⚡ **stdio Transport**: Easy integration with MCP Inspector and clients

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL credentials

# Run the server
npm run dev
```

## Configuration

Required environment variables:

```env
PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=your_password
PG_DATABASE=your_database

READ_ONLY=true
ALLOWLIST_SCHEMAS=public
LOG_LEVEL=info
```

See [`.env.example`](.env.example) for all available options.

## Available Tools

- **`list_tables`** - List all tables in allowed schemas
- **`describe_table`** - Get detailed schema information for a table

## Security

- ✅ Read-only mode by default
- ✅ Schema and table allowlists
- ✅ Query pattern blocking (DROP, ALTER, etc.)
- ✅ Result size limits
- ✅ Full audit logging

## Documentation

- [Getting Started Guide](docs/getting-started.md)
- [Week 1 Implementation Plan](plan-week1Implementation.prompt.md)
- [MCP Core Interface Design](docs/mcp-core-interface.md)

## Architecture

```
src/
├── core/           # MCP server and tool registry
├── adapters/       # Database adapters
├── security/       # Access control and query guards
├── tools/          # MCP tool implementations
├── config/         # Configuration and validation
└── utils/          # Logger and utilities
```

## Testing

Use [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to test the server:

```bash
npm run dev
# Connect MCP Inspector to stdio transport
```

## Development Status

**Week 1 Implementation: Days 1-5 Complete! ✅**

- [x] Project scaffolding and dependencies
- [x] Configuration and logging with Zod validation
- [x] PostgreSQL adapter with connection pooling
- [x] Security primitives (allowlist, query guard)
- [x] MCP server core with official SDK integration
- [x] Tool implementations (list_tables, describe_table)
- [x] Manual testing documentation
- [ ] **Day 6**: End-to-end testing with real PostgreSQL database

See [IMPLEMENTATION-SUMMARY.md](IMPLEMENTATION-SUMMARY.md) for complete details.

## Community vs Enterprise

**Community Edition** (this package):
- PostgreSQL adapter
- Introspection tools
- Basic security controls
- stdio transport

**Enterprise Edition** (separate):
- Additional database adapters (MySQL, MSSQL, MongoDB)
- Query execution tools
- Advanced permissions
- HTTP/WebSocket transports

## License

Apache-2.0 - See [LICENSE](LICENSE) for details.

## Contributing

This is an early-stage project. Contributions welcome!

1. Fork the repository
2. Create a feature branch
3. Follow existing code patterns
4. Submit a pull request
