import { AuditRecord } from './auditRecord.js';

const baseFields = {
  record_id: 'record-123',
  timestamp: '2026-04-29T15:43:00.000Z',
  request_id: 'request-456',
  model_identity: 'claude-4.6',
  tenant_id: 'tenant-789',
  resource: 'customers',
  action: 'read',
  policy_id: 'policy-001',
  policy_name: 'Customer read policy',
  decision: 'ALLOW',
  reason: 'Matched read policy',
  data_returned: 7,
  enforced_by: 'BytePro MCP v0.2.1',
};

describe('AuditRecord', () => {
  it('creates record with correct fields', () => {
    const record = new AuditRecord(baseFields);

    expect(record.record_id).toBe(baseFields.record_id);
    expect(record.timestamp).toBe(baseFields.timestamp);
    expect(record.request_id).toBe(baseFields.request_id);
    expect(record.model_identity).toBe(baseFields.model_identity);
    expect(record.tenant_id).toBe(baseFields.tenant_id);
    expect(record.resource).toBe(baseFields.resource);
    expect(record.action).toBe(baseFields.action);
    expect(record.policy_id).toBe(baseFields.policy_id);
    expect(record.policy_name).toBe(baseFields.policy_name);
    expect(record.decision).toBe(baseFields.decision);
    expect(record.reason).toBe(baseFields.reason);
    expect(record.data_returned).toBe(baseFields.data_returned);
    expect(record.enforced_by).toBe(baseFields.enforced_by);
  });

  it('returns all fields as plain object', () => {
    const record = new AuditRecord(baseFields);

    expect(record.toJSON()).toEqual(baseFields);
  });

  it('contains all display field values', () => {
    const record = new AuditRecord(baseFields);
    const display = record.toDisplayString();

    expect(display).toContain(baseFields.record_id);
    expect(display).toContain(baseFields.timestamp);
    expect(display).toContain(baseFields.model_identity);
    expect(display).toContain(baseFields.tenant_id);
    expect(display).toContain(baseFields.action);
    expect(display).toContain(baseFields.resource);
    expect(display).toContain(baseFields.policy_id);
    expect(display).toContain(baseFields.reason);
    expect(display).toContain(baseFields.decision);
    expect(display).toContain(`${baseFields.data_returned} records`);
    expect(display).toContain(baseFields.enforced_by);
  });

  it('returns same ID for same inputs', () => {
    const requestId = 'request-456';
    const timestamp = '2026-04-29T15:43:00.000Z';

    expect(AuditRecord.createId(requestId, timestamp)).toBe(
      AuditRecord.createId(requestId, timestamp)
    );
  });

  it('throws if decision is not ALLOW or DENY', () => {
    expect(() => new AuditRecord({ ...baseFields, decision: 'MAYBE' })).toThrow(
      'decision must be ALLOW or DENY'
    );
  });

  it('sets data_returned to 0 when decision is DENY', () => {
    const record = new AuditRecord({
      ...baseFields,
      decision: 'DENY',
      data_returned: 12,
    });

    expect(record.data_returned).toBe(0);
  });
});
