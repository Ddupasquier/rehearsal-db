# Auth-platform contract proposal

Status: **proposed design only** for [RDB-170](https://github.com/Ddupasquier/rehearsal-db/issues/170).
No configuration, public API, provider support or executable behavior is added here.
This post-MVP design does not expand the existing extension manual acceptance gate.

Navigation: [owners](#owners-and-current-boundary) · [contract](#proposed-contract) ·
[trust](#trust-and-identity-evidence) · [lifecycle](#sessions-and-reset) ·
[acceptance](#independent-acceptance-plan) · [decisions](#decisions-before-implementation).

## Owners and current boundary

[Supabase authentication](configuration.md#supabase-authentication) owns today's
Google/GitHub configuration and local callback. [Runtime and identity policies](runtime-policies.md#supported-identity-matchers)
own verified-email and provider-subject matching and copied-account association.
The [identity pipeline](architecture.md#identity-claim-pipeline) owns reviewed planning,
local transaction, Storage transfer and recovery. Keep those owners; extend their
contracts only when a separately approved integration requires it.

Separate four concepts:

| Concept                    | Responsibility                                 | Existing example                   |
| -------------------------- | ---------------------------------------------- | ---------------------------------- |
| Auth platform              | Validates credentials/tokens and owns sessions | Local Supabase Auth                |
| Login method               | How the application obtains a normal session   | Password, OAuth authorization code |
| Social provider            | Upstream identity source                       | Google or GitHub                   |
| Copied-account association | Reviewed local transfer after verified sign-in | Existing identity policy           |

Rehearsal configures a qualified disposable integration and reviews its evidence.
The application/platform retains callbacks, token validation, session issuance, roles,
RLS, account blocks and MFA. Rehearsal must not mint impersonation sessions, patch
consumer callbacks or write Auth tables as a substitute for an integration.
Plain PostgreSQL does not gain Supabase Auth through a declaration.

## Proposed contract

The following names describe a future contract, not usable configuration or exports.
Implement a small package-owned registry of reviewed platform/version/method/provider
combinations. Do not discover plugins or accept unrestricted provider names.
Each entry declares its exact supported versions, configuration decoder, credential
reference kinds, local callback derivation, evidence decoder and unsupported reasons.
Unknown versions or combinations fail closed; binary presence is not qualification.

Use a separately advertised version-1 public capability and negotiated review endpoint;
do not silently change existing `authenticationReview` or identity-policy schema 1.
Core owns validation and public JSON. The extension consumes that public contract and
renders unsupported/unknown states; it must not implement another auth engine.

Proposed closed declaration fields:

| Field                                               | Validation/meaning                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `schemaVersion`                                     | Literal `1`; reject unknown versions and keys                                      |
| `platform`, `platformVersion`, `method`, `provider` | Registry identifiers and qualified versions, not arbitrary strings                 |
| `credentialReference`                               | Existing ignored owner-only file plus declared variable names; never secret values |
| `trustProfile`                                      | Reviewed registry-backed issuer, audience/client identity and key policy           |
| `tenant`                                            | Explicit reviewed tenant constraint where the platform is multi-tenant             |
| `callback`                                          | Derived exact local platform callback; application return allowlist is separate    |
| `identityPolicy`                                    | Reference to the existing association owner, not inline transfer instructions      |

Proposed closed public review fields: `schemaVersion`, qualified combination IDs,
`supportState`, `availability`, `reason`, `callback`, `trustSummary`, `credentialState`,
`identityEvidenceState`, and `evidenceScope`. Every nested object also rejects unknown
keys. Exact enums, size limits and generated TypeScript types must be reviewed with the
first implementation, before advertisement. No arbitrary metadata bag is permitted.

`supportState` is `supported`, `unsupported`, `unknown` or `not-applicable`;
`availability` is independently `available`, `unavailable` or `unknown`.
Reasons must be fixed codes such as `qualification_missing`, `version_unqualified`,
`credential_reference_missing`, `trust_unverified` or `identity_ambiguous`.
Configuration review establishes declared facts only. It cannot assert successful
consent, valid current tokens, actual MFA enforcement or completed account association.
Unknown evidence remains unknown; a registry entry never upgrades it to observed.

Read-only review must not read credential values, scan environment files, contact an
issuer, start a service or change provider settings. An explicitly authorized setup
operation alone may resolve declared secret references using the existing private-file
and target-ownership checks. Redact values from output, diagnostics and recovery.

## Trust and identity evidence

OIDC authentication binds a subject to its exact issuer; email is not a substitute
for that identity. [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)
owns ID-token validation requirements. An integration must preserve signature/algorithm,
issuer, audience/authorized-party, expiry and nonce validation in its platform owner.
OAuth-only providers require their own qualified evidence decoder; do not label an
OAuth access token as an OIDC identity token.

Trust profiles must use explicitly reviewed issuer/endpoints and audience/client IDs.
No caller-controlled discovery URL, redirects to arbitrary hosts, private-network
fetch or open redirect is allowed. Any later authorized discovery must bound redirects,
response size, deadline and key count, enforce HTTPS and exact issuer equality, and
revalidate every destination. Key rotation must preserve issuer/algorithm binding;
an unknown key or ambiguous issuer fails closed rather than fetching arbitrary URLs.

Retain state, nonce and PKCE protections in the ordinary application/platform flow;
use authorization-code guidance from [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html).
A local callback exception must be explicitly platform-qualified and must not weaken
upstream HTTPS trust. Do not disable checks to make a fixture pass.

Extend existing identity matching only with an explicit platform/evidence discriminator
and issuer-plus-subject/tenant binding. Preserve reviewed hashed selectors and exact
one-match semantics. Raw subjects, emails and tokens must not enter tracked policy,
public JSON, logs or recovery records. Hashes are sensitive selectors, not anonymity.
Verified-email association requires an explicit approved policy and verified evidence
from a qualified provider; refuse missing verification, conflicting provider records,
multiple matches, cross-tenant evidence and stale or mismatched reviewed plans.
Do not silently merge accounts by a shared email address.

## Sessions and reset

Keep the existing exact-plan confirmation, transaction, concurrency guard and recovery
owner for association. Repeating an unchanged completed association should be
idempotent; a changed graph, runtime, trust profile or identity requires fresh review.
Application roles, database-backed claims, RLS, blocks and MFA remain effective after
association. Existing browser JWTs require normal refresh or sign-in.

A reset may invalidate only the owned local grants/session state for which the chosen
platform has a qualified invalidation mechanism. Define effects on access and refresh
tokens separately: an already-issued token may remain valid until expiry unless the
platform actually enforces revocation. Verify this instead of promising immediate loss
of access. Preserve unrelated runtimes and immutable baselines/recovery evidence.
Upstream-provider logout or token revocation is a different operation requiring its own
authority and proof; local reset must not claim or request it implicitly.

## Compatibility and migration

Existing Google/GitHub setup, email identity matching and schema-1 reviews remain
unchanged until an explicit compatibility design is approved. Offer a deterministic
reviewed migration from existing declarations; never reinterpret a provider name as an
issuer or auto-enable a provider. Refuse mixed old/new declarations that duplicate
ownership. Older Core or clients without the new advertised contract show an explicit
unsupported state and retain existing workflows; no fallback to guessed JSON.

## Independent acceptance plan

Test Lab should consume the exact installed Core artifact through public interfaces.
Its [coverage owner](https://github.com/Ddupasquier/rehearsal-test-lab/blob/main/docs/expansion-coverage.md)
and [runbook](https://github.com/Ddupasquier/rehearsal-test-lab/blob/main/docs/runbook.md)
own scenario execution. This proposal adds no job, gate, runtime or installation.

Smallest later synthetic fixture: one owned disposable local Supabase project, a tiny
ordinary sign-in application, two synthetic tenants, one reviewed copied account,
role/RLS and blocked-account canaries, and one unrelated preserved account. A controlled
issuer fixture may supply valid and deliberately invalid signed evidence through the
qualified platform flow; it must never write fake Auth rows or return fake readiness.
Use fixed synthetic keys and ignored credential files only; no production identities.

| Layer                           | Required observations                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure decoder/public JSON        | Positive closed schemas; unknown keys/versions/provider; limits; no secret leakage; old-client behavior                                    |
| Synthetic installed integration | Ordinary login; exact issuer/subject/tenant; association and idempotence; role/RLS/block/MFA preservation                                  |
| Negative security               | Wrong audience/issuer/key/nonce; replay; unverified email; ambiguous/conflicting/cross-tenant match; redirect/discovery refusal            |
| Lifecycle                       | Refresh/logout; restart persistence; reset access/refresh-token effects; stale confirmation; interruption/deadline; concurrent association |
| Preservation                    | No unrelated account/runtime/Storage change; baseline and recovery retained; owned cleanup receipts                                        |
| Genuine provider/manual         | Actual browser consent, callback registration, provider-specific evidence and real MFA, separately authorized and attributed               |

Record exact platform/provider/runtime/artifact versions and which observations are
synthetic, genuine, unavailable or manual. Existing sufficient identity scenarios may
be reused with an explicit acceptance mapping. A mock, successful metadata query or
generic green suite is not proof of a new provider or platform.

## Decisions before implementation

Select the first additional auth platform/provider and supported version, its precise
local capability, trust/key model and evidence source. Confirm whether it is feasible
without external accounts or paid services. Review exact schema names/limits and
backward compatibility alongside the paired Lab scenario before coding.
Provider registration, account consent, installations, service execution, licenses,
legal/billing choices and genuine-provider runs require their own applicable authority.
This proposal approves none of them and does not close current manual acceptance.
