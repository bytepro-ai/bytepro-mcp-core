# Security Policy

## Project Status

BytePro MCP Core is an **experimental project** under active development. While we implement security controls and follow a fail-closed philosophy, this software is provided as-is without guarantees of security, stability, or support.

## Supported Versions

Security updates are limited to the current development branch. This project does not currently maintain separate release branches or provide backports.

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| other   | :x:                |

**Note**: As an experimental project, we make no guarantees about backward compatibility or long-term maintenance of any version.

## Reporting a Vulnerability

We take security issues seriously and appreciate responsible disclosure. If you discover a security vulnerability, please report it through one of the following channels:

### Preferred Method: GitHub Security Advisory

Report vulnerabilities privately using [GitHub Security Advisories](https://github.com/[owner]/bytepro-mcp-core/security/advisories/new).

### Alternative: Email

Send detailed reports to: **security@[your-domain]**

## What to Include in Your Report

A complete vulnerability report should contain:

1. **Description**: Clear explanation of the vulnerability
2. **Impact**: Potential security implications and affected components
3. **Reproduction**: Step-by-step instructions to reproduce the issue
4. **Environment**: Operating system, database type, Node.js version, and configuration details
5. **Proof of Concept**: Code, queries, or commands demonstrating the vulnerability (if applicable)
6. **Suggested Fix**: Your recommended remediation approach (optional)

### Critical Security Contexts

When reporting vulnerabilities, please specify which security boundaries are affected:

- Query validation and sanitization
- Read-only enforcement
- Authorization checks
- Audit logging
- Quota enforcement
- Session context isolation
- Allowlist validation

## What NOT to Disclose Publicly

**Do not** publicly disclose security vulnerabilities through:

- Public GitHub issues
- Pull requests with vulnerability details in titles or descriptions
- Social media posts
- Public forums or chat channels
- Conference talks (without prior coordination)

Coordinated disclosure protects users who may be running vulnerable versions. We prefer to fix issues before they become publicly known.

## Response Expectations

This is an experimental project maintained without dedicated security resources. Our response follows a **best-effort** model:

- **No SLA**: We cannot guarantee response times
- **No Guarantees**: We may not be able to address all reported issues
- **Limited Resources**: Complex fixes may take significant time or be deferred
- **Communication**: We will acknowledge receipt and provide updates when possible

Despite these limitations, we prioritize security issues when feasible and appreciate your patience.

## Coordinated Disclosure Process

Our preferred disclosure timeline:

1. **Day 0**: Researcher reports vulnerability privately
2. **Day 1-7**: We acknowledge receipt and begin assessment
3. **Day 7-90**: We develop, test, and deploy a fix
4. **Day 90+**: Coordinated public disclosure (if fix is ready)

However, given the experimental nature of this project, timelines may vary significantly. We ask for flexibility and will communicate delays transparently.

## Safe Harbor

We support security research conducted in good faith. If you:

- Make a good faith effort to avoid privacy violations, data destruction, and service interruption
- Only interact with accounts you own or have explicit permission to test
- Do not exploit vulnerabilities beyond the minimum necessary to demonstrate impact
- Report vulnerabilities promptly through appropriate channels
- Allow reasonable time for fixes before public disclosure

Then we will:

- Not pursue legal action related to your research
- Work with you to understand and validate your report
- Acknowledge your contribution (if desired) when the issue is publicly disclosed

## Security Philosophy

BytePro MCP Core follows a **fail-closed security model**:

- Authorization checks occur before any database operations
- Unknown tools produce zero side effects
- Read-only enforcement blocks all write operations
- Session context failures prevent query execution
- Validation failures result in rejection, not degradation

This approach prioritizes security over availability. When in doubt, the system denies access rather than proceeding with potentially unsafe operations.

## Scope

Security concerns within scope:

- SQL injection vulnerabilities
- Authorization bypass
- Read-only enforcement bypass
- Audit log tampering or omission
- Session isolation failures
- Quota bypass or enforcement failures
- Path traversal in schema introspection
- Denial of service through resource exhaustion

Out of scope (experimental limitations):

- Availability guarantees
- Performance issues without security impact
- Feature requests
- Configuration recommendations
- Third-party vulnerabilities (report to respective maintainers)

## Security Documentation

Additional security documentation is available in the repository:

- [SECURITY-INVARIANTS.md](SECURITY-INVARIANTS.md) - Core security properties
- [SECURITY-CHANGE-CHECKLIST.md](SECURITY-CHANGE-CHECKLIST.md) - Security review checklist
- [docs/audit-logging.md](docs/audit-logging.md) - Audit logging architecture

## Contact

For security-related questions or concerns:

- Security reports: Use GitHub Security Advisories or security@[your-domain]
- General questions: Open a public GitHub issue (without vulnerability details)

---

**Last Updated**: January 2026

**Note**: This security policy reflects the current experimental state of the project. Terms may change as the project matures.
