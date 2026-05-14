import * as core from '@actions/core';
import * as github from '@actions/github';

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const LABEL = 'linear-synced';

const linearApiKey = process.env.LINEAR_API_KEY!;
const linearTeamId = process.env.LINEAR_TEAM_ID!;
const token = process.env.GITHUB_TOKEN!;

interface LinearResponse<T> {
  data?: T;
}

interface FindAttachmentData {
  attachments: {
    nodes: Array<{ id: string; issue: { identifier: string } }>;
  };
}

interface CreateIssueData {
  issueCreate: {
    success: boolean;
    issue: { id: string; identifier: string };
  };
}

interface CreateAttachmentData {
  attachmentCreate: {
    success: boolean;
  };
}

const linearFetch = async <T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<LinearResponse<T>> => {
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      Authorization: linearApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<LinearResponse<T>>;
};

const run = async () => {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  try {
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: LABEL,
      color: '5E6AD2',
      description: 'PR has been synced to Linear',
    });
  } catch (e: unknown) {
    if ((e as { status?: number }).status !== 422) throw e;
  }

  const allPrs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const INTERNAL_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'MANNEQUIN']);

  const isExternalContributor = (pr: (typeof allPrs)[number]) =>
    !INTERNAL_ASSOCIATIONS.has(pr.author_association) &&
    pr.user?.type !== 'Bot' &&
    !pr.user?.login.endsWith('[bot]') &&
    !pr.user?.login.endsWith('-bot');

  const untracked = allPrs.filter(
    pr =>
      !pr.draft &&
      !pr.labels.some(l => l.name === LABEL) &&
      isExternalContributor(pr),
  );

  core.info(`${untracked.length} PR(s) without the label — checking Linear for existing tickets`);

  for (const pr of untracked) {
    const attachmentData = await linearFetch<FindAttachmentData>(
      `query FindAttachment($url: String!) {
        attachments(filter: { url: { eq: $url } }) {
          nodes { id issue { identifier } }
        }
      }`,
      { url: pr.html_url },
    );

    const existing = attachmentData.data?.attachments?.nodes?.[0];

    if (existing) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: pr.number,
        labels: [LABEL],
      });
      core.info(`PR #${pr.number} already has a Linear ticket — re-added label`);
      continue;
    }

    const createData = await linearFetch<CreateIssueData>(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier }
        }
      }`,
      {
        input: {
          teamId: linearTeamId,
          title: `#${pr.number} ${pr.title}`,
          description: `GitHub PR by @${pr.user?.login}: ${pr.html_url}\n\n${pr.body ?? ''}`,
        },
      },
    );

    if (!createData.data?.issueCreate?.success) {
      core.warning(`Failed to create Linear ticket for PR #${pr.number}`);
      continue;
    }

    const issue = createData.data.issueCreate.issue;

    const attachData = await linearFetch<CreateAttachmentData>(
      `mutation CreateAttachment($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) {
          success
        }
      }`,
      {
        input: {
          issueId: issue.id,
          url: pr.html_url,
          title: `GitHub PR #${pr.number}`,
        },
      },
    );

    if (!attachData.data?.attachmentCreate?.success) {
      core.warning(`Failed to attach PR #${pr.number} to Linear ticket`);
    }

    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pr.number,
      labels: [LABEL],
    });

    core.info(`Created Linear ticket ${issue.identifier} for PR #${pr.number}`);
  }
};

run().catch(e => {
  core.setFailed((e as Error).message);
  process.exit(1);
});
