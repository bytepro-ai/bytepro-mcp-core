import { jest } from '@jest/globals';

import { executeToolBoundary } from '../../src/core/executeToolBoundary.js';
import { SessionContext } from '../../src/core/sessionContext.js';
import { CapabilitySet } from '../../src/security/capabilities.js';
import { DBPolicyEngine } from '../../src/security/dbPolicyEngine.js';

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

function utcMs({ y = 2026, m = 0, d = 1, hh = 0, mm = 0, ss = 0 } = {}) {
  return Date.UTC(y, m, d, hh, mm, ss);
}

describe('Governance: DBPolicyEngine integration (executeToolBoundary)', () => {
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

  it('2) Policy engine attached, no matching policy → deny', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const mockPolicyAdapter = {
      executeQuery: jest.fn(async () => ({ rows: [] })),
    };

    const policyEngine = new DBPolicyEngine({ ttlMs: 300000 });
    await policyEngine.initialize(mockPolicyAdapter, sessionContext);
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

  it('3) Explicit allow policy → allow', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const mockPolicyAdapter = {
      executeQuery: jest.fn(async () => ({
        rows: [
          {
            tenant_id: sessionContext.tenant,
            role: 'default',
            table_name: 'users',
            allowed: true,
            start_time: null,
            end_time: null,
          },
        ],
      })),
    };

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(mockPolicyAdapter, sessionContext);
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

  it('4) Explicit deny policy → deny (overrides prior allows in pipeline)', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const mockPolicyAdapter = {
      executeQuery: jest.fn(async () => ({
        rows: [
          {
            tenant_id: sessionContext.tenant,
            role: 'default',
            table_name: 'users',
            allowed: false,
            start_time: null,
            end_time: null,
          },
        ],
      })),
    };

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(mockPolicyAdapter, sessionContext);
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

  it('Explicit deny overrides allow on same table (duplicate rows)', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const mockPolicyAdapter = {
      executeQuery: jest.fn(async () => ({
        rows: [
          {
            tenant_id: sessionContext.tenant,
            role: 'default',
            table_name: 'users',
            allowed: true,
            start_time: null,
            end_time: null,
          },
          {
            tenant_id: sessionContext.tenant,
            role: 'default',
            table_name: 'users',
            allowed: false,
            start_time: null,
            end_time: null,
          },
        ],
      })),
    };

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(mockPolicyAdapter, sessionContext);
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
    expect(handler).not.toHaveBeenCalled();
    expect(adapters.getAdapter).not.toHaveBeenCalled();
  });

  it('5) Time window violation → deny', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const mockPolicyAdapter = {
      executeQuery: jest.fn(async () => ({
        rows: [
          {
            tenant_id: sessionContext.tenant,
            role: 'default',
            table_name: 'users',
            allowed: true,
            start_time: '09:00:00',
            end_time: '17:00:00',
          },
        ],
      })),
    };

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(mockPolicyAdapter, sessionContext);
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const now = utcMs({ hh: 18, mm: 0, ss: 0 });
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

    const mockPolicyAdapter = {
      // Exercise adapter-agnostic result format (array instead of { rows })
      executeQuery: jest.fn(async () => ([
        {
          tenant_id: sessionContext.tenant,
          role: 'default',
          table_name: 'users',
          allowed: true,
          start_time: '22:00:00',
          end_time: '06:00:00',
        },
      ])),
    };

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(mockPolicyAdapter, sessionContext);
    sessionContext.attachPolicyEngine(policyEngine);

    const handler = jest.fn(async () => ({ ok: true }));
    const toolRegistry = makeToolRegistry({ toolName, handler });
    const adapters = makeAdapters();

    const now = utcMs({ hh: 2, mm: 0, ss: 0 });
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

  it('7) Multi-table query where one table denied → deny', async () => {
    const toolName = 'query_read';
    const sessionContext = makeAuthorizedSession({ toolName });

    const mockPolicyAdapter = {
      executeQuery: jest.fn(async () => ({
        rows: [
          {
            tenant_id: sessionContext.tenant,
            role: 'default',
            table_name: 'users',
            allowed: true,
            start_time: null,
            end_time: null,
          },
          {
            tenant_id: sessionContext.tenant,
            role: 'default',
            table_name: 'orders',
            allowed: false,
            start_time: null,
            end_time: null,
          },
        ],
      })),
    };

    const policyEngine = new DBPolicyEngine();
    await policyEngine.initialize(mockPolicyAdapter, sessionContext);
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
});
