import crypto from 'crypto';

const ENFORCED_BY = 'BytePro MCP v0.2.1';

export class AuditRecord {
  constructor(fields) {
    if (!fields.record_id) {
      throw new Error('record_id is required');
    }

    if (!fields.timestamp) {
      throw new Error('timestamp is required');
    }

    if (fields.decision !== 'ALLOW' && fields.decision !== 'DENY') {
      throw new Error('decision must be ALLOW or DENY');
    }

    this.record_id = fields.record_id;
    this.timestamp = fields.timestamp;
    this.request_id = fields.request_id;
    this.model_identity = fields.model_identity;
    this.tenant_id = fields.tenant_id;
    this.resource = fields.resource;
    this.action = fields.action;
    this.policy_id = fields.policy_id;
    this.policy_name = fields.policy_name;
    this.decision = fields.decision;
    this.reason = fields.reason;
    this.data_returned = fields.decision === 'DENY' ? 0 : fields.data_returned;
    this.enforced_by = ENFORCED_BY;
  }

  toJSON() {
    return {
      record_id: this.record_id,
      timestamp: this.timestamp,
      request_id: this.request_id,
      model_identity: this.model_identity,
      tenant_id: this.tenant_id,
      resource: this.resource,
      action: this.action,
      policy_id: this.policy_id,
      policy_name: this.policy_name,
      decision: this.decision,
      reason: this.reason,
      data_returned: this.data_returned,
      enforced_by: this.enforced_by,
    };
  }

  toDisplayString() {
    return `AUDIT RECORD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Record ID:      ${this.record_id}
Timestamp:      ${this.timestamp}
Model:          ${this.model_identity}
Tenant:         ${this.tenant_id}
Attempted:      ${this.action} on ${this.resource}
Policy:         ${this.policy_id} — ${this.reason}
Decision:       ${this.decision}
Data returned:  ${this.data_returned} records
Enforced by:    ${ENFORCED_BY}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  static createId(request_id, timestamp) {
    return crypto
      .createHash('sha256')
      .update(`${request_id}${timestamp}`)
      .digest('hex');
  }
}
