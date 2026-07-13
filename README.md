# public-shared-workflows

Reusable GitHub Actions for Resend repos.

## Actions

### `sync_prs_to_linear`

Syncs open, non-draft PRs to Linear issues with a 20-calendar-day SLA. PRs are linked through Linear's native GitHub integration so their attachment source is `github`. Idempotent — uses a `linear-synced` label and Linear attachments to avoid duplicates across runs.

**Required permissions:**
```yaml
permissions:
  pull-requests: write
  issues: write
```

**Usage:**
```yaml
steps:
  - uses: resend/public-shared-workflows/.github/actions/sync_prs_to_linear@<commit-sha>
    with:
      linear-api-key: ${{ secrets.LINEAR_API_KEY }}
      linear-team-id: ${{ secrets.LINEAR_TEAM_ID }}
      github-token: ${{ github.token }}
```

| Input | Description |
|-------|-------------|
| `linear-api-key` | Linear API key |
| `linear-team-id` | Linear team ID to create issues in |
| `github-token` | GitHub token with `pull-requests:read` and `issues:write` |
