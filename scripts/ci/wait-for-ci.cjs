// Keep CI in its own workflow while gating deployment on the exact main commit.
module.exports = async function waitForCi({
  github,
  context,
  core,
  attempts = 120,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const branch = context.ref.replace(/^refs\/heads\//, "");
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: "ci.yml",
      head_sha: context.sha,
      branch,
      event: "push",
      per_page: 100,
    });
    const run = data.workflow_runs
      .filter((candidate) =>
        candidate.head_sha === context.sha &&
        candidate.head_branch === branch &&
        candidate.event === "push" &&
        candidate.path?.split("@")[0] === ".github/workflows/ci.yml" &&
        candidate.head_repository?.full_name === repository,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (run?.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`CI ${run.id} finished with ${run.conclusion}; deployment blocked`);
      }
      core.info(`CI ${run.id} passed for ${context.sha}`);
      return;
    }
    core.info(`Waiting for push CI on ${branch} at ${context.sha}`);
    if (attempt + 1 < attempts) await sleep(15_000);
  }
  throw new Error(`CI did not succeed within the wait limit for ${context.sha}; deployment blocked`);
};
