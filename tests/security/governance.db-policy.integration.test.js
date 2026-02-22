import { jest } from '@jest/globals';

import { executeToolBoundary } from '../../src/core/executeToolBoundary.js';
import { SessionContext } from '../../src/core/sessionContext.js';
import { CapabilitySet } from '../../src/security/capabilities.js';
import { DBPolicyEngine } from '../../src/security/dbPolicyEngine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuthorizedSession({ toolName, tenant = 'tenant-abc', identity = 'user-123' } = {}) {
  const sessionContext = new SessionContext();
  sessionContext.bind(identity, tenant, 'sess-xyz');

  const now = Date.now();
  const capabilities = new CapabilitySet({
    capSetId: 'cap-set-test-allow-1',
    issuedAt: now,
    expiresAt: now + 3600000,
    issuer: 'test-issuer',
    grants: [{ action: 'tool.invoke', target: toolName }],
  });

  sessionContext.attachCapabilities(capabilities);
  return sessionContext;
}

function makeToolRegistry({ toolName, handler }) {
  return {
    tools: new Map([
      [
        toolName,
        {
          name: toolName,
          handler,
          inputSchema: {
            safeParse: (input) => ({ success: true, data: input }),
          },
        },
      ],
    ]),
  };
}

function makeAdapters() {
  const adapter = { name: 'mock-db' };
  return {
    getAdapter: jest.fn(() => adapter),
    activeAdapter: adapter,
  };
}

/**
 * Build a mock policy adapter with the required config.database so that
 * DBPolicyEngine._loadPolicies() can construct the schema-qualified table name.
 * rows: policy row objects in v2 schema (effect/priority/version/is_active).
 */
function makePolicyAdapter(rows) {
  return {
    config: { database: 'testdb' },
    executeQuery: jest.fn(async () => ({ rows })),
  };
}

/**
 * Convenience factory for a v2 policy row with safe defaults.
 * effect: 'allow' | 'deny'
 * priority defaults to 0
 * version defaults to 1
 * is_active defaults to true
 */
function makeRow({
  tenant = 'tenant-abc',
  role = 'default',
  table_name,
  effect,
  priority = 0,
  version = 1,
  is_active = true,
  start_time = null,
  end_time = null,
}) {
  return { tenant_id: tenant, role, table_name, effect, priority, version, is_active, start_time, end_time };
}

function utcMs({ y = 2026, m = 0, d = 1, hh = 0, mm = 0, ss = 0 } = {}) {
  return Date.UTC(y, m, d, hh, mm, ss);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Governance: DBPolicyEngine integration (executeToolBoundary)', () => {

  // =========================================================================
  // Backward-compatible baseline
  // =========================================================================

  it('1) No policy engine attached → query succeeds (backward compatible)', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(adapters.getAdapter).toHaveBeenCalledTimes(1);
  });

  it('2) Policy engine attached, no matching policy → deny (NO_POLICY)', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine({ ttlMs: 300000 });
    await policyEngine.initialize(makePolicyAdapter([]), sessionContext);
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.error?.details?.reason).toBe('NO_POLICY');
    expect(handler).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
  });

  // =========================================================================
  // v2 core scenarios
  // =========================================================================

  it('3) Explicit allow policy → allow', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([makeRow({ table_name: 'users', effect: 'allow' })]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(adapters.getAdapter).toHaveBeenCalledTimes(1);
  });

  it('4) Explicit deny policy → deny (TABLE_DENIED)', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([makeRow({ table_name: 'users', effect: 'deny' })]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.error?.details?.reason).toBe('TABLE_DENIED');
    expect(handler).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
  });

  it('Deny dominance: allow and deny at same priority → deny (TABLE_DENIED)', async () => {
    // Both rows share (priority=0, version=1). After version dedup they both
    // survive (same version), so the tier contains both. Step 7 fires: deny wins.
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([
        makeRow({ table_name: 'users', effect: 'allow', priority: 0, version: 1 }),
        makeRow({ table_name: 'users', effect: 'deny',  priority: 0, version: 1 }),
      ]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.error?.details?.reason).toBe('TABLE_DENIED');
    expect(handler).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
  });

  it('Higher-priority allow beats lower-priority deny → allow', async () => {
    // allow@priority=10 vs deny@priority=5.
    // f(allow) = (10,0,1) > f(deny) = (5,1,1). Allow wins.
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([
        makeRow({ table_name: 'users', effect: 'allow', priority: 10, version: 1 }),
        makeRow({ table_name: 'users', effect: 'deny',  priority: 5,  version: 1 }),
      ]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(adapters.getAdapter).toHaveBeenCalledTimes(1);
  });

  it('Higher-priority deny beats lower-priority allow → deny', async () => {
    // deny@priority=10 vs allow@priority=5.
    // f(deny) = (10,1,1) > f(allow) = (5,0,1). Deny wins.
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([
        makeRow({ table_name: 'users', effect: 'deny',  priority: 10, version: 1 }),
        makeRow({ table_name: 'users', effect: 'allow', priority: 5,  version: 1 }),
      ]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.error?.details?.reason).toBe('TABLE_DENIED');
    expect(handler).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
  });

  it('Version dedup: newer allow (v=2) supersedes older deny (v=1) at same priority → allow', async () => {
    // deny@priority=5,version=1 is the old row.
    // allow@priority=5,version=2 is the current row (higher version).
    // After dedup, only allow@p=5,v=2 survives its priority group → ALLOW.
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([
        makeRow({ table_name: 'users', effect: 'deny',  priority: 5, version: 1 }),
        makeRow({ table_name: 'users', effect: 'allow', priority: 5, version: 2 }),
      ]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('is_active=false only → deny (NO_ACTIVE_POLICY)', async () => {
    // Rows exist for the key but all are soft-deactivated. Fail-closed.
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([
        makeRow({ table_name: 'users', effect: 'allow', is_active: false }),
        makeRow({ table_name: 'users', effect: 'deny',  is_active: false }),
      ]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.error?.details?.reason).toBe('NO_ACTIVE_POLICY');
    expect(handler).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Time-window scenarios
  // =========================================================================

  it('5) Time window violation → deny (TIME_WINDOW)', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([
        makeRow({ table_name: 'users', effect: 'allow', start_time: '09:00:00', end_time: '17:00:00' }),
      ]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const now = utcMs({ hh: 18, mm: 0, ss: 0 }); // 18:00 UTC — outside window
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    dateNowSpy.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.error?.details?.reason).toBe('TIME_WINDOW');
    expect(handler).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
  });

  it('6) Midnight-crossing window → allow', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    // Exercise adapter-agnostic result format (array instead of { rows })
    await policyEngine.initialize(
      {
        config: { database: 'testdb' },
        executeQuery: jest.fn(async () => ([
          makeRow({ table_name: 'users', effect: 'allow', start_time: '22:00:00', end_time: '06:00:00' }),
        ])),
      },
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const now = utcMs({ hh: 2, mm: 0, ss: 0 }); // 02:00 UTC — inside crossing window
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    dateNowSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(adapters.getAdapter).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Multi-table and compound scenarios
  // =========================================================================

  it('7) Multi-table query where one table denied → deny', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      makePolicyAdapter([
        makeRow({ table_name: 'users',  effect: 'allow' }),
        makeRow({ table_name: 'orders', effect: 'deny'  }),
      ]),
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const query = 'SELECT * FROM app.users u JOIN app.orders o ON u.id = o.user_id';

    const result = await executeToolBoundary({
      toolName,
      input: { query, params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(['TABLE_DENIED', 'NO_POLICY', 'TIME_WINDOW']).toContain(result.error?.details?.reason);
    expect(handler).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Backward compatibility: v1 rows with `allowed` BOOLEAN
  // =========================================================================

  it('Backward compat: v1 row with allowed=true (no effect column) → allow', async () => {
    // Pre-v2 rows have `allowed` BOOLEAN. The shim in _loadPolicies derives effect from it.
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      {
        config: { database: 'testdb' },
        executeQuery: jest.fn(async () => ({
          rows: [{
            tenant_id: 'tenant-abc',
            role: 'default',
            table_name: 'users',
            effect: null,         // absent in v1
            allowed: true,        // v1 field
            priority: null,       // absent in v1 → defaults to 0
            version: null,        // absent in v1 → defaults to 1
            is_active: null,      // absent in v1 → defaults to true
            start_time: null,
            end_time: null,
          }],
        })),
      },
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('Backward compat: v1 row with allowed=false (no effect column) → deny', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(
      {
        config: { database: 'testdb' },
        executeQuery: jest.fn(async () => ({
          rows: [{
            tenant_id: 'tenant-abc',
            role: 'default',
            table_name: 'users',
            effect: null,
            allowed: false,
            priority: null,
            version: null,
            is_active: null,
            start_time: null,
            end_time: null,
          }],
        })),
      },
      sessionContext
    );
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const result = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.error?.details?.reason).toBe('TABLE_DENIED');
    expect(handler).not.toHaveBeenCalled();
  });
});

