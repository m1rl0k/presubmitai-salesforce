import { Octokit } from "@octokit/action";
import { COMMENT_SIGNATURE } from "./messages";
import config from "./config";

export type ReviewComment = {
  path: string;
  body: string;
  diff_hunk?: string;
  line?: number;
  in_reply_to_id?: number;
  id: number;
  start_line?: number | null;
  is_own?: boolean;
  user: {
    login: string;
  };
};

export type ReviewCommentThread = {
  file: string;
  comments: ReviewComment[];
};

export async function listPullRequestCommentThreads(
  octokit: Octokit,
  {
    owner,
    repo,
    pull_number,
  }: { owner: string; repo: string; pull_number: number }
): Promise<ReviewCommentThread[]> {
  // Some tests or environments may not expose rest.pulls.listReviewComments;
  // fall back gracefully and return an empty set if unavailable.
  const anyOk = octokit as any;
  const listFn = anyOk?.rest?.pulls?.listReviewComments || anyOk?.pulls?.listReviewComments;
  if (!listFn) {
    return [];
  }

  // Paginate to collect all review comments (large PRs can exceed one page)
  const per_page = 100;
  let page = 1;
  const all: any[] = [];
  while (true) {
    const { data } = await listFn({ owner, repo, pull_number, per_page, page });
    all.push(...data);
    if (!data || data.length < per_page) break;
    page++;
  }

  const comments = all.map((c: any) => ({
    ...c,
    is_own: isOwnComment(c.body),
  }));

  return generateCommentThreads(comments as any);
}

export async function getCommentThread(
  octokit: Octokit,
  {
    owner,
    repo,
    pull_number,
    comment_id,
  }: { owner: string; repo: string; pull_number: number; comment_id: number }
): Promise<ReviewCommentThread | null> {
  const threads = await listPullRequestCommentThreads(octokit, {
    owner,
    repo,
    pull_number,
  });
  return (
    threads.find((t) => t.comments.some((c) => c.id === comment_id)) || null
  );
}

export function isThreadRelevant(thread: ReviewCommentThread): boolean {
  return thread.comments.some(
    (c) =>
      c.body.includes(COMMENT_SIGNATURE) ||
      c.body.includes("@presubmitai") ||
      c.body.includes("@presubmit")
  );
}

function generateCommentThreads(
  reviewComments: ReviewComment[]
): ReviewCommentThread[] {
  // Build reply index in a single pass to avoid O(n^2)
  const repliesByParent = new Map<number, ReviewComment[]>();
  const topLevelComments: ReviewComment[] = [];

  for (const c of reviewComments) {
    if (c.in_reply_to_id) {
      if (!repliesByParent.has(c.in_reply_to_id)) repliesByParent.set(c.in_reply_to_id, []);
      repliesByParent.get(c.in_reply_to_id)!.push(c);
      continue;
    }
    // Recognize multiline top-level comments (line may be null but start_line is set)
    const hasAnchor = typeof c.line === 'number' || typeof c.start_line === 'number';
    if (c.body.length && hasAnchor) {
      topLevelComments.push(c);
    }
  }

  return topLevelComments.map((top) => ({
    file: top.path,
    comments: [top, ...(repliesByParent.get(top.id) || [])],
  }));
}

export function isOwnComment(comment: string): boolean {
  return comment.includes(COMMENT_SIGNATURE);
}

function truncateCodeBlocks(text: string, maxLines: number): string {
  const lines = text.split("\n");
  let inFence = false;
  let codeLines = 0;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceStart = /^```/.test(line);

    if (fenceStart) {
      if (!inFence) {
        // entering a code fence
        inFence = true;
        codeLines = 0;
        out.push(line);
        continue;
      } else {
        // exiting fence
        inFence = false;
        out.push(line);
        continue;
      }
    }

    if (inFence) {
      codeLines++;
      if (codeLines <= maxLines) {
        out.push(line);
      } else if (codeLines === maxLines + 1) {
        out.push("... (truncated; more lines omitted) ...");
        // Skip until we find the closing fence; it will be handled when fenceStart hits again
      } else {
        // skip extra lines
      }
    } else {
      out.push(line);
    }
  }

  return out.join("\n");
}

export function buildComment(comment: string): string {
  const maxLines = (config as any).maxCodeblockLines ?? 60;
  const processed = truncateCodeBlocks(comment, maxLines);
  return processed + "\n\n" + COMMENT_SIGNATURE;
}
