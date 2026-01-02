import { executeToolBoundary } from "../../src/core/executeToolBoundary.js";
import { SessionContext } from "../../src/core/sessionContext.js";
import { CapabilitySet } from "../../src/security/capabilities.js";
import { jest } from '@jest/globals';

describe("Security invariant: Authorization precedes execution", () => {
  it("DENIES and prevents execution when authorization fails", async () => {
    // GIVEN: Valid SessionContext (constructed via real class to pass isValidSessionContext check)
    const sessionContext = new SessionContext();
    sessionContext.bind("user-123", "tenant-abc", "sess-xyz");
    
    // GIVEN: Real CapabilitySet with NO grants (ensures denial)
    // We construct a valid, non-expired capability set but with empty grants.
    const now = Date.now();
    const capabilities = new CapabilitySet({
      capSetId: "cap-set-test-1",
      issuedAt: now,
      expiresAt: now + 3600000, // 1 hour from now
      issuer: "test-issuer",
      grants: [] // Empty grants = explicit deny for any action
    });
    
    sessionContext.attachCapabilities(capabilities);

    // GIVEN: Tool with spyable execute
    const toolExecuteSpy = jest.fn(async () => ({ ok: true, value: "should-not-run" }));
    const toolName = "sensitiveTool";
    
    const toolRegistry = {
      tools: new Map([
        [toolName, {
          name: toolName,
          handler: toolExecuteSpy,
          inputSchema: { safeParse: () => ({ success: true, data: {} }) }
        }]
      ])
    };

    // GIVEN: Adapters (should not be called if auth fails)
    const dbAdapterSpy = { query: jest.fn() };
    const adapters = {
      getAdapter: () => ({ name: "mock-db", ...dbAdapterSpy }),
      activeAdapter: { name: "mock-db" }
    };

    // WHEN: executeToolBoundary is invoked
    const result = await executeToolBoundary({
      toolName,
      input: {},
      sessionContext,
      toolRegistry,
      adapters,
      mode: { readOnly: false },
      meta: { nowMs: Date.now() }
    });

    // THEN: Observable denial
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(['UNAUTHORIZED', 'DENIED', 'AUTHORIZATION_DENIED']).toContain(result.error.code);

    // THEN: Zero side effects
    expect(toolExecuteSpy).not.toHaveBeenCalled();
    expect(dbAdapterSpy.query).not.toHaveBeenCalled();
  });
});
