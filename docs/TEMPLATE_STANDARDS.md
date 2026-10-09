# Template standards

## Purpose
This repository hosts multiple reusable development templates. A template must solve a distinct repeatable problem and remain independent of any consuming project's product domain.

## Required contents
Each template directory must include:
- a README with purpose, maturity status, setup, required permissions/secrets, risks, and teardown/recovery;
- example configuration with safe defaults and no secrets;
- tests for safety-critical decision logic;
- a documented implementation plan and known gaps;
- least-privilege workflow permissions.

## Quality gates
Before a template may be marked Ready for pilot:
1. Tests and static checks pass.
2. Live actions are disabled by default or require an explicit, exact authorization.
3. Unknown states, partial API results, and failed persistence block execution.
4. Duplicate-work and stale-state recovery have tests.
5. A disposable-repository installation has been completed and documented.

## Naming and boundaries
Use generic workflow names, neutral issue labels, and configuration-driven paths. Product-specific adapters belong behind documented interfaces and must not leak into shared decision functions.

## Versioning and lifecycle
Each template owns its status and version. The catalog at the repository root should only call a template Ready for pilot after its tests and docs support that status. Template availability does not imply approval for unattended production execution.
