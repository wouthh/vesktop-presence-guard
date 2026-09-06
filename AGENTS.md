# PresenceGuard repository guidance

Policy: `implementation-review-loop-v1`. Adapted from the reviewed AI-assisted
engineering playbook at `bd51a9360e3e46d3ad5b0f4f2fb25b644995bd2a`.

## Purpose and layout

PresenceGuard is an unofficial Vencord userplugin for observing the signed-in
account's status and optionally managing Idle/DND on a GNOME Vesktop desktop.
`src/` owns the plugin and pure decision/detector logic; `helper/` owns the
process-bound GNOME observer; `scripts/` owns checks and installation;
`tests/` contains synthetic fixtures. No nested instruction overrides exist.

## Protected state and invariants

- Never acquire status ownership except from positively confirmed Online.
- Manual selections, including the same value and duration edits, revoke
  ownership before asynchronous work. Unknown never means cleared.
- Keep raw display facts distinct from inferred eligibility and status changes.
- Ownership is process-local. Do not restore it from history or adopt native idle.
- Observe only the signed-in account and local display/camera state. No media
  acquisition, telemetry, network control listener, or other-user tracking.
- Preserve existing plugins, profiles, launch routes, settings, and unexplained
  dirty work. Installation requires a verified candidate and reversible backup.
- Keep personal histories, Discord identifiers, credentials, host paths,
  private instructions, and customized bundles out of Git and public fixtures.
- Do not force real status changes, camera use, locking, blanking, or activity
  for a test. Distinguish simulation, integration, and physical verification.

## Validation and delivery

`pnpm check` is the canonical gate: lint, types, deterministic tests, privacy
scan, helper build, and pinned upstream plugin integration. `pnpm test` is the
focused engine/detector/adapter gate. `pnpm exec tsx scripts/check-client.ts`
with an explicit local public-client script checks patch compatibility without
executing client code. Physical camera/display cycles require human smoke tests.

Bootstrap `main`, then use a feature branch. Preserve dirty work; no reset,
stash, rebase, amend, or force-push. Use normal commits and a ready PR after
passing applicable checks. Inspect the complete staged diff and `git diff --check`.
Never claim an unavailable check passed.

Let configured automatic Codex review start on PR creation; do not duplicate a
running cycle. Otherwise request one `@codex review`. Inspect body/comment
reactions, reviews, inline threads and checks against the exact head. Eyes and
silence are not clearance. Fix valid scoped findings, validate, push, reply with
SHA/evidence and resolve addressed threads. Each substantive head needs fresh
completed review; poll at 30–60 second intervals for at most 15 minutes per
cycle, then report an exact-head external blocker. Leave the PR unmerged unless
separately authorized. Public repository creation is authorized for this task.

## Installation and maintenance

Use an explicit installation descriptor stored outside this repository. Never
embed workstation paths in tracked files. Honor the existing updater's lock,
source validation, retained-release activation and rollback. A call/capture or
an uncertain restart preflight blocks restart, not independent build work.
Compile installed helper code from the recorded Git tree. Serialize staging with
the integration check; prepare durable file images before activation or rollback.
Bind target images to file states captured before planning; restore staging trees
by atomic rename before recursively removing discarded generations.
Recover interrupted operations only after validating recorded before/after state.
History survives uninstall by default. Stop helper collection when its lease
ends and terminate it with its owning application process.

Document behavior and compatibility changes alongside code. Keep this file
concise and idempotent; do not copy private workstation guidance here. The
owner-only system ledger records installation identity, backups, verification,
rollback and any pending review head. Do not update generated agent memories.

## Review priorities

1. Status-write provenance must survive async races without swallowing manual actions.
2. Positive camera/display evidence must be distinct from missing or stale data.
3. Installation must preserve existing plugins and reject unexplained drift.
