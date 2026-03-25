import * as core from '@actions/core';
import * as github from '@actions/github';

const SENTINEL = '<!-- manual-approval-action -->';

const VALID_REACTIONS = new Set(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']);

const EMOJI_TO_CONTENT: Record<string, string> = {
  '👍': '+1',
  '👎': '-1',
  '😄': 'laugh',
  '😕': 'confused',
  '❤️': 'heart',
  '🎉': 'hooray',
  '🚀': 'rocket',
  '👀': 'eyes',
};

type Octokit = ReturnType<typeof github.getOctokit>;

async function getChangedFiles(octokit: Octokit, owner: string, repo: string, pullNumber: number): Promise<Set<string>> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return new Set(files.map((f) => f.filename));
}

async function findExistingComment(octokit: Octokit, owner: string, repo: string, issueNumber: number): Promise<number | null> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  for (const comment of comments) {
    if (comment.body?.includes(SENTINEL)) {
      return comment.id;
    }
  }
  return null;
}

async function upsertComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  existingId: number | null,
): Promise<number> {
  if (existingId !== null) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body,
    });
    return existingId;
  }
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return data.id;
}

function buildCommentBody(template: string, uncheckedFiles: string[], emoji: string): string {
  const fileList = uncheckedFiles.map((f) => `- \`${f}\``).join('\n');
  const defaultTemplate =
    `Hey, I noticed you haven't updated the following files — are you sure about it?\n\n` +
    `{files}\n\n` +
    `React with {emoji} to confirm you intentionally skipped these updates.`;

  const tmpl = template || defaultTemplate;
  const body = tmpl.replace(/\{files\}/g, fileList).replace(/\{emoji\}/g, emoji);
  return `${body}\n\n${SENTINEL}`;
}

function emojiToReactionContent(emoji: string): string {
  const trimmed = emoji.trim();
  if (VALID_REACTIONS.has(trimmed)) return trimmed;
  const content = EMOJI_TO_CONTENT[trimmed];
  if (!content) {
    const supported = Object.keys(EMOJI_TO_CONTENT).join(' ');
    throw new Error(
      `Unsupported emoji "${emoji}". GitHub only supports these reactions: ${supported}`,
    );
  }
  return content;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  reactionContent: string,
  prAuthor: string,
  pollIntervalSec: number,
  timeoutSec: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  core.info(`Polling for "${reactionContent}" reaction from @${prAuthor} (timeout: ${timeoutSec}s)`);

  while (Date.now() < deadline) {
    const reactions = await octokit.paginate(octokit.rest.reactions.listForIssueComment, {
      owner,
      repo,
      comment_id: commentId,
      content: reactionContent as '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
      per_page: 100,
    });

    const found = reactions.some((r) => r.user?.login === prAuthor);

    if (found) {
      core.info(`Approval reaction found from @${prAuthor}`);
      return true;
    }

    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    core.info(`No approval yet. ${remaining}s remaining. Next check in ${pollIntervalSec}s...`);

    if (Date.now() + pollIntervalSec * 1000 > deadline) {
      break;
    }
    await sleep(pollIntervalSec * 1000);
  }

  // Final check to catch approvals that landed in the last polling window
  const finalReactions = await octokit.paginate(octokit.rest.reactions.listForIssueComment, {
    owner,
    repo,
    comment_id: commentId,
    content: reactionContent as '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
    per_page: 100,
  });
  if (finalReactions.some((r) => r.user?.login === prAuthor)) {
    core.info(`Approval reaction found from @${prAuthor} (final check)`);
    return true;
  }

  return false;
}

async function run(): Promise<void> {
  const context = github.context;

  if (!context.payload.pull_request) {
    core.setFailed('This action can only run on pull_request events.');
    return;
  }

  const token = core.getInput('github-token', { required: true });
  const filesInput = core.getInput('files', { required: true });
  const emoji = core.getInput('emoji');
  const commentMessage = core.getInput('comment-message');
  const required = core.getBooleanInput('required');
  const pollInterval = parseInt(core.getInput('poll-interval'), 10);
  const timeout = parseInt(core.getInput('timeout'), 10);

  if (isNaN(pollInterval) || pollInterval <= 0) {
    core.setFailed('poll-interval must be a positive integer.');
    return;
  }
  if (isNaN(timeout) || timeout <= 0) {
    core.setFailed('timeout must be a positive integer.');
    return;
  }

  const filesToCheck = filesInput.split(',').map((f) => f.trim()).filter(Boolean);
  if (filesToCheck.length === 0) {
    core.setFailed('No files specified to check. Provide a comma-separated list in the "files" input.');
    return;
  }

  const reactionContent = emojiToReactionContent(emoji);
  const octokit = github.getOctokit(token);
  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request.number;
  const prAuthor = context.payload.pull_request.user.login;

  core.info(`Checking if files were changed: ${filesToCheck.join(', ')}`);

  const changedFiles = await getChangedFiles(octokit, owner, repo, pullNumber);
  const uncheckedFiles = filesToCheck.filter((f) => !changedFiles.has(f));

  if (uncheckedFiles.length === 0) {
    core.info('All specified files were updated in this PR. No approval needed.');
    return;
  }

  core.info(`Files not updated: ${uncheckedFiles.join(', ')}`);

  const body = buildCommentBody(commentMessage, uncheckedFiles, emoji);
  const existingCommentId = await findExistingComment(octokit, owner, repo, pullNumber);
  const commentId = await upsertComment(octokit, owner, repo, pullNumber, body, existingCommentId);

  core.info(`Comment ${existingCommentId ? 'updated' : 'created'} (id: ${commentId})`);

  const approved = await pollForReaction(
    octokit,
    owner,
    repo,
    commentId,
    reactionContent,
    prAuthor,
    pollInterval,
    timeout,
  );

  if (approved) {
    core.info('Approval received. Check passed.');
    return;
  }

  if (required) {
    core.setFailed(
      `Timed out waiting for ${emoji} reaction from @${prAuthor}. ` +
      `The following files were not updated: ${uncheckedFiles.join(', ')}`,
    );
  } else {
    core.warning(
      `Timed out waiting for ${emoji} reaction from @${prAuthor}, but check is not required. Passing.`,
    );
  }
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
