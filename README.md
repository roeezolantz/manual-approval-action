# Manual File Update Approval Action

A GitHub Action that checks if specified files were changed in a PR. If not, it posts a comment asking for confirmation and waits for an emoji reaction from the PR author before passing.

## How it works

1. When a PR is opened/updated, the action checks if the specified files were modified
2. If all files were changed — the check passes immediately
3. If any files are missing — the action posts a comment listing them and asks the PR author to react with a configured emoji to acknowledge
4. The action polls for the emoji reaction until it's found or the timeout is reached
5. Based on the `required` setting, the check either fails or warns on timeout

## Usage

```yaml
name: Check file updates
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  issues: write

jobs:
  check-files:
    runs-on: ubuntu-latest
    steps:
      - uses: roeezolantz/manual-approval-action@v1
        with:
          files: 'CHANGELOG.md'
          emoji: '👍'
```

### Multiple files

```yaml
- uses: roeezolantz/manual-approval-action@v1
  with:
    files: 'CHANGELOG.md,docs/API.md,version.txt'
    emoji: '🚀'
    required: 'false'
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `files` | Comma-separated list of file paths to check | Yes | — |
| `emoji` | Emoji reaction to look for as approval | No | `👍` |
| `comment-message` | Custom comment template (use `{files}` and `{emoji}` placeholders) | No | See below |
| `required` | If `true`, timeout without approval fails the check | No | `true` |
| `poll-interval` | Seconds between reaction polls | No | `10` |
| `timeout` | Total seconds to wait for approval | No | `600` |
| `github-token` | GitHub token for API access | No | `${{ github.token }}` |

### Default comment message

> Hey, I noticed you haven't updated the following files — are you sure about it?
>
> - `CHANGELOG.md`
>
> React with 👍 to confirm you intentionally skipped these updates.

### Custom comment message

Use `{files}` and `{emoji}` placeholders in your template:

```yaml
- uses: roeezolantz/manual-approval-action@v1
  with:
    files: 'CHANGELOG.md'
    comment-message: |
      🔔 **Reminder**: The following files were not updated in this PR:

      {files}

      If this is intentional, react with {emoji} to approve.
```

## Supported emoji reactions

GitHub only supports 8 reaction types. You can use either the emoji character or its string name:

| Emoji | String |
|-------|--------|
| 👍 | `+1` |
| 👎 | `-1` |
| 😄 | `laugh` |
| 😕 | `confused` |
| ❤️ | `heart` |
| 🎉 | `hooray` |
| 🚀 | `rocket` |
| 👀 | `eyes` |

## Behavior on re-runs

When the action re-runs (e.g., after a new commit is pushed), it updates the existing comment instead of posting a duplicate. If the PR author already reacted to the comment, the action will find the reaction immediately and pass.

## License

MIT
