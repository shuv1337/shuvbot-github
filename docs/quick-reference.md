# Quick reference

Day-to-day usage. `docs/config.md` has the full settings reference, `docs/commands.md` the full
command list, and `docs/troubleshooting.md` the diagnostics.

The two paths are different engines, on purpose:

|         | Local CLI                                       | GitHub Action                            |
| ------- | ----------------------------------------------- | ---------------------------------------- |
| Engine  | Coordinator: six specialists plus a coordinator | Single Claude Code agent                 |
| Models  | Curated catalog, per role                       | One model for the run                    |
| Runs on | Your machine, your shuvcode subscription        | GitHub runner, `CLAUDE_CODE_OAUTH_TOKEN` |
| Output  | Terminal, JSON, run artifacts                   | PR review comments, check, step summary  |

Changing local models does not change what the Action does.

## Local reviews

Build the executable once, then put it on `PATH`:

```bash
bun run build:cli                                   # -> bin/shuvbot
ln -sf "$PWD/bin/shuvbot" ~/.local/bin/shuvbot
```

```bash
shuvbot review                          # current work, in any repository
shuvbot review --base main --head HEAD
```

Without building, run from source with `bun packages/cli/src/index.ts review`.

Keep the binary in this checkout, or symlink it as above: it finds `shuvcode` next to its real
location, so a symlink on `PATH` works but a copy moved elsewhere does not. The runtime is looked up
in the reviewed repository first and beside shuvbot second, so the reviewed project does not need
to depend on `shuvcode`.

| Flag                           | Meaning                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `--base <rev>`                 | Range start. Defaults per VCS, see below.                                   |
| `--head <rev>`                 | Range end. Defaults per VCS, see below.                                     |
| `--config <path>`              | Load a specific TOML instead of `./shuvbot.toml`. Missing file is an error. |
| `--engine coordinator\|legacy` | Override the configured engine. `legacy` fails closed.                      |
| `--json`                       | Stable machine-readable report instead of progress output.                  |

The range is three-dot, so it reviews what your side adds rather than what the other side moved on
to. Flags are strict: unknown, duplicate, or valueless options fail rather than being ignored.

### Jujutsu and Git

Shuvbot detects the VCS and picks defaults to match. A colocated repository counts as Jujutsu,
because Git's `HEAD` there is the _parent_ of the working-copy commit, so reading it through Git
would skip the change being worked on.

| VCS     | Default base                                        | Default head |
| ------- | --------------------------------------------------- | ------------ |
| Jujutsu | `fork_point(trunk() \| @)`, or `@-` without a trunk | `@`          |
| Git     | `main`                                              | `HEAD`       |

**Under Jujutsu there is no uncommitted work.** The working copy is the commit `@`, so a bare
`shuvbot review` reviews what you are working on right now, edits included. The working copy is
recorded before the review reads it, so what is on disk is what gets reviewed. Both flags accept any
revset:

```bash
shuvbot review                              # trunk through current work
shuvbot review --base '@-' --head '@'       # just this change
shuvbot review --base 'trunk()' --head '@'  # the whole stack
shuvbot review --base 'xyzabcd' --head '@'  # from a change id
```

Because `@` keeps its change id across amends, rerunning after an edit reuses the same incremental
state, so findings you fixed are recognised as fixed instead of reported again.

**Under Git, reviews read committed history only.** Uncommitted work is invisible, so commit first or
the feedback describes the previous state.

```bash
--base HEAD~1 --head HEAD   # last commit
--base main   --head HEAD   # whole branch
```

Jujutsu revisions are resolved by `jj` into ordinary Git commits, so everything after resolution is
identical for both. `jj` must be on `PATH` in a Jujutsu workspace; if it is missing, shuvbot says
so and suggests an explicit Git range.

When merging a pull request from a colocated JJ checkout, omit Git's local branch cleanup flag:
`gh pr merge --delete-branch` asks Git to delete a branch even though JJ intentionally leaves Git's
`HEAD` detached. Use `gh pr merge` without `--delete-branch`, then confirm the resulting workspace
with `jj status` and `jj log`.

### Reading the result

Size picks the tier, which picks the roster: `trivial` runs one reviewer, `lite` five, `full` all
six. Quorum decides whether the run is trustworthy, so a review can be honest about being
incomplete rather than reporting a clean result it did not earn.

```
[completed] release | elapsed 1m 16s | coverage 6/6 | required 2/2
Decision: MINOR ISSUES
Coverage: 6/6 reviewers | quorum met
- [medium/new] Duplicate-draft check compares a literal string (PLAN.md:53, documentation)
```

- `CLEAN`, `MINOR ISSUES`, `SIGNIFICANT CONCERNS` - the coordinator's verdict.
- `DEGRADED - REVIEW INCOMPLETE` - too many specialists failed to trust the result.
- `coverage a/b` - specialists that returned a valid result; `required` counts the ones this tier
  needs.

Findings are `[severity/state] summary (file:line, reviewer)`.

### Configuration

A `shuvbot.toml` in the repository being reviewed. Everything is optional.

```toml
[review]
engine = "coordinator"   # default
max_concurrency = 3      # specialists in flight
overall_timeout = "15m"
incremental = true       # remember findings between runs

[review.models]
coordinator = "subscription/claude-opus-5@medium"
standard    = "subscription/grok-4.5@high"
light       = "subscription/gpt-5.6-luna@max"

[review.tiers.full]
reviewers = ["code-quality", "security", "performance", "tests", "documentation", "release"]

[[review.reviewers]]
id = "security"
paths = ["src/api/**"]
prompt_append = "Treat every request body as untrusted."

[paths]
ignore = ["dist/**", "**/*.snap"]
```

Model names are `subscription/<model>` or `subscription/<model>@<effort>`, resolved through the
curated catalog in `packages/review/src/runtime/model-catalog.ts`. That file is where you add a
model, change a role default, or record which efforts a model accepts. A per-reviewer `model` must
be one the configuration already selects for a role.

### Artifacts

Each run writes `.shuvbot/runs/<id>/`:

| File                            | Contents                                            |
| ------------------------------- | --------------------------------------------------- |
| `shuvbot-run.json`              | Run record: timings, engine, config summary         |
| `shuvbot-review-result.json`    | Decision, coverage, quorum, retries                 |
| `shuvbot-review-sessions.json`  | Per-session model, status, usage, limits, errors    |
| `shuvbot-events.jsonl`          | Redacted session timeline                           |
| `shuvbot-findings.json`         | Findings as structured data                         |
| `shuvbot-rejected-results.json` | Only when a result was refused: the offending value |

`.shuvbot/` is gitignored here; add it to `.gitignore` in other repositories.

### When something breaks

```bash
bun packages/cli/src/index.ts doctor    # prerequisites, auth, runtime, model catalog
bun run smoke:runtime                    # drive the pinned runtime end to end
```

| Symptom                                         | Cause                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `REVIEW_CONFIG_INVALID` naming a model          | Model or effort is not curated. The message lists the accepted ones.         |
| `REVIEW_SCHEMA_INVALID`                         | A result failed validation. The value is in `shuvbot-rejected-results.json`. |
| `Cannot resolve the installed shuvcode package` | Run `bun install` here; a binary copied elsewhere cannot find it.            |
| `jj` executable not found                       | Install jj, or pass an explicit `--base`/`--head` Git range.                 |
| Runtime pin mismatch                            | `review.shuvcode.version` must equal the code-approved pin.                  |
| `no_changes` / `no_reviewable_changes`          | The range is empty or entirely ignored by `[paths]`.                         |
| Review describes code you already fixed         | Git only: uncommitted work. Commit and rerun, or use Jujutsu.                |

## GitHub reviews

`.github/workflows/shuvbot.yml` runs the coordinator review when `@shuvbot review` is commented on
a pull request. It is **advisory**: it comments but never blocks a merge.

To use it in another repository, copy `templates/consumer/.github/workflows/shuvbot.yml` and
`templates/consumer/.github/shuvbot.ci.toml` into that repository's `.github/`, change the login
gate, and add the `CLAUDE_CODE_OAUTH_TOKEN` secret. The step that does the work is:

```yaml
- uses: shuv1337/shuvbot-github@master
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    engine: coordinator
    config: .github/shuvbot.ci.toml
  env:
    CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Requires the `CLAUDE_CODE_OAUTH_TOKEN` secret (`docs/claude-token.md` to mint one). Fork pull
requests are reviewed but never posted to. See `docs/workflows.md`, "Using shuvbot in another
repository", for what each line of the template does.

Useful inputs: `mode`, `model`, `config`, `timeout`, `activity_timeout`, `push`, `shell`, `prompt`.
Outputs: `result`, `review_findings`, `summary`. Failure diagnostics upload as the `shuvbot`
artifact.

To make it blocking, set these in `shuvbot.toml` - both default to `false`, so decide deliberately:

```toml
fail_check = true       # fail the check run
request_changes = true  # request changes on the PR
fail_on = "high"        # severity that counts
```

Only **review** mode runs a real agent. `implement`, `improve`, `fix-ci`, `ask`, and `describe` run
their policy and tooling path and stop at a documented no-op. See `docs/workflows.md`.

### Asking for a review by comment

Comment `@shuvbot review` on any pull request to review it on demand. Mentions on ordinary issues
are gated out in the workflow until an issue handler exists. The workflow needs both comment
triggers; see `.github/workflows/shuvbot.yml` in this repository for the shape. The triggering
comment gets eyes while the run is in flight, then rocket or confused when it ends.

Four things are worth knowing:

- A comment starts a review only when it **mentions the bot**. Ordinary comments are ignored, so
  discussion on a pull request does not spend a run.
- The comment author must already have **write access**. The workflow checks this to avoid
  spending a run, and the action re-derives permission itself rather than trusting it.
- **Fork pull requests are reviewed but not posted to.** `canReview` refuses to publish on a fork
  head. The run says so explicitly rather than looking like a review that found nothing.
- The workflow checks out the pull request's merge ref **only for a same-repository head**, so the
  agent reads the changed files rather than the base branch. A fork head keeps the default
  checkout, because checking out fork code in a job holding `CLAUDE_CODE_OAUTH_TOKEN` is the one
  thing this trigger must not do.

## Choosing a path

- Working locally, want depth and control over models: local CLI.
- Want a second opinion on someone's PR, in the PR: GitHub Action.
- The Action does not run the coordinator, and local reviews do not post to GitHub. Routing the
  Action through the coordinator is unfinished work.
