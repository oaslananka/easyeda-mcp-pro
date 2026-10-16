> **First-time contributor?** Please fill in **Summary** and **Validation**
> below, and mention any risks you know about. The maintainer handles the
> critical-path, security, bot-review, and release checklists. No forms,
> external sign-up, or per-commit DCO sign-off are required.

## Summary

<!-- What changed and why? Keep the scope focused. -->

## Risk

- Risk level: <!-- low / medium / high -->
- Affected areas: <!-- server / bridge extension / CI / security / release / docs -->
- Rollback plan: <!-- how this change can be reverted or disabled -->

## Critical-path review

- [ ] This PR does not touch a critical path listed in [Repository Governance](../docs/REPOSITORY_GOVERNANCE.md).
- [ ] This PR touches a critical path; CODEOWNERS and the affected risk area are identified below.
- Critical paths and owners: <!-- paths + @owner -->
- Independent human reviewer: <!-- reviewer, or explain the documented solo-maintainer enforcement limitation -->
- Author self-review evidence: <!-- permissions, secrets, fork behavior, mutation/release impact, rollback -->

## External contributions

No paperwork or per-commit DCO sign-off. For your first **substantial** code
contribution, a maintainer will ask you to accept the short
[one-time contributor permission](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CONTRIBUTOR-LICENSING.md) in a PR comment.
Trivial changes and automated dependency PRs are exempt; returning contributors
do not repeat acceptance.

## Validation

<!-- Check only what was actually run. Add commands or CI links where useful. -->

- [ ] `pnpm verify`
- [ ] Targeted tests added or updated
- [ ] Documentation updated when behavior or configuration changed
- [ ] Manual or live EasyEDA validation completed when required

## Security and supply chain

- [ ] No secrets, credentials, private design data, or generated reports are committed
- [ ] New dependencies are justified and exact-pinned where appropriate
- [ ] GitHub Actions remain pinned to full commit SHAs
- [ ] Permissions, fork behavior, and untrusted inputs were reviewed for workflow changes
- [ ] Breaking changes and release impact are documented

## Automated review disposition

- [ ] Every inline human, bot, and agent review thread is resolved.
- [ ] Top-level bot and agent comments were inspected even when their checks passed.
- [ ] Valid findings were fixed and false positives or accepted risks have an explicit rationale.

| Source | Finding or comment URL | Resolution or disposition evidence |
| ------ | ---------------------- | ---------------------------------- |
|        |                        |                                    |

## Emergency exception evidence

- [ ] Not applicable; normal governance controls were used.
- Public/private incident record: <!-- URL -->
- Control changed or bypassed and public rationale: <!-- exact setting + why -->
- Known-good rollback target: <!-- SHA/tag/settings -->
- Follow-up review owner and due date: <!-- within two business days -->

## Related work

Closes #<!-- issue number, when applicable -->
