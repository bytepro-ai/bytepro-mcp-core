import { executeToolBoundary } from '../src/core/executeToolBoundary.js';
import { SessionContext } from '../src/core/sessionContext.js';
import { CapabilitySet } from '../src/security/capabilities.js';
import { DBPolicyEngine } from '../src/security/dbPolicyEngine.js';

function makeAuthorizedSession({ tenant, identity, toolName, role } = {}) {
  const sessionContext = new SessionContext(role ? { role } : undefined);
  sessionContext.bind(identity || 'demo-user', tenant, `sess-${tenant}`);

  const now = Date.now();
  const capabilities = new CapabilitySet({
    capSetId: `cap-${tenant}`,
    issuedAt: now,
    expiresAt: now + 24 * 3600000,
    issuer: 'demo',
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

function makeAdapters({ name = 'mock-mysql' } = {}) {
  const adapter = {
    name,
    executeQuery: async () => ({ rows: [], rowCount: 0 }),
  };

  return {
    getAdapter: () => adapter,
    activeAdapter: adapter,
  };
}

function utcMs({ y = 2026, m = 0, d = 1, hh = 0, mm = 0, ss = 0 } = {}) {
  return Date.UTC(y, m, d, hh, mm, ss);
}

async function withFakeNow(fakeNowMs, fn) {
  const originalNow = Date.now;
  Date.now = () => fakeNowMs;
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

function printQueryHeader(label) {
  // eslint-disable-next-line no-console
  console.log(`\n===== ${label} =====`);
}

function printQuerySummary({ label, tenant, role, result }) {
  const allowed = Boolean(result?.ok);
  const status = allowed ? 'ALLOWED' : 'DENIED';
  const reason =
    allowed
      ? ''
      : result?.error?.details?.reason || result?.error?.code || result?.error?.message || 'UNKNOWN';

  // eslint-disable-next-line no-console
  console.log(
    `Summary: label=${JSON.stringify(label)} tenant=${JSON.stringify(tenant)} role=${JSON.stringify(role)} result=${status}${
      reason ? ` reason=${JSON.stringify(reason)}` : ''
    }`
  );
}

function printQueryDetails(payload) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const toolName = 'query_read';
  const BASE_NOW = utcMs({ y: 2026, m: 1, d: 17, hh: 10, mm: 0, ss: 0 });

  // Tool handler: represents the data-plane tool implementation.
  // If governance denies, this must NOT run.
  let handlerCalls = 0;
  const handler = async (input, adapter, sessionContext) => {
    handlerCalls += 1;
    return {
      ok: true,
      executed: true,
      adapter: adapter?.name,
      tenant: sessionContext?.tenant,
      query: input?.query,
    };
  };

  const toolRegistry = makeToolRegistry({ toolName, handler });
  const adapters = makeAdapters();

  // Seed policies via mock policy adapter
  const seededPolicies = [
    // Tenant B: users always allowed
    { tenant_id: 'tenantB', role: 'default', table_name: 'users', allowed: true, start_time: null, end_time: null },

    // Tenant B: orders allowed only in UTC window that crosses midnight
    { tenant_id: 'tenantB', role: 'default', table_name: 'orders', allowed: true, start_time: '22:00:00', end_time: '06:00:00' },

    // Tenant B: secrets allow then deny (explicit deny precedence via last row wins)
    { tenant_id: 'tenantB', role: 'default', table_name: 'secrets', allowed: true, start_time: null, end_time: null },
    { tenant_id: 'tenantB', role: 'default', table_name: 'secrets', allowed: false, start_time: null, end_time: null },

    // Tenant A: no row for users -> fail-closed NO_POLICY (tenant A denied)
  ];

  const policyAdapter = {
    executeQuery: async () => ({ rows: seededPolicies }),
  };

  // Create ONE policy engine instance (shared)
  const policyEngine = new DBPolicyEngine({ ttlMs: 300000 });

  let sessionA;
  let sessionB;

  await withFakeNow(BASE_NOW, async () => {
    // Initialize it with a dedicated loader session
    const loaderSession = makeAuthorizedSession({
      tenant: 'system',
      identity: 'policy-loader',
      toolName,
    });

    await policyEngine.initialize(policyAdapter, loaderSession);

    // Q1: Tenant A denied (NO_POLICY)
    handlerCalls = 0;
    sessionA = makeAuthorizedSession({ tenant: 'tenantA', identity: 'alice', toolName });
    sessionA.attachPolicyEngine(policyEngine);

    printQueryHeader('Q1: Tenant A (users)');
    const res1 = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext: sessionA,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    printQuerySummary({ label: 'Q1: Tenant A (users)', tenant: sessionA.tenant, role: sessionA.role, result: res1 });
    printQueryDetails({ result: res1, handlerCalls });

    // Q2: Tenant B allowed (users)
    handlerCalls = 0;
    sessionB = makeAuthorizedSession({ tenant: 'tenantB', identity: 'bob', toolName });
    sessionB.attachPolicyEngine(policyEngine);

    printQueryHeader('Q2: Tenant B (users)');
    const res2 = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users', params: [] },
      sessionContext: sessionB,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    printQuerySummary({ label: 'Q2: Tenant B (users)', tenant: sessionB.tenant, role: sessionB.role, result: res2 });
    printQueryDetails({ result: res2, handlerCalls });
  });

  // Scenario 3: Time window deny (orders at 12:00 UTC)
  handlerCalls = 0;
  printQueryHeader('Q3: Tenant B (orders @ 12:00 UTC)');
  const res3 = await withFakeNow(utcMs({ y: 2026, m: 1, d: 17, hh: 12, mm: 0, ss: 0 }), async () =>
    executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.orders', params: [] },
      sessionContext: sessionB,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    })
  );

  printQuerySummary({
    label: 'Q3: Tenant B (orders @ 12:00 UTC)',
    tenant: sessionB.tenant,
    role: sessionB.role,
    result: res3,
  });
  printQueryDetails({ result: res3, handlerCalls });

  // Scenario 4: Midnight-crossing allow (orders at 02:00 UTC)
  handlerCalls = 0;
  printQueryHeader('Q4: Tenant B (orders @ 02:00 UTC)');
  const res4 = await withFakeNow(utcMs({ y: 2026, m: 1, d: 17, hh: 2, mm: 0, ss: 0 }), async () =>
    executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.orders', params: [] },
      sessionContext: sessionB,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    })
  );

  printQuerySummary({
    label: 'Q4: Tenant B (orders @ 02:00 UTC)',
    tenant: sessionB.tenant,
    role: sessionB.role,
    result: res4,
  });
  printQueryDetails({ result: res4, handlerCalls });

  // Scenario 5: Explicit deny precedence (secrets)
  await withFakeNow(BASE_NOW, async () => {
    handlerCalls = 0;
    printQueryHeader('Q5: Tenant B (secrets)');
    const res5 = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.secrets', params: [] },
      sessionContext: sessionB,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    printQuerySummary({ label: 'Q5: Tenant B (secrets)', tenant: sessionB.tenant, role: sessionB.role, result: res5 });
    printQueryDetails({ result: res5, handlerCalls });

    // Scenario 6: Multi-table join where one denied (users + secrets)
    handlerCalls = 0;
    printQueryHeader('Q6: Tenant B (users + secrets)');
    const res6 = await executeToolBoundary({
      toolName,
      input: { query: 'SELECT * FROM app.users u JOIN app.secrets s ON u.id = s.user_id', params: [] },
      sessionContext: sessionB,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() },
    });

    printQuerySummary({
      label: 'Q6: Tenant B (users + secrets)',
      tenant: sessionB.tenant,
      role: sessionB.role,
      result: res6,
    });
    printQueryDetails({ result: res6, handlerCalls });
  });

  // eslint-disable-next-line no-console
  console.log('\nDemo complete. Review audit logs above for authz + db_policy decisions.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Demo failed:', err);
  process.exitCode = 1;
});
