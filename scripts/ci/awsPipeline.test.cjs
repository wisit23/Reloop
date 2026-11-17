const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const openStagingPr = require("./staging-pr.cjs");

async function promotionCase({ existing = [], ahead = 1, failCreate = false } = {}) {
  const calls = [];
  const summary = {
    addRaw() { return this; },
    addHeading() { return this; },
    addLink(label, url) { calls.push(["link", url]); return this; },
    async write() {},
  };
  await openStagingPr({
    context: { repo: { owner: "wisit23", repo: "Reloop" }, runId: 123, sha: "tested-commit" },
    core: { summary, info() {} },
    github: { rest: {
      pulls: {
        async list(params) {
          assert.deepEqual(params, { owner: "wisit23", repo: "Reloop", state: "open", base: "main", head: "wisit23:staging" });
          return { data: existing };
        },
        async create(params) {
          assert.equal(params.base, "main");
          assert.equal(params.head, "staging");
          assert.match(params.body, /actions\/runs\/123/);
          assert.match(params.body, /tested-commit/);
          if (failCreate) throw new Error("Pull request creation disabled");
          calls.push(["create"]);
          return { data: { number: 5, html_url: "https://github.com/wisit23/Reloop/pull/5" } };
        },
      },
      repos: { async compareCommits() { calls.push(["compare"]); return { data: { ahead_by: ahead } }; } },
    } },
  });
  return calls;
}

test("successful staging build creates a promotion PR and writes its link", async () => {
  assert.deepEqual(await promotionCase(), [["compare"], ["create"], ["link", "https://github.com/wisit23/Reloop/pull/5"]]);
});

test("staging builds reuse an open promotion PR instead of duplicating it", async () => {
  assert.deepEqual(await promotionCase({ existing: [{ number: 4, html_url: "existing-pr" }] }), [["link", "existing-pr"]]);
});

test("staging builds with no new commits do not open a PR", async () => {
  assert.deepEqual(await promotionCase({ ahead: 0 }), [["compare"]]);
});

test("promotion PR permission errors are reported as a failed step", async () => {
  await assert.rejects(promotionCase({ failCreate: true }), /creation disabled/);
});

// Execute the actual github-script provenance gate against the Actions API
// boundary. An in-progress push run is trusted only by its own dependent job.
const workflow = fs.readFileSync(
  path.resolve(__dirname, "../../.github/workflows/aws-eks-staging.yml"),
  "utf8",
);
const source = workflow
  .match(/ {10}script: \|\r?\n([\s\S]*?)(?=\r?\n {6}-)/)[1]
  .split(/\r?\n/)
  .map((line) => line.replace(/^ {12}/, ""))
  .join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const validate = new AsyncFunction(
  "github",
  "context",
  "core",
  "process",
  source,
);

test("AWS workflows use Reloop branch names and keep automatic deployment main-only", () => {
  const readWorkflow = (name) => fs.readFileSync(
    path.resolve(__dirname, `../../.github/workflows/${name}.yml`), "utf8",
  );
  const release = readWorkflow("aws-release");
  const promote = readWorkflow("aws-promote");
  for (const text of [release, workflow, promote]) {
    assert.doesNotMatch(text, /fullcloud(?:main|staging)/);
  }
  assert.match(release, /branches: \[staging, main\]/);
  assert.match(release, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && vars\.AWS_AUTO_DEPLOY != 'false'/);
  assert.match(workflow, /environment: \$\{\{ github\.ref == 'refs\/heads\/main' && 'aws-production' \|\| 'aws-staging' \}\}/);
  assert.match(workflow, /os\.environ\['GITHUB_REF_NAME'\] != 'main'/);
  assert.match(promote, /run\.head_branch !== 'staging'/);
});

test("AWS graph matches Ise without a repeated CI gate", () => {
  const release = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/aws-release.yml"), "utf8",
  );
  const ci = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/ci.yml"), "utf8",
  );
  const jobs = release.split(/\r?\njobs:\r?\n/)[1];
  assert.deepEqual([...jobs.matchAll(/^ {2}([\w-]+):/gm)].map((match) => match[1]),
    ["verify", "images", "bundle", "deploy"]);
  const verify = jobs.split(/\r?\n {2}images:/)[0];
  assert.doesNotMatch(verify, /wait-for-ci|Require successful CI|uses: actions\/github-script/);
  assert.doesNotMatch(release, /uses: \.\/\.github\/workflows\/ci\.yml/);
  const deployJob = release.match(/^ {2}deploy:\r?\n([\s\S]*)/m)?.[1];
  assert.match(deployJob, /needs: bundle/);
  assert.match(release, /images:\r?\n {4}needs: verify/);
  assert.match(release, /bundle:\r?\n {4}needs: images/);
  const bundle = jobs.split(/\r?\n {2}bundle:/)[1].split(/\r?\n {2}deploy:/)[0];
  assert.match(bundle, /pull-requests: write/);
  assert.match(bundle, /Open staging pull request to main\r?\n {8}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/staging'/);
  assert.match(bundle, /require\('\.\/scripts\/ci\/staging-pr\.cjs'\)/);
  assert.doesNotMatch(deployJob, /always\(\)|continue-on-error:/);
  const stages = ci.match(/needs: \[([^\]]+)\]/)?.[1].split(/,\s*/).sort();
  assert.deepEqual(stages, ["core-tests", "docker-build", "frontend", "quality-gate", "service-tests"]);
  assert.match(ci, /jq -e 'all\(\.\[\]; \.result == "success"\)'/);
});

test("Docker smoke check requires the Node major used by the project and images", () => {
  const root = path.resolve(__dirname, "../..");
  const major = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "deploy/cicd/Dockerfile"), "utf8");
  const requiredMajor = ci.match(/process\.versions\.node\.split\("\."\)\[0\] !== "(\d+)"/)?.[1];
  assert.equal(requiredMajor, major);
  const images = [...dockerfile.matchAll(/^FROM node:(\d+)-alpine/gm)];
  assert.ok(images.length > 0);
  for (const image of images) assert.equal(image[1], major);
});

function runRecord(overrides = {}) {
  return {
    path: ".github/workflows/aws-release.yml",
    head_branch: "staging",
    event: "push",
    status: "in_progress",
    conclusion: null,
    id: 123,
    head_sha: "abc123",
    run_attempt: 1,
    head_repository: { full_name: "wisit23/Ise" },
    ...overrides,
  };
}

async function check(run, auto = true, branch = "staging") {
  const exported = {};
  await validate(
    { rest: { actions: { getWorkflowRun: async () => ({ data: run }) } } },
    {
      repo: { owner: "wisit23", repo: "Ise" },
      runId: 123,
      sha: "abc123",
      ref: `refs/heads/${branch}`,
    },
    {
      exportVariable: (name, value) => {
        exported[name] = value;
      },
    },
    {
      env: {
        AUTO: String(auto),
        SOURCE_RUN: "123",
        AWS_ACCOUNT_ID: "997229934811",
        DEPLOY: "true",
        COMPATIBLE: "true",
        GITHUB_RUN_ATTEMPT: "1",
      },
    },
  );
  return exported;
}

test("dependent push deploy accepts its running build and pins artifact release identity", async () => {
  assert.deepEqual(await check(runRecord()), {
    RELEASE_COMMIT: "abc123",
    RELEASE_VERSION: "abc123-123-1",
  });
});

test("automatic deploy rejects another run, attempt, commit, branch, event or repository", async () => {
  for (const overrides of [
    { id: 456 },
    { run_attempt: 2 },
    { head_sha: "other" },
    { head_branch: "main" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { status: "completed", conclusion: "failure" },
    { head_repository: { full_name: "fork/Ise" } },
    { path: ".github/workflows/other.yml" },
  ])
    await assert.rejects(check(runRecord(overrides)), /trusted staging build/);
});

test("a deployment accepts only a build from the branch that runs it", async () => {
  assert.deepEqual(
    await check(
      runRecord({ head_branch: "main" }),
      true,
      "main",
    ),
    { RELEASE_COMMIT: "abc123", RELEASE_VERSION: "abc123-123-1" },
  );
  await assert.rejects(
    check(
      runRecord({ head_branch: "staging" }),
      true,
      "main",
    ),
    /trusted staging build/,
  );
  await assert.rejects(
    check(
      runRecord({ head_branch: "main" }),
      true,
      "staging",
    ),
    /trusted staging build/,
  );
  const done = { status: "completed", conclusion: "success" };
  await assert.rejects(
    check(
      runRecord({ ...done, head_branch: "staging" }),
      false,
      "main",
    ),
    /trusted staging build/,
  );
});

test("manual deployment accepts completed successful trusted push or manual builds", async () => {
  for (const event of ["push", "workflow_dispatch"]) {
    await check(
      runRecord({ event, status: "completed", conclusion: "success" }),
      false,
    );
    await assert.rejects(
      check(runRecord({ event }), false),
      /trusted staging build/,
    );
    await assert.rejects(
      check(
        runRecord({ event, status: "completed", conclusion: "failure" }),
        false,
      ),
      /trusted staging build/,
    );
  }
});
