# Template standards

## Purpose

This repository hosts multiple reusable development templates. A template must solve a distinct repeatable problem and remain independent of any consuming project's product domain.

## Required contents

Each template directory must include:
- a README with purpose, maturity status, setup, required permissions, risks, teardown/recovery, and a dedicated **consuming-repository Environment and secrets setup** section;
- a precise list of secret names that are required now, required only by a future/optional adapter, or explicitly **none required yet**;
- the Environment name actually referenced by its workflows, or an explicit statement that no Environment is referenced yet;
- clear separation between values GitHub Actions provides automatically (such as `GITHUB_TOKEN`) and secrets a repository owner must create manually;
- instructions for creating secrets under the consuming repository's Settings → Environments when an Environment is used;
- a warning that Environment configuration and secrets do not copy into repositories created from a template; never include credential values;
- example configuration with safe defaults and no secrets;
- tests for safety-critical decision logic;
- a documented implementation plan and known gaps;
- least-privilege workflow permissions.

Do not document a future secret as a present requirement. If a template has no active integration that needs credentials, its README must say **none required yet** and name any future-only secret separately.

## Quality gates

Before a template may be marked Ready for pilot:
1. Tests and static checks pass on the exact reviewed commit.
2. Live actions are disabled by default or require an explicit, exact authorization.
3. Unknown states, partial API results, and failed persistence block execution.
4. Duplicate-work and stale-state recovery have tests.
5. A disposable-repository installation has been completed and documented.
6. Its setup documentation identifies the exact current workflow Environment/secrets and any manual consuming-repository setup.
7. Acknowledgement comments or reactions are never accepted as proof of task progress or completion; task status must be reconciled from observable evidence.

## Naming and boundaries

Use generic workflow names, neutral issue labels, and configuration-driven paths. Product-specific adapters belong behind documented interfaces and must not leak into shared decision functions.

## Versioning and lifecycle

Each template owns its status and version. The catalog at the repository root should only call a template Ready for pilot after its tests and docs support that status. Template availability does not imply approval for unattended production execution.
