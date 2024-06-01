const core = require("@actions/core");
const { Octokit } = require("@octokit/rest");
const { throttling } = require("@octokit/plugin-throttling");

async function run() {
  try {
    const token = core.getInput('token');
    const url = core.getInput('baseUrl');
    const repository = core.getInput('repository');
    const retain_days = Number(core.getInput('retain_days'));
    const keep_minimum_runs = Number(core.getInput('keep_minimum_runs'));
    const delete_workflow_pattern = core.getInput('delete_workflow_pattern');
    const delete_workflow_by_state_pattern = core.getInput('delete_workflow_by_state_pattern');
    const delete_run_by_conclusion_pattern = core.getInput('delete_run_by_conclusion_pattern');
    const dry_run = core.getInput('dry_run') === 'true';
    const check_branch_existence = core.getInput("check_branch_existence") === 'true';
    const check_pullrequest_exist = core.getInput("check_pullrequest_exist") === 'true';

    // Split repository input into owner and name
    const [repo_owner, repo_name] = repository.split('/');
    if (!repo_owner || !repo_name) {
      throw new Error(`Invalid repository '${repository}'. Expected format {owner}/{repo}.`);
    }

    // Initialize Octokit with throttling plugin
    const MyOctokit = Octokit.plugin(throttling);
    const octokit = new MyOctokit({
      auth: token,
      baseUrl: url,
      throttle: {
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
          octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
          if (retryCount < 1) {
            octokit.log.info(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
          octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
        },
      },
    });

    // Get all workflows
    const workflows = await octokit.paginate("GET /repos/:owner/:repo/actions/workflows", {
      owner: repo_owner,
      repo: repo_name,
    });
    const workflow_ids = workflows.map(w => w.id);

    // Get all workflow runs
    const all_runs = await octokit.paginate('GET /repos/:owner/:repo/actions/runs', {
      owner: repo_owner,
      repo: repo_name,
    });

    // Filter runs without associated workflows
    let del_runs = all_runs.filter(run => !workflow_ids.includes(run.workflow_id));
    console.log(`💬 found total of ${del_runs.length} workflow run(s) to delete without associated workflows`);

    // Delete runs without associated workflows
    for (const del of del_runs) {
      await deleteRun(octokit, repo_owner, repo_name, del.id, del.name, dry_run);
    }

    // Filter workflows based on patterns
    let filteredWorkflows = workflows;
    if (delete_workflow_pattern) {
      filteredWorkflows = filterWorkflowsByPattern(filteredWorkflows, delete_workflow_pattern);
    }
    if (delete_workflow_by_state_pattern && delete_workflow_by_state_pattern.toUpperCase() !== "ALL") {
      filteredWorkflows = filterWorkflowsByState(filteredWorkflows, delete_workflow_by_state_pattern);
    }

    // Get all branches
    const branches = await octokit.paginate("GET /repos/:owner/:repo/branches", {
      owner: repo_owner,
      repo: repo_name,
    });
    const branchNames = branches.map(branch => branch.name);

    // Process each workflow
    for (const workflow of filteredWorkflows) {
      const runs = await octokit.paginate("GET /repos/:owner/:repo/actions/workflows/:workflow_id/runs", {
        owner: repo_owner,
        repo: repo_name,
        workflow_id: workflow.id,
      });

      const { del_runs, skip_runs } = filterRuns(runs, {
        retain_days,
        keep_minimum_runs,
        delete_run_by_conclusion_pattern,
        check_branch_existence,
        check_pullrequest_exist,
        branchNames,
      });

      // Delete filtered runs
      for (const del of del_runs) {
        await deleteRun(octokit, repo_owner, repo_name, del.id, workflow.name, dry_run);
      }

      // Log skipped runs
      for (const skip of skip_runs) {
        console.log(`👻 Skipped '${workflow.name}' workflow run ${skip.id}: created at ${skip.created_at}`);
      }
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function deleteRun(octokit, owner, repo, run_id, run_name, dry_run) {
  if (dry_run) {
    console.log(`[dry-run] 🚀 Delete run ${run_id} of '${run_name}' workflow`);
  } else {
    await octokit.actions.deleteWorkflowRun({ owner, repo, run_id });
    console.log(`🚀 Delete run ${run_id} of '${run_name}' workflow`);
  }
}

function filterWorkflowsByPattern(workflows, pattern) {
  return workflows.filter(({ name, path }) => {
    const filename = path.replace(".github/workflows/", "");
    return [name, filename].some(x => x.includes(pattern));
  });
}

function filterWorkflowsByState(workflows, statePattern) {
  const states = statePattern.split(",").map(s => s.trim());
  return workflows.filter(({ state }) => states.includes(state));
}

function filterRuns(runs, options) {
  const { retain_days, keep_minimum_runs, delete_run_by_conclusion_pattern, check_branch_existence, check_pullrequest_exist, branchNames } = options;
  let del_runs = [];
  let skip_runs = [];

  runs.forEach(run => {
    const shouldSkip = run.status !== "completed"
      || (check_pullrequest_exist && run.pull_requests.length > 0)
      || (check_branch_existence && branchNames.includes(run.head_branch))
      || (delete_run_by_conclusion_pattern && !delete_run_by_conclusion_pattern.split(",").map(x => x.trim()).includes(run.conclusion));

    if (shouldSkip) {
      skip_runs.push(run);
    } else {
      const created_at = new Date(run.created_at);
      const current = new Date();
      const elapsed_days = (current - created_at) / (1000 * 3600 * 24);

      if (elapsed_days >= retain_days) {
        del_runs.push(run);
      } else {
        skip_runs.push(run);
      }
    }
  });

  if (del_runs.length > keep_minimum_runs) {
    del_runs.sort((a, b) => a.id - b.id);
    skip_runs.push(...del_runs.splice(-keep_minimum_runs));
  }

  return { del_runs, skip_runs };
}

run();
