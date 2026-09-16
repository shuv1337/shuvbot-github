import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { APPROVED_SHUVCODE_RUNTIME_VERSION, loadConfigFile } from "../../core/src/config.ts";
import { assertReviewModelsReachable } from "../../review/src/runtime/auth.ts";

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.github/workflows/shuvbot.yml"
);
const CI_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "../../../.github/shuvbot.ci.toml");
const TEMPLATE_WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../templates/consumer/.github/workflows/shuvbot.yml"
);
const TEMPLATE_CONFIG = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../templates/consumer/.github/shuvbot.ci.toml"
);

/** The job gate every shuvbot workflow must carry: mention, and a pull request. */
const MENTION_GATE = "contains(github.event.comment.body, '@shuvbot')";
const PULL_REQUEST_GATE = "github.event.issue.pull_request != null";

describe("repository review workflow security", () => {
  test("starts only from a mention on a pull request", async () => {
    // issue_comment fires for plain issues too, and no mode handles an issue
    // yet, so accepting one would only start a job that fails closed.
    const source = await readFile(WORKFLOW, "utf8");
    expect(source).toContain(MENTION_GATE);
    expect(source).toContain(PULL_REQUEST_GATE);
    expect(source).not.toContain("pull_request:\n");
  });

  test("executes only trusted default-branch code with the provider credential", async () => {
    const source = await readFile(WORKFLOW, "utf8");

    expect(source).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(source).toContain("uses: ./");
    expect(source).not.toContain("refs/pull/");
    expect(source).not.toContain("steps.target.outputs.ref");
  });

  test("every model in the CI config is reachable with the credential the job supplies", async () => {
    // The first real Action run degraded to 0/6 coverage because the default
    // roster spans three providers while environment auth forwards one
    // credential. This asserts the committed CI config cannot regress to that.
    const config = await loadConfigFile(CI_CONFIG);
    expect(config.review.shuvcode.auth).toBe("environment");

    const workflow = await readFile(WORKFLOW, "utf8");
    expect(workflow).toContain("CLAUDE_CODE_OAUTH_TOKEN");

    expect(() =>
      assertReviewModelsReachable({
        credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "test-token" },
        models: config.review.models
      })
    ).not.toThrow();
  });

  test("the CI config pins the approved runtime", async () => {
    const config = await loadConfigFile(CI_CONFIG);
    // Null would mean no approved release exists, which the pin must never be.
    expect(APPROVED_SHUVCODE_RUNTIME_VERSION).not.toBeNull();
    expect(config.review.shuvcode.version).toBe(APPROVED_SHUVCODE_RUNTIME_VERSION!);
  });
});

describe("consumer workflow template", () => {
  test("carries the same gates and posture as the repository workflow", async () => {
    const source = await readFile(TEMPLATE_WORKFLOW, "utf8");

    expect(source).toContain(MENTION_GATE);
    expect(source).toContain(PULL_REQUEST_GATE);
    expect(source).toContain("github.event.comment.user.login ==");
    expect(source).not.toContain("pull_request:\n");
    expect(source).toContain("permissions: {}");
    expect(source).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(source).not.toContain("refs/pull/");
    // A consumer runs the published action, never a local checkout of it.
    expect(source).toContain("uses: shuv1337/shuvbot-github@");
    expect(source).not.toContain("uses: ./");
    expect(source).toContain("engine: coordinator");
    expect(source).toContain("config: .github/shuvbot.ci.toml");
    expect(source).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("installs the approved runtime without running the reviewed repository's scripts", async () => {
    const source = await readFile(TEMPLATE_WORKFLOW, "utf8");
    const install = /bun add --no-save --ignore-scripts shuvcode@(\S+)/.exec(source);
    // Without --ignore-scripts the reviewed repository's own postinstall runs
    // in a job holding the provider credential.
    expect(install).not.toBeNull();
    expect(install![1]).toBe(APPROVED_SHUVCODE_RUNTIME_VERSION!);
  });

  test("the template config matches the installed runtime and the credential", async () => {
    const config = await loadConfigFile(TEMPLATE_CONFIG);
    expect(config.review.engine).toBe("coordinator");
    expect(config.review.shuvcode.auth).toBe("environment");
    expect(config.review.shuvcode.version).toBe(APPROVED_SHUVCODE_RUNTIME_VERSION!);
    expect(() =>
      assertReviewModelsReachable({
        credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "test-token" },
        models: config.review.models
      })
    ).not.toThrow();
  });
});
