# Workflows

**Only `review` mode calls a real agent in this version.** `implement` and
`fix-ci` run their full policy/branch/tooling path but end in a no-op agent
step that says so in the run summary - see the notes on each workflow below.

## Manual Comment Review (single-agent path)

This section describes the single-agent Claude Code path, which is what the
published `v0`/`v0.1.0` tags run. New workflows should use the coordinator
engine instead; see "Using shuvbot in another repository" below. The trigger
shape and guards here apply to both.

Review mode needs the Claude Code CLI on `PATH` and Claude credentials in
addition to the GitHub token: install Claude Code before the shuvbot step, then
expose `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) to the step via
`env:`, or the run will fail with a Claude auth error. When the real agent
fails before normal review artifacts are written, shuvbot logs a redacted
diagnostic tail and persists it as `$RUNNER_TEMP/shuvbot/shuvbot-agent-error.txt`.

Review runs only from an `@shuvbot <command>` mention in a pull-request comment. PR bodies,
issue bodies, plain-issue comments, pushes, schedules, workflow dispatch, and workflow-run events
never start shuvbot.

```yaml
name: shuvbot
on:
  issue_comment: # conversation tab; the job gate below keeps it to pull requests
    types: [created, edited]
  pull_request_review_comment: # inline diff comments
    types: [created, edited]

permissions: {}

jobs:
  review:
    if: >-
      contains(github.event.comment.body, '@shuvbot') &&
      ((github.event_name == 'issue_comment' &&
          github.event.issue.pull_request != null) ||
        github.event_name == 'pull_request_review_comment')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      checks: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Install Claude Code
        run: |
          curl -fsSL https://claude.ai/install.sh | bash
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
      - name: Verify Claude Code
        run: claude --version
      - uses: shuv1337/shuvbot@v0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      - name: Upload shuvbot artifacts
        if: always()
        uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3
        with:
          name: shuvbot
          path: ${{ runner.temp }}/shuvbot
          if-no-files-found: warn
```

Obtain `CLAUDE_CODE_OAUTH_TOKEN` locally with `shuvbot auth claude setup-token --repo <owner>/<repo>` (see `docs/claude-token.md`), or use `ANTHROPIC_API_KEY` instead. Public repositories should keep `pull_request` (not `pull_request_target`) and add `if: github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft` on the job when credentials are unavailable to fork PRs and draft PRs should wait for review; fork PRs will be skipped instead of failing the Claude auth check, and draft PRs will run when marked ready for review because `ready_for_review` is included in the trigger types.

## Multi-Agent Coordinator Review (opt-in)

The coordinator engine runs six specialist reviewers and a coordinator that judges
and consolidates their findings, instead of the single-agent path above. It is the
default for local `shuvbot review`, but in the Action it is **opt-in**: adopting it
silently would break every existing workflow, because it needs two things the
single-agent path does not.

1. **The pinned shuvcode runtime installed in the job.** The action bundle is
   self-contained and never runs a package manager, so the workflow installs the
   runtime. The version must match `review.shuvcode.version`; a mismatch fails
   before any review work starts rather than running an untested runtime.
2. **Non-interactive authentication.** A runner has no shuvcode profile, so set
   `review.shuvcode.auth = "environment"` and expose `CLAUDE_CODE_OAUTH_TOKEN`
   (or `ANTHROPIC_API_KEY`) to the step. That one credential is the only variable
   shuvbot passes into the runtime; nothing else in the job environment reaches it.

The Claude Code CLI is _not_ needed for coordinator review - it replaces that driver.

### Using shuvbot in another repository

The repository being reviewed needs three files and one secret, and nothing else: no
`package.json`, no lockfile, no dependency on shuvbot.

1. Copy `templates/consumer/.github/workflows/shuvbot.yml` to `.github/workflows/shuvbot.yml`.
   Change the `github.event.comment.user.login == 'shuv1337'` gate to the login that should be
   allowed to invoke shuvbot.
2. Copy `templates/consumer/.github/shuvbot.ci.toml` to `.github/shuvbot.ci.toml`.
3. Add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret (`docs/claude-token.md` to mint one; the
   token is account-level, so one value works in every repository).

Then comment `@shuvbot review` on a pull request.

The template is manual-only and owner-gated, identical in shape to this repository's own
`.github/workflows/shuvbot.yml`, with three differences that matter:

- **`uses: shuv1337/shuvbot-github@master`**, not `uses: ./`. The published `v0` tag predates the
  coordinator engine, the read budget, and mention reactions, and will not work with this workflow.
  Pin an exact commit SHA of `shuv1337/shuvbot-github` for reproducible runs.
- **`bun add --no-save --ignore-scripts shuvcode@<version>`** installs the runtime into the reviewed
  checkout. `--no-save` leaves the repository's own `package.json` and lockfile untouched and does
  not need either to exist; the action's resolver walks `node_modules` up from the checkout. Without
  `--ignore-scripts`, the reviewed repository's own `postinstall` runs inside a job that holds the
  provider credential. The version must equal `review.shuvcode.version` in the config.
- **The checkout is the trusted default branch**, even though the action code and the diff both come
  from elsewhere: the install step runs inside that checkout, and a pull request must not be able to
  plant a `bunfig.toml` or `.npmrc` registry override that the runtime download would honour.

`config: .github/shuvbot.ci.toml` is required. The Action does not auto-discover a config file the
way the CLI does, and without one the coordinator falls back to local-profile auth and refuses to
start on a runner. The template config is Anthropic-only because environment auth forwards exactly
one credential; a roster spanning providers fails every specialist.

### What the coordinator run publishes

- **Inline review comments** for findings whose line is in the diff, each carrying a
  fingerprint marker so a re-review updates rather than duplicates them. A finding
  on a line outside the diff is reported in the review body instead of being dropped.
- **Finding lifecycle state**, in a hidden comment on the pull request. It exists so
  a later run does not repost findings you have already seen, and resolving a
  finding's thread marks it resolved so it stays gone. Deleting that comment makes
  the next review start fresh. State is only written when shuvbot is allowed to post.
- **Outputs** `review_engine`, `review_tier`, `review_coverage`, and `review_degraded`,
  plus a Review section in the workflow summary naming any reviewer that did not
  complete. Degraded coverage never claims a clean result and never requests changes.

Fork pull requests are reviewed but never posted to, and never receive state.
`APPROVE` is never submitted, in any configuration.

## Comment-Triggered Review

Commenting `@shuvbot review` on a pull request reviews it on demand. Comments on ordinary issues
are gated out in the workflow (see below): no mode can act on an issue yet, so accepting the
mention would only start a job that fails closed.

A mention gets a lifecycle reaction on that comment: **eyes** when the run starts, **rocket** if
it finishes, **confused** if it fails. The signal is mechanical and never fails the job. It is
not posted on the pull request itself, because a rocket there can read as endorsing the change.
A comment that never mentioned the bot is left alone.

**Subscribe to both comment events.** "Commenting on a pull request" is two distinct GitHub events,
and they look like a single act from the UI:

```yaml
on:
  issue_comment: # the conversation tab
    types: [created, edited]
  pull_request_review_comment: # an inline comment on a diff line
    types: [created, edited]
```

The action handles both. Subscribing to only `issue_comment` - the easy mistake - leaves
`@shuvbot review` typed on a diff line silently dead: no run, no error, no reply. Note that
`github.event.issue.number` is undefined for `pull_request_review_comment`, so guards, concurrency
groups, and any PR-number lookup need `github.event.issue.number || github.event.pull_request.number`.

`issue_comment` also fires for **plain issues**. The workflow gates those out with
`github.event.issue.pull_request != null`, which GitHub sets only when the issue is a pull request.
No mode handles an issue yet: review needs a diff, and `ask`/`explain`/`summarize` resolve to a
`triage` mode with no handler, so an issue mention would only start a job that fails closed and
leaves a red X on the thread. The action still fails loudly if it ever receives one; lift the
workflow gate once an issue handler exists.

To restrict who can invoke shuvbot, match the login directly - `github.event.comment.user.login ==
'<you>'`. GitHub sets that field, so it cannot be spoofed. Be aware this is then the _only_ identity
gate: the action re-checks write access but has no actor allowlist, so it will not catch a mistake
in that expression.

The action resolves which pull request a comment refers to, then presents it to the review pipeline
as a `pull_request` event. That indirection is not cosmetic: review skills trigger on
`pull_request` actions, so a comment event would otherwise select no skills and review nothing.

Guards, and why each exists:

| Guard                                          | Reason                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Comment must mention the bot                   | Otherwise every comment on a pull request starts a review.                                                                |
| Author must have write access                  | Checked in the workflow to avoid spending a run. The action re-derives permission itself and does not trust the workflow. |
| Fork heads are reviewed, never posted to       | `canReview` refuses to publish on a fork. The run reports the refusal instead of looking like a clean review.             |
| Merge ref checked out only for same-repo heads | Fork code must never enter a job holding `CLAUDE_CODE_OAUTH_TOKEN`. Fork pull requests keep the default checkout.         |

An `issue_comment` payload contains an `issue`, not a pull request, and nothing identifying the head
repository, so fork status is unknowable from the event alone. `detectFork` therefore reports the
restrictive answer for pull request comments, and the real answer comes from fetching the pull
request before policy is built. Do not "simplify" that back to reading the payload.

Serialize runs per pull request with a `concurrency` group. Prefer leaving `cancel-in-progress`
off, so a review someone explicitly asked for finishes rather than being cancelled by a later push.

## Mention-Driven Implement

Not yet wired to a real agent in this version. Trusted collaborators can comment:

```text
@shuvbot implement fix the failing parser test
```

The bot creates/fast-forwards a `shuvbot/*` branch and validates implement-mode
policy, but the agent step itself is a no-op: it writes no patch, runs no
commands, and opens no PR. Fork and untrusted contexts keep shell/push
disabled regardless.

## CI Repair

Not yet wired to a real agent in this version. The bot reads failed check logs
and validates fix-ci policy, but the agent step is a no-op: it attempts no
fix and pushes no commit. The workflow below still runs end-to-end and posts
a summary explaining that no fix was attempted.

```yaml
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
permissions:
  contents: write
  pull-requests: write
  issues: write
  checks: read
steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  - name: Install Claude Code
    run: |
      curl -fsSL https://claude.ai/install.sh | bash
      echo "$HOME/.local/bin" >> "$GITHUB_PATH"
  - name: Verify Claude Code
    run: claude --version
  - uses: shuv1337/shuvbot-github@master
    with:
      mode: fix-ci
      token: ${{ secrets.GITHUB_TOKEN }}
```

## Standalone Step / Structured Output

Not yet wired to a real agent in this version. `output_schema` was removed
from `action.yml` - it was read into memory but nothing ever validated
output against it (SPEC §23.1's parse/validate/retry loop was never built).
A step with no matching event/mode still runs successfully and sets
`result` to a small status object (`runId`, `status: "initialized"`,
`mode`, `trigger`), but no agent is invoked and no schema-validated output
is produced. Only `review` mode currently produces real `result`,
`review_findings`, and `summary` outputs.

## Hardened SHA-Pinned Variant

Replace `shuv1337/shuvbot-github@master` with an exact commit SHA for reproducible production
workflows, and move it deliberately:

```yaml
- uses: shuv1337/shuvbot-github@<commit-sha>
```

The published `v0` and `v0.1.0` tags point at the single-agent path and predate the coordinator
engine; they do not work with the coordinator workflow. A release tag that includes the coordinator
will be cut once the Action's reliability is measured (see `HANDOFF.md`).

Third-party actions in examples are SHA-pinned. Keep job permissions explicit and minimal.
