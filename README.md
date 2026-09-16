# shuvbot

`shuvbot` is a GitHub-native code review and coding-agent action. In this version it runs only for trusted `@shuvbot` mentions in pull-request comments, runs guarded no-op implement/fix-ci paths, and keeps all runtime authority in deterministic policy code rather than prompts or GitHub payloads.

**Status: review mode is live in this version.** It runs the real Claude Code
driver against the MCP tool server and posts real findings. `implement` and
`fix-ci` modes exist end-to-end (policy, branch prep, commit/PR tooling) but
are not yet wired to a real agent - they currently no-op and say so in their
run summary. See `docs/workflows.md` for details.

## Quickstart: use shuvbot in your repository

Three files and one secret. The repository needs no `package.json`, lockfile, or
dependency on shuvbot.

1. Copy `templates/consumer/.github/workflows/shuvbot.yml` to
   `.github/workflows/shuvbot.yml` and change the
   `github.event.comment.user.login == 'shuv1337'` gate to your login.
2. Copy `templates/consumer/.github/shuvbot.ci.toml` to `.github/shuvbot.ci.toml`.
3. Add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret (`docs/claude-token.md`).

Then comment `@shuvbot review` on a pull request. The comment gets eyes while
the review runs, then rocket or confused; findings are posted as inline review
comments with a verdict and cost summary in the review body.

The essential step is:

```yaml
- uses: shuv1337/shuvbot-github@master
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    engine: coordinator
    config: .github/shuvbot.ci.toml
  env:
    CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

> `@master` tracks the latest reviewed code. For reproducible runs pin an exact
> commit SHA (`shuv1337/shuvbot-github@<commit-sha>`) and move it deliberately.
> The published `v0`/`v0.1.0` tags predate the coordinator engine and do not
> work with this workflow; see `CHANGELOG.md`.

`docs/workflows.md`, "Using shuvbot in another repository", explains each line
of the template and why it is there.

Start with:

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build
bun run evals
```

## Configuration

Create `shuvbot.toml` only when defaults need changing:

```toml
agent = "claude-code"
model = "claude/sonnet"
mode = "review"
report_on = "medium"
min_confidence = "medium"
shell = "restricted"
push = "restricted"

[memory]
enabled = false
learnings = false
```

`model` can be a shuvbot alias such as `claude/sonnet` or a direct provider model ID; Claude aliases are resolved before invoking the Claude CLI.

`docs/quick-reference.md` covers day-to-day review usage, locally and on GitHub. See also
`docs/config.md`, `docs/security.md`, `docs/workflows.md`, and `docs/claude-token.md`.
