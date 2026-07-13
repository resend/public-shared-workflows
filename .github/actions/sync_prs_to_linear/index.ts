import * as core from '@actions/core';
import * as github from '@actions/github';

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const LABEL = 'linear-synced';
const LINEAR_GITHUB_PR_LABEL = 'GitHub PR';
const LINEAR_PRIORITY_LOW = 4;

const linearApiKey = process.env.LINEAR_API_KEY!;
const linearTeamId = process.env.LINEAR_TEAM_ID!;
const token = process.env.GITHUB_TOKEN!;

interface LinearResponse<T> {
  data?: T;
}

interface FindAttachmentData {
  attachments: {
    nodes: Array<{ id: string; issue: { id: string; identifier: string } }>;
  };
}

interface FindIssueLabelData {
  teamLabels: {
    nodes: Array<{ id: string; isGroup: boolean }>;
  };
  workspaceLabels: {
    nodes: Array<{ id: string; isGroup: boolean }>;
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

interface CreateRelationData {
  issueRelationCreate: {
    success: boolean;
  };
}

const FIND_ATTACHMENT_QUERY = `query FindAttachment($url: String!) {
  attachments(filter: { url: { eq: $url } }) {
    nodes { id issue { id identifier } }
  }
}`;

const FIND_ISSUE_LABEL_QUERY = `query FindIssueLabel($teamId: ID!, $labelName: String!) {
  teamLabels: issueLabels(
    first: 10
    filter: { name: { eq: $labelName }, team: { id: { eq: $teamId } } }
  ) {
    nodes { id isGroup }
  }
  workspaceLabels: issueLabels(
    first: 10
    filter: { name: { eq: $labelName }, team: { null: true } }
  ) {
    nodes { id isGroup }
  }
}`;

const CREATE_RELATION_MUTATION = `mutation CreateRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
  }
}`;

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
  let githubPrLabelId: string | undefined;

  const getGitHubPrLabelId = async (): Promise<string> => {
    if (githubPrLabelId) return githubPrLabelId;

    const labelData = await linearFetch<FindIssueLabelData>(FIND_ISSUE_LABEL_QUERY, {
      teamId: linearTeamId,
      labelName: LINEAR_GITHUB_PR_LABEL,
    });
    const label = [
      ...(labelData.data?.teamLabels?.nodes ?? []),
      ...(labelData.data?.workspaceLabels?.nodes ?? []),
    ].find(node => !node.isGroup);

    if (!label) {
      throw new Error(
        `Linear label "${LINEAR_GITHUB_PR_LABEL}" was not found for team ${linearTeamId}`,
      );
    }

    githubPrLabelId = label.id;
    return githubPrLabelId;
  };

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

  const INTERNAL_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR', 'MANNEQUIN']);

  const isBot = (pr: (typeof allPrs)[number]) =>
    pr.user?.type === 'Bot' ||
    pr.user?.login.endsWith('[bot]') ||
    pr.user?.login.endsWith('-bot');

  const isOrgMember = async (username: string): Promise<boolean> => {
    try {
      await octokit.rest.orgs.checkMembershipForUser({ org: owner, username });
      return true;
    } catch {
      return false;
    }
  };

  const getClosingIssueUrls = async (prNumber: number): Promise<string[]> => {
    try {
      const data = await octokit.graphql<{
        repository: {
          pullRequest: { closingIssuesReferences: { nodes: Array<{ url: string }> } };
        };
      }>(
        `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              closingIssuesReferences(first: 20) { nodes { url } }
            }
          }
        }`,
        { owner, repo, number: prNumber },
      );
      return data.repository.pullRequest.closingIssuesReferences.nodes.map(n => n.url);
    } catch (e: unknown) {
      core.warning(
        `Failed to fetch closing issues for PR #${prNumber}: ${(e as Error).message}`,
      );
      return [];
    }
  };

  const candidates = allPrs.filter(
    pr =>
      !pr.draft &&
      !pr.labels.some(l => l.name === LABEL) &&
      !INTERNAL_ASSOCIATIONS.has(pr.author_association) &&
      !isBot(pr),
  );

  const untracked = (
    await Promise.all(
      candidates.map(async pr => {
        if (pr.author_association !== 'CONTRIBUTOR') return pr;
        const member = await isOrgMember(pr.user!.login);
        return member ? null : pr;
      }),
    )
  ).filter(pr => pr !== null);

  core.info(`${untracked.length} PR(s) without the label — checking Linear for existing tickets`);

  for (const pr of untracked) {
    core.info(`Processing PR #${pr.number}`);
    const attachmentData = await linearFetch<FindAttachmentData>(FIND_ATTACHMENT_QUERY, {
      url: pr.html_url,
    });

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

    const linearLabelId = await getGitHubPrLabelId();
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
          priority: LINEAR_PRIORITY_LOW,
          labelIds: [linearLabelId],
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

    const closingUrls = await getClosingIssueUrls(pr.number);
    for (const url of closingUrls) {
      const found = await linearFetch<FindAttachmentData>(FIND_ATTACHMENT_QUERY, { url });
      const related = found.data?.attachments?.nodes?.[0]?.issue;

      if (!related) {
        core.info(`No Linear ticket found for linked issue ${url} — skipping relation`);
        continue;
      }

      const rel = await linearFetch<CreateRelationData>(CREATE_RELATION_MUTATION, {
        input: { issueId: issue.id, relatedIssueId: related.id, type: 'related' },
      });

      if (rel.data?.issueRelationCreate?.success) {
        core.info(`Linked ${issue.identifier} <-> ${related.identifier} (related)`);
      } else {
        core.warning(`Failed to link ${issue.identifier} to ${related.identifier}`);
      }
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
