# Manual Testing Guide: Connect to PostgreSQL

## Prerequisites

- PostgreSQL server running (local or remote)
- Valid credentials
- Database with at least one table in an allowed schema

## Setup

### 1. Configure Environment

Edit `.env` file with your PostgreSQL credentials:

```env
PG_HOST=localhost
PG_PORT=5432
PG_USER=your_username
PG_PASSWORD=your_password
PG_DATABASE=your_database
PG_SSL=false

READ_ONLY=true
ALLOWLIST_SCHEMAS=public
LOG_LEVEL=info
```

### 2. Test Connection

Run the PostgreSQL health check:

```bash
node -e "
import('./src/utils/pgPool.js').then(async ({ pgPool }) => {
  pgPool.initialize();
  const health = await pgPool.health();
  console.log('Health check:', health);
  await pgPool.shutdown();
});
"
```

Expected output:
```json
{
  "healthy": true,
  "latency": 15
}
```

### 3. Test Adapter

Run a simple adapter test:

```bash
node -e "
import('./src/adapters/postgres.js').then(async ({ PostgresAdapter }) => {
  import('./src/config/env.js').then(async ({ config }) => {
    const adapter = new PostgresAdapter(config.pg);
    await adapter.connect();
    const health = await adapter.health();
    console.log('Adapter health:', health);
    await adapter.disconnect();
  });
});
"
```

## Troubleshooting

### Connection Refused

- Verify PostgreSQL is running: `psql -h localhost -U your_username -d your_database`
- Check firewall settings
- Verify port is correct (default: 5432)

### Authentication Failed

- Verify username and password
- Check `pg_hba.conf` for authentication method
- Ensure user has CONNECT privilege

### SSL Errors

- Set `PG_SSL=false` for local development
- For remote connections, set `PG_SSL=true` and ensure server supports SSL

### Permission Denied

- Verify user has SELECT permission on information_schema tables
- Grant necessary permissions:
  ```sql
  GRANT USAGE ON SCHEMA public TO your_username;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO your_username;
  ```
