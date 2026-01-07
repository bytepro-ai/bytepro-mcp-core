import { describe, expect, test, jest } from "@jest/globals";

import { executeToolBoundary } from "../../src/core/executeToolBoundary.js";
import { SessionContext } from "../../src/core/sessionContext.js";
import { CapabilityAction, CapabilitySet } from "../../src/security/capabilities.js";

import { addCustomerTool } from "../../examples/mysql-write-controlled/tools/addCustomer.js";

function createBoundSessionContext({ grants }) {
	const sessionContext = new SessionContext();
	sessionContext.bind("user-1", "tenant-1", "session-1");

	const now = Date.now();
	const capabilities = new CapabilitySet({
		capSetId: "cap-set-write-tool-controlled-test",
		issuedAt: now,
		expiresAt: now + 60 * 60 * 1000,
		issuer: "test-issuer",
		grants,
	});
	sessionContext.attachCapabilities(capabilities);

	return sessionContext;
}

function createMockAdapterHarness() {
	const connection = {
		query: jest.fn(async () => [{ insertId: 123 }]),
		release: jest.fn(),
	};

	const adapter = {
		name: "mock-mysql",
		config: { database: "sakila" },
		pool: {
			getConnection: jest.fn(async () => connection),
		},
	};

	const adapters = {
		activeAdapter: adapter,
		getAdapter: jest.fn(() => adapter),
	};

	return { adapters, adapter, connection };
}

function createToolRegistryWithHandlerSpy() {
	const handlerSpy = jest.fn(addCustomerTool.handler);
	const toolRegistry = {
		tools: new Map([
			[
				"add_customer",
				{
					...addCustomerTool,
					handler: handlerSpy,
				},
			],
		]),
	};

	return { toolRegistry, handlerSpy };
}

function validAddCustomerInput() {
	return {
		store_id: 1,
		first_name: "Ada",
		last_name: "Lovelace",
		email: "ada@example.com",
		address_id: 1,
	};
}

describe("security invariant: write tool is controlled (add_customer)", () => {
	test("TEST 1 — READ_ONLY blocks writes", async () => {
		const sessionContext = createBoundSessionContext({
			grants: [{ action: CapabilityAction.TOOL_INVOKE, target: "add_customer" }],
		});

		const { toolRegistry, handlerSpy } = createToolRegistryWithHandlerSpy();
		const { adapters, adapter, connection } = createMockAdapterHarness();

		const result = await executeToolBoundary({
			toolName: "add_customer",
			input: validAddCustomerInput(),
			sessionContext,
			toolRegistry,
			adapters,
			mode: { readOnly: true },
			meta: { requestId: "test-req-readonly", nowMs: Date.now() },
		});

		expect(result).toBeTruthy();
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		expect(result.error.code).toBe("READ_ONLY");

		expect(handlerSpy).not.toHaveBeenCalled();
		expect(adapters.getAdapter).not.toHaveBeenCalled();

		expect(adapter.pool.getConnection).not.toHaveBeenCalled();
		expect(connection.query).not.toHaveBeenCalled();
		expect(connection.release).not.toHaveBeenCalled();
	});

	test("TEST 2 — Missing capability blocks writes", async () => {
		const sessionContext = createBoundSessionContext({ grants: [] });

		const { toolRegistry, handlerSpy } = createToolRegistryWithHandlerSpy();
		const { adapters, adapter, connection } = createMockAdapterHarness();

		const result = await executeToolBoundary({
			toolName: "add_customer",
			input: validAddCustomerInput(),
			sessionContext,
			toolRegistry,
			adapters,
			mode: { readOnly: false },
			meta: { requestId: "test-req-no-cap", nowMs: Date.now() },
		});

		expect(result).toBeTruthy();
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		expect(["UNAUTHORIZED", "DENIED"]).toContain(result.error.code);

		expect(handlerSpy).not.toHaveBeenCalled();
		expect(adapters.getAdapter).not.toHaveBeenCalled();

		expect(adapter.pool.getConnection).not.toHaveBeenCalled();
		expect(connection.query).not.toHaveBeenCalled();
		expect(connection.release).not.toHaveBeenCalled();
	});

	test("TEST 3 — Successful write (happy path)", async () => {
		const sessionContext = createBoundSessionContext({
			grants: [{ action: CapabilityAction.TOOL_INVOKE, target: "add_customer" }],
		});

		const { toolRegistry, handlerSpy } = createToolRegistryWithHandlerSpy();
		const { adapters, adapter, connection } = createMockAdapterHarness();

		const result = await executeToolBoundary({
			toolName: "add_customer",
			input: validAddCustomerInput(),
			sessionContext,
			toolRegistry,
			adapters,
			mode: { readOnly: false },
			meta: { requestId: "test-req-happy", nowMs: Date.now() },
		});

		expect(result).toBeTruthy();
		expect(result.ok).toBe(true);
		expect(result.toolName).toBe("add_customer");

		expect(handlerSpy).toHaveBeenCalledTimes(1);
		expect(adapters.getAdapter).toHaveBeenCalledTimes(1);

		expect(adapter.pool.getConnection).toHaveBeenCalledTimes(1);
		expect(connection.query).toHaveBeenCalledTimes(1);
		expect(connection.release).toHaveBeenCalledTimes(1);
	});

	test("TEST 4 — Zero side effects on denial", async () => {
		const deniedCases = [
			{
				name: "readOnly denial",
				sessionContext: createBoundSessionContext({
					grants: [{ action: CapabilityAction.TOOL_INVOKE, target: "add_customer" }],
				}),
				mode: { readOnly: true },
			},
			{
				name: "missing capability denial",
				sessionContext: createBoundSessionContext({ grants: [] }),
				mode: { readOnly: false },
			},
		];

		for (const c of deniedCases) {
			const { toolRegistry, handlerSpy } = createToolRegistryWithHandlerSpy();
			const { adapters, adapter, connection } = createMockAdapterHarness();

			const result = await executeToolBoundary({
				toolName: "add_customer",
				input: validAddCustomerInput(),
				sessionContext: c.sessionContext,
				toolRegistry,
				adapters,
				mode: c.mode,
				meta: { requestId: `test-req-deny-${c.name}`, nowMs: Date.now() },
			});

			expect(result).toBeTruthy();
			expect(result.ok).toBe(false);

			expect(handlerSpy).not.toHaveBeenCalled();
			expect(adapters.getAdapter).not.toHaveBeenCalled();

			expect(adapter.pool.getConnection).not.toHaveBeenCalled();
			expect(connection.query).not.toHaveBeenCalled();
			expect(connection.release).not.toHaveBeenCalled();
		}
	});
});
