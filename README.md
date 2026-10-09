# Development Templates

Reusable development templates maintained in one neutral repository.

This repository is a **catalog and home for multiple templates**, not a single application's development workflow. Each template lives in its own directory under `templates/`, documents its own prerequisites, and avoids coupling to any consuming project's domain.

## Available templates

| Template | Status | Purpose |
| --- | --- | --- |
| [Development Autoloop](templates/development-autoloop/README.md) | Foundation / not live-enabled | A safe, issue-first automation loop with preflight and reconciliation foundations. |

## Design principles

- **Reusable by default:** no consumer-project names, business rules, specialist names, or domain-specific paths in shared logic.
- **Configuration over forks:** per-project labels, branch names, required checks, provider identifiers, and policy settings belong in each template's configuration.
- **Fail closed:** incomplete API snapshots, unknown automation states, conflicting claims, or unresolved work block live execution.
- **Human control:** external work creation requires explicit authorization during commissioning; merging remains a human decision by default.
- **Separate concerns:** each template must define a small, testable core and document adapters and permissions separately.
- **No secret material:** credentials belong in the consuming repository's GitHub Actions secrets, never in this repository.

## Repository layout

```text
templates/
  development-autoloop/
    .github/
    config/
    docs/
    src/
    tests/
docs/
  TEMPLATE_STANDARDS.md
```

## Adding a template

1. Create a dedicated directory under `templates/<template-name>/`.
2. Add a focused README with purpose, readiness status, setup requirements, risks, and removal/recovery steps.
3. Keep project-specific settings in an example config and do not include secrets.
4. Include automated tests for safety-critical decisions.
5. Validate the template in a disposable repository before declaring it ready for reuse.
6. Update this catalog only after the template has a documented status and successful validation.

## Status vocabulary

- **Design:** architecture is being defined; not ready to install.
- **Foundation:** tested core exists, but operational adapters or end-to-end coverage remain incomplete.
- **Ready for pilot:** tests and setup documentation are complete; install into a disposable test repository first.
- **Stable:** successful pilot completed and known recovery cases documented.

A template being present in this repository does not mean it is safe for unattended live automation.
