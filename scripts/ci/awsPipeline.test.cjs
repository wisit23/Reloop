const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

test("AWS graph stays verify -> images -> bundle -> deploy with CI inside verify", () => {
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
  assert.match(verify, /actions: read/);
  assert.match(verify, /Require successful CI for this main commit\r?\n {8}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(verify, /require\('\.\/scripts\/ci\/wait-for-ci\.cjs'\)/);
  assert.doesNotMatch(release, /uses: \.\/\.github\/workflows\/ci\.yml/);
  const deployJob = release.match(/^ {2}deploy:\r?\n([\s\S]*)/m)?.[1];
  assert.match(deployJob, /needs: bundle/);
  assert.match(release, /images:\r?\n {4}needs: verify/);
  assert.match(release, /bundle:\r?\n {4}needs: images/);
  assert.doesNotMatch(deployJob, /always\(\)|continue-on-error:/);
  const stages = ci.match(/needs: \[([^\]]+)\]/)?.[1].split(/,\s*/).sort();
  assert.deepEqual(stages, ["core-tests", "docker-build", "frontend", "quality-gate", "service-tests"]);
  assert.match(ci, /jq -e 'all\(\.\[\]; \.result == "success"\)'/);
});

const waitForCi = require("./wait-for-ci.cjs");
const ciRun = (overrides = {}) => ({
  id: 1,
  head_sha: "commit-main",
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yml",
  head_repository: { full_name: "wisit23/Reloop" },
  status: "completed",
  conclusion: "success",
  ...overrides,
});

async function checkCi(responses, attempts = responses.length) {
  let calls = 0;
  let sleeps = 0;
  await waitForCi({
    github: { rest: { actions: { listWorkflowRuns: async (params) => {
      assert.equal(params.workflow_id, "ci.yml");
      assert.equal(params.head_sha, "commit-main");
      assert.equal(params.branch, "main");
      assert.equal(params.event, "push");
      return { data: { workflow_runs: responses[calls++] || [] } };
    } } } },
    context: { repo: { owner: "wisit23", repo: "Reloop" }, sha: "commit-main", ref: "refs/heads/main" },
    core: { info() {} },
    attempts,
    sleep: async () => { sleeps++; },
  });
  return { calls, sleeps };
}

test("CI gate waits for discovery and completion without running CI again", async () => {
  assert.deepEqual(await checkCi([[], [ciRun({ status: "in_progress", conclusion: null })], [ciRun()]]),
    { calls: 3, sleeps: 2 });
  assert.deepEqual(await checkCi([[ciRun({ path: ".github/workflows/ci.yml@main" })]]),
    { calls: 1, sleeps: 0 });
});

test("CI gate blocks failed, cancelled, skipped and timed-out CI", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
    await assert.rejects(checkCi([[ciRun({ conclusion })]]), /deployment blocked/);
  }
  await assert.rejects(checkCi([[], []]), /wait limit/);
});

test("CI gate rejects results from another commit, branch, event, workflow or repo", async () => {
  for (const overrides of [
    { head_sha: "old" }, { head_branch: "staging" }, { event: "pull_request" },
    { path: ".github/workflows/other.yml" }, { head_repository: { full_name: "fork/Reloop" } },
  ]) await assert.rejects(checkCi([[ciRun(overrides)]]), /wait limit/);
});

test("CI gate never falls back to an older successful run", async () => {
  await assert.rejects(checkCi([[ciRun(), ciRun({ id: 2, conclusion: "failure" })]]), /deployment blocked/);
  assert.deepEqual(await checkCi([[ciRun(), ciRun({ id: 2, status: "in_progress", conclusion: null })], [ciRun({ id: 2 })]]),
    { calls: 2, sleeps: 1 });
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
