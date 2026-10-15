# Rehearsal security policy

Rehearsal handles sensitive database topology and may process sanitized derivatives of
production data. Do not include credentials, connection strings, raw data, or a real
baseline in a public report.

Report suspected vulnerabilities through the
[private security form](https://github.com/Ddupasquier/rehearsal-db/security/advisories/new)
in this repository. A GitHub account is required. Do not open a
public issue containing an exploit, secret, hosted target, or source record.

Supported security updates cover the latest released 0.x minor during beta. A security
fix may deliberately tighten configuration or refuse a workflow that an earlier beta
accepted. During beta, reports apply to the latest published release and current `main`.

The threat boundary and remaining responsibilities live in
[docs/security-model.md](docs/security-model.md). Every
release candidate must pass secret-pattern checks, dependency and package-content
audits, the installed Linux fixture, and private-reporting verification. The current
platform evidence covers protected Ubuntu x64 CI and a direct Bookworm arm64 Colima run;
the exact publishable artifact must repeat its required release checks.
