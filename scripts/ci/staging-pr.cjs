module.exports = async function openStagingPr({ github, context, core }) {
  const { owner, repo } = context.repo;
  const { data: existing } = await github.rest.pulls.list({
    owner, repo, state: "open", base: "main", head: `${owner}:staging`,
  });
  let pr = existing[0];
  if (!pr) {
    const { data: comparison } = await github.rest.repos.compareCommits({
      owner, repo, base: "main", head: "staging",
    });
    if (comparison.ahead_by === 0) {
      await core.summary.addRaw("Staging has no new commits to promote to main.").write();
      return;
    }
    const { data } = await github.rest.pulls.create({
      owner, repo, base: "main", head: "staging",
      title: "release: promote staging to main",
      body: `The staging AWS build completed successfully.\n\nBuild: https://github.com/${owner}/${repo}/actions/runs/${context.runId}\nCommit: ${context.sha}\n\nReview and merge this PR to trigger the main deployment using the repository's aws-production environment.`,
    });
    pr = data;
  }
  core.info(`Staging promotion PR: ${pr.html_url}`);
  await core.summary.addHeading("Staging ready for main")
    .addLink(`Open pull request #${pr.number}`, pr.html_url).write();
};
