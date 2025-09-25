import { info, warning } from "@actions/core";
import config from "./config";
import { initOctokit } from "./octokit";
import { loadContext } from "./context";
import { runSummaryPrompt, AIComment, runReviewPrompt as runReviewPromptCore } from "./prompts";
import { runReviewPrompt as runReviewPromptSalesforce } from "./prompts.salesforce";
import {
  buildLoadingMessage,
  buildReviewSummary,
  buildOverviewMessage,
  OVERVIEW_MESSAGE_SIGNATURE,
  PAYLOAD_TAG_CLOSE,
  PAYLOAD_TAG_OPEN,
  DOCUMENTATION_SIGNATURE,
} from "./messages";
import { FileDiff, parseFileDiff } from "./diff";
import { Octokit } from "@octokit/action";
import { Context } from "@actions/github/lib/context";
import { buildComment, listPullRequestCommentThreads, isThreadRelevant } from "./comments";

const IS_DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const FORCE_FULL_REVIEW = process.env.FORCE_FULL_REVIEW === "1" || process.env.FORCE_FULL_REVIEW === "true";

export async function handlePullRequest() {
  const context = await loadContext();
  if (
    context.eventName !== "pull_request" &&
    context.eventName !== "pull_request_target"
  ) {
    warning("unsupported github event");
    return;
  }

  const { pull_request } = context.payload;
  if (!pull_request) {
    warning("`pull_request` is missing from payload");
    return;
  }

  const octokit = initOctokit(config.githubToken, config.githubApiUrl);

  if (shouldIgnorePullRequest(pull_request)) {
    return;
  }

  // Get commit messages (paginated for large PRs)
  const commits: { sha: string; commit: { message: string } }[] = [];
  let pageCommits = 1;
  const perPageCommits = 100;
  while (true) {
    const { data } = await octokit.rest.pulls.listCommits({
      ...context.repo,
      pull_number: pull_request.number,
      per_page: perPageCommits,
      page: pageCommits,
    });
    commits.push(...data.map(c => ({ sha: c.sha, commit: { message: c.commit.message } })));
    if (data.length < perPageCommits) break;
    pageCommits++;
  }
  info(`successfully fetched commit messages (${commits.length} commits)`);

  // Find or create overview comment with the summary (paginate to be safe)
  const existingComments: any[] = [];
  let pageComments = 1;
  const perPageComments = 100;
  while (true) {
    const { data } = await octokit.rest.issues.listComments({
      ...context.repo,
      issue_number: pull_request.number,
      per_page: perPageComments,
      page: pageComments,
    });
    existingComments.push(...data);
    if (data.length < perPageComments) break;
    pageComments++;
  }
  let overviewComment = existingComments.find((comment) =>
    comment.body?.includes(OVERVIEW_MESSAGE_SIGNATURE)
  );
  const isIncrementalReview = !!overviewComment && !FORCE_FULL_REVIEW;

  // Maybe fetch review comments
  const reviewCommentThreads = isIncrementalReview
    ? await listPullRequestCommentThreads(octokit, {
        ...context.repo,
        pull_number: pull_request.number,
      })
    : [];

  // Get modified files (with pagination up to all pages)
  const files = await fetchAllPullRequestFiles(octokit, context, pull_request.number);
  let filesToReview = files.map((file) => parseFileDiff(file, reviewCommentThreads));
  info(`successfully fetched file diffs`);

  let commitsReviewed: string[] = [];
  let lastCommitReviewed: string | null = null;
  if (isIncrementalReview) {
    info(`running incremental review`);
    try {
      let payloadJson = "{}";
      const body = overviewComment!.body || "";
      const hasOpen = body.includes(PAYLOAD_TAG_OPEN);
      const hasClose = body.includes(PAYLOAD_TAG_CLOSE);
      if (hasOpen && hasClose) {
        const start = body.indexOf(PAYLOAD_TAG_OPEN) + PAYLOAD_TAG_OPEN.length;
        const end = body.indexOf(PAYLOAD_TAG_CLOSE, start);
        if (end > start) payloadJson = body.slice(start, end);
      }
      const payload = JSON.parse(payloadJson);
      commitsReviewed = Array.isArray(payload.commits) ? payload.commits : [];
    } catch (error) {
      info(`could not parse overview payload (continuing fresh): ${error}`);
    }

    // Check if there are any incremental changes
    lastCommitReviewed =
      commitsReviewed.length > 0
        ? commitsReviewed[commitsReviewed.length - 1]
        : null;
    const incrementalDiff =
      lastCommitReviewed && lastCommitReviewed != pull_request.head.sha
        ? await octokit.rest.repos.compareCommits({
            ...context.repo,
            base: lastCommitReviewed,
            head: pull_request.head.sha,
          })
        : null;
    if (incrementalDiff?.data?.files) {
      // If incremental review, only consider files that were modified within incremental change.
      filesToReview = filesToReview.filter((f) =>
        incrementalDiff.data.files?.some((f2) => f2.filename === f.filename)
      );
    }
  } else {
    info(`running full review${FORCE_FULL_REVIEW ? ' (forced)' : ''}`);
  }

  const commitsToReview = commitsReviewed.length
    ? commits.filter((c) => !commitsReviewed.includes(c.sha))
    : commits;
  if (commitsToReview.length === 0) {
    // Even when no new commits, still ensure deterministic docs (fields/flows/apex) are posted/updated
    try {
      const detailedFieldsDoc = buildCustomFieldsDoc(filesToReview);
      const minimalFieldsDoc = buildNewCustomFieldsDoc(filesToReview);
      const fieldsDocCombined = detailedFieldsDoc || minimalFieldsDoc;
      const flowsDoc = buildFlowsDoc(filesToReview);
      const apexDoc = buildApexDoc(filesToReview);
      const combinedDocs = [fieldsDocCombined, flowsDoc, apexDoc].filter(Boolean).join("\n\n");
      if (combinedDocs && combinedDocs.trim().length > 0) {
        const docBody = combinedDocs.trim() + "\n\n" + DOCUMENTATION_SIGNATURE;
        let docComment = existingComments.find((comment) => comment.body?.includes(DOCUMENTATION_SIGNATURE));
        if (IS_DRY_RUN) {
          info(`DRY-RUN: would ${docComment ? 'update' : 'create'} documentation comment`);
          console.log(docBody);
        } else if (docComment) {
          await octokit.rest.issues.updateComment({
            ...context.repo,
            comment_id: docComment.id,
            body: docBody,
          });
          info(`updated documentation comment (no-new-commits)`);
        } else {
          await octokit.rest.issues.createComment({
            ...context.repo,
            issue_number: pull_request.number,
            body: docBody,
          });
          info(`posted documentation comment (no-new-commits)`);
        }
      }
    } catch (e) {
      warning(`error posting documentation comment in no-new-commits path: ${e}`);
    }
    info(`no new commits to review`);
    return;
  }

  if (IS_DRY_RUN) {
    const body = buildLoadingMessage(
      (lastCommitReviewed ?? pull_request.base.sha),
      commitsToReview,
      filesToReview
    );
    info(`DRY-RUN: would ${overviewComment ? 'update' : 'create'} overview loading comment`);
    // Show the loading message content for transparency
    console.log(body);
  } else if (overviewComment) {
    await octokit.rest.issues.updateComment({
      ...context.repo,
      comment_id: overviewComment.id,
      body: buildLoadingMessage(
        lastCommitReviewed ?? pull_request.base.sha,
        commitsToReview,
        filesToReview
      ),
    });
    info(`updated existing overview comment`);
  } else {
    overviewComment = (
      await octokit.rest.issues.createComment({
        ...context.repo,
        issue_number: pull_request.number,
        body: buildLoadingMessage(
          pull_request.base.sha,
          commitsToReview,
          filesToReview
        ),
      })
    ).data;
    info(`posted new overview loading comment`);
  }

  // Generate PR summary
  // Compress commit messages: keep subject lines only and cap to last 100
  const commitSubjects = commits
    .map((c) => (c.commit.message || "").split("\n")[0])
    .slice(-100);

  const summary = await runSummaryPrompt({
    prTitle: pull_request.title,
    prDescription: pull_request.body || "",
    commitMessages: commitSubjects,
    files: files,
  });
  info(`generated pull request summary: ${summary.title}`);

  // Update PR title if allowed and @presubmit is mentioned in the title
  if (
    (config as any).allowTitleUpdate && (
      pull_request.title.includes("@presubmitai") ||
      pull_request.title.includes("@presubmit")
    )
  ) {
    info(`title contains mention of presubmit.ai, so generating a new title`);
    if (IS_DRY_RUN) {
      info(`DRY-RUN: would update PR title to: ${summary.title}`);
    } else {
      await octokit.rest.pulls.update({
        ...context.repo,
        pull_number: pull_request.number,
        title: summary.title,
        // body: summary.description,
      });
    }
  }

  // Update overview comment with the PR overview
  const walkthroughBody = buildOverviewMessage(
    summary,
    commits.map((c) => c.sha),
    filesToReview
  );
  if (IS_DRY_RUN) {
    info(`DRY-RUN: would update overview comment with walkthrough`);
    console.log(walkthroughBody);
  } else {
    await octokit.rest.issues.updateComment({
      ...context.repo,
      comment_id: overviewComment.id,
      body: walkthroughBody,
    });
    info(`updated overview comment with walkthrough`);
  }

  // ======= START REVIEW =======

  // Batch files by approximate character size to avoid LLM context overflows
  const batchFilesByChars = (files: FileDiff[], maxChars: number): FileDiff[][] => {
    const batches: FileDiff[][] = [];
    let current: FileDiff[] = [];
    let size = 0;
    const estimate = (f: FileDiff) => {
      const hunksSize = f.hunks.reduce((acc, h) => acc + (h.diff?.length || 0), 0);
      // add overhead for headers/markup
      return hunksSize + (f.filename?.length || 0) + 200;
    };
    for (const f of files) {
      const s = estimate(f);
      if (current.length && size + s > maxChars) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(f);
      size += s;
    }
    if (current.length) batches.push(current);
    return batches;
  };

  // Three focused passes: data-model, flows, apex (configurable)
  const scopes: string[] = Array.isArray((config as any).reviewScopes) && (config as any).reviewScopes!.length
    ? (config as any).reviewScopes!
    : ["data-model", "flows", "apex"];

  let allComments: AIComment[] = [];
  let firstReviewDoc: string | undefined;
  let totalBatches = 0;

  for (const scope of scopes) {
    const subset = filterFilesByScope(filesToReview, scope);
    if (!subset.length) continue;
    const batches = batchFilesByChars(subset, (config as any).maxReviewChars ?? 600000);
    totalBatches += batches.length;
    for (const batch of batches) {
      const useSF = shouldUseSalesforce(batch, (config as any).salesforceMode);
      const runner = useSF ? runReviewPromptSalesforce : runReviewPromptCore;
      const part = await runner({
        files: batch,
        prTitle: pull_request.title,
        prDescription: pull_request.body || "",
        prSummary: summary.description,
      });
      if (part?.comments?.length) allComments.push(...part.comments);
      if (!firstReviewDoc && part?.documentation?.trim()) firstReviewDoc = part.documentation.trim();
    }
    info(`review pass '${scope}' completed in ${batches.length} batch(es)`);
  }
  info(`reviewed pull request across ${scopes.length} scope(s) with ${totalBatches} batch(es)`);

  // Post review comments
  const comments = allComments.filter(
    (c) => c.content.trim() !== "" && files.some((f) => f.filename === c.file)
  );

  // Build deterministic documentation sections (fields + flows + apex)
  const detailedFieldsDoc = buildCustomFieldsDoc(filesToReview);
  const minimalFieldsDoc = buildNewCustomFieldsDoc(filesToReview);
  const fieldsDocCombined = detailedFieldsDoc || minimalFieldsDoc;
  const flowsDoc = buildFlowsDoc(filesToReview);
  const apexDoc = buildApexDoc(filesToReview);
  const combinedDocs = [fieldsDocCombined, flowsDoc, apexDoc].filter(Boolean).join("\n\n");

  // Post or update a single consolidated documentation comment (if any)
  try {
    const documentationText = combinedDocs;
    if (documentationText && documentationText.trim().length > 0) {
      const docBody = documentationText.trim() + "\n\n" + DOCUMENTATION_SIGNATURE;
      let docComment = existingComments.find((comment) => comment.body?.includes(DOCUMENTATION_SIGNATURE));
      if (IS_DRY_RUN) {
        info(`DRY-RUN: would ${docComment ? 'update' : 'create'} documentation comment`);
        console.log(docBody);
      } else if (docComment) {
        await octokit.rest.issues.updateComment({
          ...context.repo,
          comment_id: docComment.id,
          body: docBody,
        });
        info(`updated documentation comment`);
      } else {
        await octokit.rest.issues.createComment({
          ...context.repo,
          issue_number: pull_request.number,
          body: docBody,
        });
        info(`posted documentation comment`);
      }
    }
  } catch (e) {
    warning(`error posting documentation comment: ${e}`);
  }

  // Update the overview comment again to combine Summary + Rationale into one
  try {
    const combinedBody = buildOverviewMessage(
      summary,
      commits.map((c) => c.sha),
      filesToReview,
      firstReviewDoc && firstReviewDoc.trim()
    );
    if (IS_DRY_RUN) {
      info(`DRY-RUN: would update overview with combined rationale`);
      console.log(combinedBody);
    } else {
      await octokit.rest.issues.updateComment({
        ...context.repo,
        comment_id: overviewComment.id,
        body: combinedBody,
      });
      info(`updated overview comment with combined rationale`);
    }
  } catch (e) {
    warning(`error updating combined overview comment: ${e}`);
  }


  if (IS_DRY_RUN) {
    info(`DRY-RUN: would submit review with ${comments.length} inline comments`);
    const finalBody = buildOverviewMessage(
      summary,
      commits.map((c) => c.sha),
      filesToReview,
      firstReviewDoc && firstReviewDoc.trim()
    );
    console.log('=== Final Overview (dry-run) ===');
    console.log(finalBody);
    if (comments.length) {
      console.log('=== Inline Comments (dry-run) ===');
      for (const c of comments) {
        const range = c.start_line && c.end_line ? `${c.start_line}-${c.end_line}` : `${c.end_line ?? ''}`;
        console.log(`• ${c.file}:${range} ${c.label ? '['+c.label+'] ' : ''}${c.critical ? '(critical) ' : ''}\n${c.content}\n`);
      }
    }
    return;
  }

  await submitReview(
    octokit,
    context,
    {
      number: pull_request.number,
      headSha: pull_request.head.sha,
    },
    comments,
    commitsToReview,
    filesToReview,
    undefined
  );
  info(`posted review comments`);
}

async function submitReview(
  octokit: Octokit,
  context: Context,
  pull_request: {
    number: number;
    headSha: string;
  },
  comments: AIComment[],
  commits: {
    sha: string;
    commit: {
      message: string;
    };
  }[],
  files: FileDiff[],
  documentation?: string
) {
  // Prepare thread continuity and rename-aware mapping
  const prThreadsAll = await listPullRequestCommentThreads(octokit, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pull_request.number,
  });
  const prThreads = prThreadsAll.filter(isThreadRelevant);

  // Normalized API wrappers to support both shapes (top-level and rest.*)
  const pullsApi: any = (octokit as any).pulls ?? (octokit as any).rest?.pulls;
  const issuesApi: any = (octokit as any).issues ?? (octokit as any).rest?.issues;

  // Index threads for O(1) lookup by file/line/start_line
  const makeKey = (path: string, endLine?: number, startLine?: number) =>
    `${path}#${endLine ?? ""}#${startLine ?? ""}`;
  const threadsIndex = new Map<string, (typeof prThreads)[number]>();
  for (const t of prThreads) {
    const top = t.comments[0];
    if (!top) continue;
    const end = typeof top.line === "number" ? top.line : undefined;
    const start = typeof top.start_line === "number" ? top.start_line : undefined;
    threadsIndex.set(makeKey(t.file, end, start), t);
  }

  const resolveReviewPath = (p: string): string => {
    const f = files.find((fd) => fd.previous_filename === p);
    return f ? f.filename : p;
  };

  const findExistingThread = (
    path: string,
    endLine?: number,
    startLine?: number
  ) => {
    if (typeof endLine !== "number") return null; // need an anchor to match
    return threadsIndex.get(makeKey(path, endLine, startLine)) || null;
  };

  // Build a tiny unified excerpt (±context lines) around a target new-file line
  const getUnifiedExcerpt = (
    files: FileDiff[],
    path: string,
    line: number,
    contextLines: number = 2
  ): string | undefined => {
    const fd =
      files.find((f) => f.filename === path) ||
      files.find((f) => f.previous_filename === path);
    if (!fd || !fd.hunks?.length) return undefined;
    const hunk = fd.hunks.find((h) => line >= h.startLine && line <= h.endLine);
    if (!hunk) return undefined;
    const rows = hunk.diff.split("\n");
    let newLine = hunk.startLine;
    const numbered: { n?: number; s: string }[] = [];
    for (const r of rows) {
      if (!r) continue;
      if (r.startsWith("@@")) {
        numbered.push({ s: r });
        continue;
      }
      if (r.startsWith("-")) {
        numbered.push({ s: r });
      } else {
        numbered.push({ n: newLine, s: r });
        newLine++;
      }
    }
    const idx = numbered.findIndex((x) => x.n === line);
    if (idx === -1) return undefined;
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(numbered.length - 1, idx + contextLines);
    return numbered
      .slice(start, end + 1)
      .map((x) => (x.n !== undefined ? `${x.n} ${x.s}` : x.s))
      .join("\n");
  };

  // Small helpers: sleep, retries with backoff, and limited concurrency processing
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (i === attempts - 1) break;
        await sleep(250 * (i + 1));
      }
    }
    throw lastErr;
  }
  async function processWithConcurrency<T, R>(
    items: T[],
    worker: (item: T, index: number) => Promise<R>,
    concurrency = 3
  ): Promise<Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: any }>> {
    const results: Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: any }> = new Array(items.length);
    let idx = 0;
    async function run() {
      while (true) {
        const i = idx++;
        if (i >= items.length) break;
        try {
          const val = await worker(items[i], i);
          results[i] = { status: "fulfilled", value: val };
        } catch (err) {
          results[i] = { status: "rejected", reason: err };
        }
      }
    }
    const workers = Array(Math.min(concurrency, items.length)).fill(null).map(() => run());
    await Promise.all(workers);
    return results;
  }

  // Upsert helpers for PR-level comments to avoid duplicates across reruns
  function hashString(input: string): string {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
      h = (h * 33) ^ input.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }
  function makeStableKey(
    kind: string,
    file: string,
    line?: number,
    header?: string,
    content?: string
  ): string {
    const firstLine = (content || "").split("\n")[0].trim().toLowerCase();
    return `${kind}|${file}|${line ?? 0}|${(header || firstLine).slice(0, 80)}`;
  }
  function makeUpsertSignature(
    kind: "file-note" | "fallback",
    file: string,
    line?: number,
    header?: string,
    content?: string
  ): string {
    const key = makeStableKey(kind, file, line, header, content);
    const hash = hashString(key);
    return `<!-- presubmit.ai: upsert:${hash}:${key} -->`;
  }
  async function upsertIssueCommentBySignature(sig: string, body: string) {
    const per_page = 100;
    let page = 1;
    let existing: any | null = null;
    while (true) {
      const { data } = await issuesApi.listComments({
        ...context.repo,
        issue_number: pull_request.number,
        per_page,
        page,
      });
      const match = data.find((c: any) => typeof c.body === "string" && c.body.includes(sig));
      if (match) {
        existing = match;
        break;
      }
      if (!data || data.length < per_page) break;
      page++;
    }
    if (existing) {
      await issuesApi.updateComment({
        ...context.repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await issuesApi.createComment({
        ...context.repo,
        issue_number: pull_request.number,
        body,
      });
    }
  }


  const submitInlineComment = async (
    file: string,
    line: number,
    content: string,
    startLine?: number
  ) => {
    const targetPath = resolveReviewPath(file);
    if (line > 0) {
      const t = findExistingThread(targetPath, line, startLine);
      if (t) {
        // Reply under existing thread (reduces noise)
        await pullsApi.createReplyForReviewComment({
          ...context.repo,
          pull_number: pull_request.number,
          comment_id: t.comments[0].id,
          body: buildComment(content),
        });
        return;
      }
    }
    await pullsApi.createReviewComment({
      ...context.repo,
      pull_number: pull_request.number,
      commit_id: pull_request.headSha,
      path: targetPath,
      body: buildComment(content),
      line,
    });
  };

  // Handle file-level comments (no end_line): post as PR-level comments
  const fileComments = comments.filter((c) => !c.end_line);
  if (fileComments.length > 0) {
    for (const c of fileComments) {
      try {
        const headerPart = c.header && c.header.trim().length ? `${c.header}\n\n` : "";
        const codeBlock = c.highlighted_code && c.highlighted_code.trim().length
          ? `\n\n\`\`\`\n${c.highlighted_code}\n\`\`\``
          : "";
        const targetFile = resolveReviewPath(c.file);
        const sig = makeUpsertSignature("file-note", targetFile, undefined, c.header, c.content);
        const rawBody = `${headerPart}${c.content}\n\nFile: ${targetFile}${codeBlock}`;
        const bodyWithSig = `${sig}\n${rawBody}`;
        await withRetries(() => upsertIssueCommentBySignature(sig, buildComment(bodyWithSig)));
      } catch (e) {
        warning(`error creating file-level comment: ${e}`);
      }
    }


  }

  // Handle line comments - keep only worthwhile ones; no deduping, hard cap applies
  let lineComments: AIComment[] = [];
  let skippedComments: AIComment[] = [];

  const HIGH_VALUE_LABELS = new Set([
    "security",
    "possible bug",
    "bug",
    "performance",
  ]);

  for (const comment of comments) {
    // Skip file-level comments here; they were posted as PR-level notes above
    if (!comment.end_line) {
      skippedComments.push(comment);
      continue;
    }

    const label = (comment.label || "").toLowerCase();
    const content = (comment.content || "").trim();
    const contentLen = content.length;
    const isHighValue = comment.critical || HIGH_VALUE_LABELS.has(label);
    const isTypos = label === "typo";

    const hasCode = /```/.test(content);
    const hasKeywords = /\b(sql|xss|csrf|injection|overflow|sqli|dos|race|leak)\b/i.test(content);
    const longEnough = contentLen >= 30;
    const isSubstantive = longEnough || hasCode || hasKeywords || (comment.critical && contentLen >= 10);

    if (isHighValue || isTypos) {
      const minLen = isTypos ? 10 : 0;
      if (isSubstantive || contentLen >= minLen) {
        lineComments.push(comment);
      } else {
        skippedComments.push(comment);
      }
    } else {
      skippedComments.push(comment);
    }
  }

  // Cap total comments to avoid noise (configurable via REVIEW_MAX_COMMENTS / input 'max_comments')
  const MAX_TOTAL_COMMENTS = (config as any).maxComments ?? 40;
  if (lineComments.length > MAX_TOTAL_COMMENTS) {
    // Move overflow into skipped for transparency in the summary
    skippedComments = skippedComments.concat(lineComments.slice(MAX_TOTAL_COMMENTS));
    lineComments = lineComments.slice(0, MAX_TOTAL_COMMENTS);
  }

  // Submit comments in batches to avoid GitHub payload limits
  const MAX_COMMENTS_PER_REVIEW = 50; // conservative safety margin

  // Thread continuity: split comments into (a) new anchors and (b) replies to existing threads
  const anchorComments = lineComments.filter(
    (c) => !findExistingThread(resolveReviewPath(c.file), c.end_line, c.start_line)
  );
  const replyCandidates = lineComments.filter(
    (c) => !!findExistingThread(resolveReviewPath(c.file), c.end_line, c.start_line)
  );

  const commentsData = anchorComments.map((c) => ({
    path: resolveReviewPath(c.file),
    body: buildComment(c.content),
    line: c.end_line,
    side: "RIGHT" as const,
    start_line: c.start_line && c.start_line < c.end_line ? c.start_line : undefined,
    start_side: c.start_line && c.start_line < c.end_line ? ("RIGHT" as const) : undefined,
  }));

  const chunk = <T,>(arr: T[], size: number): T[][] => {
    if (size <= 0) return [arr];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  // Post thread replies individually (keeps threads together, reduces noise)
  try {
    for (const c of replyCandidates) {
      const targetPath = resolveReviewPath(c.file);
      const t = findExistingThread(targetPath, c.end_line, c.start_line);
      if (t) {
        await withRetries(() =>
          pullsApi.createReplyForReviewComment({
            ...context.repo,
            pull_number: pull_request.number,
            comment_id: t.comments[0].id,
            body: buildComment(c.content),
          })
        );
      } else {
        await withRetries(() => submitInlineComment(targetPath, c.end_line, c.content, c.start_line));
      }
    }
  } catch (e) {
    warning(`error posting thread replies: ${e}`);
  }

  const batches = chunk(commentsData, MAX_COMMENTS_PER_REVIEW);

  // If there are no inline comments, still post the summary/documentation as a single review
  if (batches.length === 0) {
    try {
      const review = await pullsApi.createReview({
        ...context.repo,
        pull_number: pull_request.number,
        commit_id: pull_request.headSha,
        comments: [],
      });
      await pullsApi.submitReview({
        ...context.repo,
        pull_number: pull_request.number,
        review_id: review.data.id,
        event: "COMMENT",
        body: buildReviewSummary(
          context,
          files,
          commits,
          lineComments,
          skippedComments,
          documentation
        ),
      });
    } catch (error) {
      warning(`error submitting empty review body: ${error}`);
    }
  } else {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        const review = await pullsApi.createReview({
          ...context.repo,
          pull_number: pull_request.number,
          commit_id: pull_request.headSha,
          comments: batch,
        });

        const isFirst = i === 0;
        await pullsApi.submitReview({
          ...context.repo,
          pull_number: pull_request.number,
          review_id: review.data.id,
          event: "COMMENT",
          body: isFirst
            ? buildReviewSummary(
                context,
                files,
                commits,
                lineComments,
                skippedComments,
                documentation
              )
            : `Additional review comments (batch ${i + 1}/${batches.length}).`,
        });
      } catch (error) {
        // Batch submission can fail if any comment maps outside the diff hunk.
        // Fall back to durable per-comment posting AND still publish the summary body.
        info(`batch review failed; falling back to per-comment: ${error}`);
        const results = await processWithConcurrency(
          batch,
          async (cm) =>
            withRetries(() => submitInlineComment(cm.path, cm.line!, cm.body, cm.start_line)),
          3
        );
        // For any per-comment failures, post a top-level PR comment with file/line and code excerpt
        for (let j = 0; j < results.length; j++) {
          const res = results[j];
          if (res.status === "rejected") {
            try {
              const cm = batch[j];
              const orig = lineComments.find(
                (c) => c.file === cm.path && c.end_line === cm.line
              );
              const targetPathFallback = resolveReviewPath(cm.path);
              const fd = files.find(
                (f) => f.filename === targetPathFallback || f.previous_filename === targetPathFallback
              );
              const renameNote = fd?.status === "renamed"
                ? `\n\nRenamed: ${fd.previous_filename} → ${fd.filename}`
                : "";

              let codeBlock = "";
              if (orig?.highlighted_code && orig.highlighted_code.trim().length) {
                codeBlock = `\n\n\`\`\`\n${orig.highlighted_code}\n\`\`\``;
              } else {
                const ex = getUnifiedExcerpt(files, targetPathFallback, cm.line!, 2);
                if (ex) {
                  codeBlock = `\n\n\`\`\`diff\n${ex}\n\`\`\``;
                }
              }

              const fallbackBody = `${cm.body}\n\nContext: ${targetPathFallback}:${cm.line}${renameNote}` +
                (orig?.header ? `\n\n${orig.header}` : "") +
                codeBlock;
              const sig = makeUpsertSignature("fallback", targetPathFallback, cm.line!, orig?.header, cm.body);
              const bodyWithSig = `${sig}\n${fallbackBody}`;
              await upsertIssueCommentBySignature(sig, buildComment(bodyWithSig));
            } catch (e3) {
              warning(`error posting top-level fallback comment: ${e3}`);
            }
          }
        }
        // Only submit the review summary body on fallback if this was the first batch
        if (i === 0) {
          try {
            const review = await pullsApi.createReview({
              ...context.repo,
              pull_number: pull_request.number,
              commit_id: pull_request.headSha,
              comments: [],
            });
            await pullsApi.submitReview({
              ...context.repo,
              pull_number: pull_request.number,
              review_id: review.data.id,
              event: "COMMENT",
              body: buildReviewSummary(
                context,
                files,
                commits,
                lineComments,
                skippedComments,
                documentation
              ),
            });
          } catch (error2) {
            warning(`error submitting fallback review summary: ${error2}`);
          }
        }
      }
    }
  }

}

// Pagination helper to fetch all PR files
async function fetchAllPullRequestFiles(
  octokit: Octokit,
  context: Context,
  pull_number: number
) {
  const per_page = 100;
  let page = 1;
  let all: any[] = [];
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      ...context.repo,
      pull_number,
      per_page,
      page,
    });
    all = all.concat(data);
    if (data.length < per_page) break;
    page++;
  }
  return all;
}

function isSalesforceFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  const extHits = [
    ".cls",
    ".trigger",
    ".apex",
    ".tst",
    ".page",
    ".cmp",
    ".component",
    ".resource",
    "-meta.xml",
  ].some((ext) => lower.endsWith(ext));

  const pathHits = lower.includes("/lwc/") || lower.includes("/aura/");
  const lwcFiles = [".js", ".ts", ".html", ".css", ".xml"].some((ext) =>
    lower.endsWith(ext)
  );

  return extHits || (pathHits && lwcFiles);
}

function shouldUseSalesforce(files: FileDiff[], mode?: string): boolean {
  const m = (mode || "auto").toLowerCase();
  if (m === "on") return true;
  if (m === "off") return false;
  return files.some((f) => isSalesforceFile(f.filename));
}


function shouldIgnorePullRequest(pull_request: { body?: string }) {
  const ignorePhrases = [
    "@presubmit ignore",
    "@presubmit: ignore",
    "@presubmit skip",
    "@presubmit: skip",
    "@presubmitai ignore",
    "@presubmitai: ignore",
    "@presubmitai skip",
    "@presubmitai: skip",
  ];
  const bodyLower = (pull_request.body ?? "").toLowerCase();

  for (const phrase of ignorePhrases) {
    if (bodyLower.includes(phrase.toLowerCase())) {
      info(`ignoring pull request because of '${phrase}' in description`);
      return true;
    }
  }
  return false;

}

// Build a minimal documentation block for NEW custom fields by inspecting file paths and added XML lines
function buildNewCustomFieldsDoc(files: FileDiff[]): string | undefined {
  type Entry = {
    objectApi: string;
    fieldApi: string;
    label?: string;
    type?: string;
    required?: string;
    def?: string;
    values?: string;
  };
  const entries: Entry[] = [];

  for (const f of files) {
    const n = f.filename || "";
    if (
      f.status === "added" &&
      n.includes("/objects/") &&
      n.includes("/fields/") &&
      n.endsWith(".field-meta.xml")
    ) {
      const parts = n.split("/objects/")[1]?.split("/") || [];
      const objectApi = parts[0] || "";
      const fieldApi = parts[2]?.replace(".field-meta.xml", "") || "";
      const entry: Entry = { objectApi, fieldApi };

      const addedLines = f.hunks
        .flatMap((h) => h.diff.split("\n"))
        .filter((l) => l.trim().startsWith("+"))
        .map((l) => l.replace(/^\+\s?/, ""));


      const xml = addedLines.join('\n');
      const getText = (tag: string): string | undefined => {
        const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
        return m && m[1] ? m[1].trim() : undefined;
      };

      const findTag = (tag: string) => {
        const r = new RegExp(`<${tag}>([\ -\\s\S]*?)<\\/${tag}>`);
        for (const line of addedLines) {
          const m = line.match(r);
          if (m && m[1]) return m[1].trim();
        }
        return undefined;
      };

      // Safe regex variant (avoids weird char ranges from patches)
      const findTag2 = (tag: string) => {
        const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
        for (const ln of addedLines) {
          const m = r.exec(ln);
          if (m && m[1]) return m[1].trim();
        }
        return undefined;
      };


      entry.label = getText("label");
      entry.type = getText("type");
      entry.required = getText("required");
      entry.def = getText("defaultValue");

      // Try to extract picklist values or global value set reference
      let values: string | undefined = undefined;
      for (const line of addedLines) {
        const m1 = new RegExp("<value>\\s*<fullName>([^<]+)</fullName>").exec(line);
        if (m1) {
          values = values ? `${values}, ${m1[1]}` : m1[1];
        }
        const m2 = new RegExp("<valueSetName>([^<]+)</valueSetName>").exec(line);
        if (m2) {
          values = `GVS:${m2[1]}`;
        }
      }
      entry.values = values;
      entries.push(entry);
    }
  }

  if (entries.length === 0) return undefined;

  const lines: string[] = [];
  lines.push("## Salesforce Metadata Change Documentation");
  lines.push("### New Custom Fields");
  lines.push("| Object | Field | Label | Type | Required | Default | Values |");
  lines.push("|---|---|---|---|:---:|---|---|");
  for (const e of entries) {
    lines.push(
      `| ${e.objectApi} | ${e.fieldApi} | ${e.label ?? ""} | ${e.type ?? "n/a"} | ${e.required ?? "n/a"} | ${e.def ?? "n/a"} | ${e.values ?? "n/a"} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}



// Build documentation block for NEW and CHANGED custom fields by inspecting diffs
function buildCustomFieldsDoc(files: FileDiff[]): string | undefined {
  type NewEntry = {
    objectApi: string;
    fieldApi: string;
    label?: string;
    type?: string;
    required?: string;
    def?: string;
    values?: string;
  };
  type ChangedEntry = {
    objectApi: string;
    fieldApi: string;
    changed: string[]; // e.g., ['length','precision','scale','required','defaultValue','formula']
  };

  const newEntries: NewEntry[] = [];
  const changedEntries: ChangedEntry[] = [];

  for (const f of files) {
    const n = f.filename || "";
    const isFieldMeta = n.includes("/objects/") && n.includes("/fields/") && n.endsWith(".field-meta.xml");
    if (!isFieldMeta) continue;

    const parts = n.split("/objects/")[1]?.split("/") || [];
    const objectApi = parts[0] || "";
    const fieldApi = parts[2]?.replace(".field-meta.xml", "") || "";

    const lines = f.hunks.flatMap((h) => h.diff.split("\n"));
    const addedLines = lines.filter((l) => l.trim().startsWith("+")).map((l) => l.replace(/^\+\s?/, ""));
    const removedLines = lines.filter((l) => l.trim().startsWith("-"));

    if (f.status === "added") {
      const xml = addedLines.join("\n");
      const getText = (tag: string): string | undefined => {
        const m = new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`).exec(xml);
        return m && m[1] ? m[1].trim() : undefined;
      };

      let values: string | undefined = undefined;
      for (const line of addedLines) {
        const m1 = new RegExp("<value>\\s*<fullName>([^<]+)</fullName>").exec(line);
        if (m1) values = values ? `${values}, ${m1[1]}` : m1[1];
        const m2 = new RegExp("<valueSetName>([^<]+)</valueSetName>").exec(line);
        if (m2) values = `GVS:${m2[1]}`;
      }

      newEntries.push({
        objectApi,
        fieldApi,
        label: getText("label"),
        type: getText("type"),
        required: getText("required"),
        def: getText("defaultValue"),
        values,
      });
    } else if (f.status === "modified") {
      const tagsToTrack = [
        "length",
        "precision",
        "scale",
        "required",
        "defaultValue",
        "formula",
        "type",
      ];
      const changed = new Set<string>();
      for (const tag of tagsToTrack) {
        const open = `<${tag}>`;
        if (addedLines.some((l) => l.includes(open)) || removedLines.some((l) => l.includes(open))) {
          changed.add(tag);
        }
      }
      if (changed.size > 0) {
        changedEntries.push({ objectApi, fieldApi, changed: Array.from(changed.values()) });
      }
    }
  }

  if (newEntries.length === 0 && changedEntries.length === 0) return undefined;

  const linesOut: string[] = [];
  linesOut.push("## Salesforce Metadata Change Documentation");

  if (newEntries.length) {
    linesOut.push("### New Custom Fields");
    linesOut.push("| Object | Field | Label | Type | Required | Default | Values |");
    linesOut.push("|---|---|---|---|:---:|---|---|");
    for (const e of newEntries) {
      linesOut.push(
        `| ${e.objectApi} | ${e.fieldApi} | ${e.label ?? ""} | ${e.type ?? "n/a"} | ${e.required ?? "n/a"} | ${e.def ?? "n/a"} | ${e.values ?? "n/a"} |`
      );
    }
    linesOut.push("");
  }

  if (changedEntries.length) {
    linesOut.push("### Changed Custom Fields");

    linesOut.push("| Object | Field | Attributes Changed |");
    linesOut.push("|---|---|---|");
    for (const e of changedEntries) {
      linesOut.push(`| ${e.objectApi} | ${e.fieldApi} | ${e.changed.sort().join(", ")} |`);
    }
    linesOut.push("");
  }

  return linesOut.join("\n");
}

// Filter files by review scope
function filterFilesByScope(files: FileDiff[], scope: string): FileDiff[] {
  const s = (scope || '').toLowerCase();
  return files.filter((f) => {
    const n = (f.filename || '').toLowerCase();
    const isFlow = n.includes('/flows/') && n.endsWith('.flow-meta.xml');
    const isDataModel = (
      n.includes('/objects/') && (n.endsWith('.object-meta.xml') || n.includes('/fields/'))
    ) || n.includes('/globalvaluesets/');

    if (s === 'flows') return isFlow;
    if (s === 'data-model') return isDataModel;
    if (s === 'apex') return !isFlow && !isDataModel;
    // default: return all
    return true;
  });
}

// Build a compact Flow Documentation section
function buildFlowsDoc(files: FileDiff[]): string | undefined {
  type FlowEntry = {
    apiName: string;
    type?: string;
    trigger?: string;
    entry?: string;
    hasFault?: boolean;
    dmlInLoops?: string; // yes/no/maybe
  };
  const entries: FlowEntry[] = [];

  for (const f of files) {
    const n = f.filename || '';
    const isFlow = n.includes('/flows/') && n.endsWith('.flow-meta.xml');
    if (!isFlow) continue;

    const parts = n.split('/flows/')[1]?.split('/') || [];
    const apiName = parts[0]?.replace('.flow-meta.xml', '') || parts[0] || n;

    const lines = f.hunks.flatMap((h) => h.diff.split('\n'));
    const added = lines.filter((l) => l.trim().startsWith('+')).map((l) => l.replace(/^\+\s?/, ''));
    const xml = added.join('\n');

    const getText = (tag: string): string | undefined => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
      return m && m[1] ? m[1].trim() : undefined;
    };

    const entry: FlowEntry = { apiName };
    entry.type = getText('processType') || getText('flowType') || undefined;

    // Trigger heuristics (record-triggered flows often expose object + trigger type)
    const recordTriggerType = getText('recordTriggerType') || getText('triggerType');
    const triggerObject = getText('object') || getText('sObject') || undefined;
    if (recordTriggerType || triggerObject) {
      entry.trigger = [recordTriggerType, triggerObject].filter(Boolean).join(' on ');
    }



    // Entry conditions summary (best-effort)
    const condLogic = getText('conditionLogic') || getText('triggerConditions') || undefined;
    if (condLogic) entry.entry = condLogic;

    // Fault connectors present
    entry.hasFault = added.some((l) => l.includes('<faultConnector'));

    // DML inside loops risk heuristic
    const hasLoop = added.some((l) => /<loop\b/.test(l));
    const hasDml = added.some((l) => /(createRecords|updateRecords|deleteRecords)/.test(l));
    entry.dmlInLoops = hasLoop && hasDml ? 'yes' : hasDml ? 'maybe' : 'no';

    entries.push(entry);
  }

  if (!entries.length) return undefined;
  const out: string[] = [];
  out.push('## Salesforce Metadata Change Documentation');
  out.push('### Flow Documentation');
  out.push('| Flow API Name | Type | Trigger | Entry conditions | Fault connectors | DML-in-loops |');
  out.push('|---|---|---|---|:---:|:---:|');
  for (const e of entries) {
    out.push(
      `| ${e.apiName} | ${e.type ?? 'n/a'} | ${e.trigger ?? 'n/a'} | ${e.entry ?? '—'} | ${e.hasFault ? 'yes' : 'no'} | ${e.dmlInLoops ?? 'no'} |`
    );
  }
  out.push('');
  return out.join('\n');
}




// Build a compact Apex Documentation section (classes + triggers)
function buildApexDoc(files: FileDiff[]): string | undefined {
  type ClassEntry = {
    name: string;
    sharing: string;
    implements: string;
    testsInPr: string;
    stripInaccessible: string;
    dmlInLoops: string; // yes/no/maybe
    hardCodedIds: string; // yes/no
  };
  type TriggerEntry = {
    name: string;
    object?: string;
    events?: string;
    testsInPr: string;
    stripInaccessible: string;
    dmlInLoops: string; // yes/no/maybe
    hardCodedIds: string; // yes/no
  };

  const classes: ClassEntry[] = [];
  const triggers: TriggerEntry[] = [];

  const changedFiles = files || [];

  const fileHasTestFor = (baseName: string): boolean => {
    const expected = `${baseName}Test.cls`.toLowerCase();
    return changedFiles.some((f) => (f.filename || '').toLowerCase().includes('/classes/') && (f.filename || '').toLowerCase().endsWith(expected));
  };

  for (const f of changedFiles) {
    const n = (f.filename || '').toLowerCase();
    const isClass = n.includes('/classes/') && n.endsWith('.cls');
    const isTrigger = n.includes('/triggers/') && n.endsWith('.trigger');
    if (!isClass && !isTrigger) continue;

    const baseName = (() => {
      const parts = (f.filename || '').split('/');
      const fn = parts[parts.length - 1] || '';
      return fn.replace(/\.(cls|trigger)$/i, '').replace(/\.cls-meta\.xml$/i, '');
    })();

    const lines = f.hunks.flatMap((h) => h.diff.split('\n'));
    const added = lines
      .filter((l) => l.trim().startsWith('+'))
      .map((l) => l.replace(/^\+\s?/, ''));
    const content = added.join('\n');
    const contentLower = content.toLowerCase();

    const hasFor = /\bfor\s*\(/.test(contentLower);
    const hasDml = /\b(insert|update|upsert|delete|undelete)\b|\bdatabase\.[a-z]+\b/.test(contentLower);
    const hasSoql = /\[\s*select\b/.test(contentLower);
    const dmlInLoops = hasFor && (hasDml || hasSoql) ? 'maybe' : 'no';

    const stripInacc = content.includes('Security.stripInaccessible') ? 'yes' : 'no';
    const hardId = /['"][0]{2}[0-9a-zA-Z]{15,17}['"]/.test(content) ? 'yes' : 'no';

    if (isClass) {
      // Extract sharing and implements from class declaration lines
      const classDeclLine = added.find((l) => /\bclass\b/.test(l)) || '';
      const sharing = /with\s+sharing/i.test(classDeclLine)
        ? 'with sharing'
        : /without\s+sharing/i.test(classDeclLine)
        ? 'without sharing'
        : 'unspecified';

      // Implements detection (Batchable/Queueable/Schedulable common)
      let impl = '';
      const implMatch = classDeclLine.match(/implements\s+([^\{]+)/i);
      if (implMatch) {
        impl = implMatch[1].trim().replace(/\s+/g, ' ');
      } else {
        const flags: string[] = [];
        if (/Database\.Batchable/i.test(content)) flags.push('Database.Batchable');
        if (/Queueable/i.test(content)) flags.push('Queueable');
        if (/Schedulable/i.test(content)) flags.push('Schedulable');
        impl = flags.join(', ');
      }

      classes.push({
        name: baseName,
        sharing,
        implements: impl || '-',
        testsInPr: fileHasTestFor(baseName) ? 'yes' : 'no',
        stripInaccessible: stripInacc,
        dmlInLoops,
        hardCodedIds: hardId,
      });
    } else if (isTrigger) {
      // Parse trigger header
      const headerLine = added.find((l) => /\btrigger\b/i.test(l)) || '';
      const m = headerLine.match(/trigger\s+([A-Za-z0-9_]+)\s+on\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/i);
      const obj = m ? m[2] : undefined;
      const ev = m ? (m[3] || '').replace(/\s+/g, ' ').trim() : undefined;

      triggers.push({
        name: baseName,
        object: obj,
        events: ev,
        testsInPr: fileHasTestFor(baseName) ? 'yes' : 'no',
        stripInaccessible: stripInacc,
        dmlInLoops,
        hardCodedIds: hardId,
      });
    }
  }

  if (!classes.length && !triggers.length) return undefined;

  const out: string[] = [];
  out.push('### Apex Documentation');

  if (classes.length) {
    out.push('| Class | Sharing | Implements | Tests in PR | stripInaccessible | DML/SOQL-in-loops | Hard-coded IDs |');
    out.push('|---|---|---|:---:|:---:|:---:|:---:|');
    for (const c of classes.sort((a,b)=>a.name.localeCompare(b.name))) {
      out.push(`| ${c.name} | ${c.sharing} | ${c.implements || '-'} | ${c.testsInPr} | ${c.stripInaccessible} | ${c.dmlInLoops} | ${c.hardCodedIds} |`);
    }
    out.push('');
  }

  if (triggers.length) {
    out.push('| Trigger | Object | Events | Tests in PR | stripInaccessible | DML/SOQL-in-loops | Hard-coded IDs |');
    out.push('|---|---|---|:---:|:---:|:---:|:---:|');
    for (const t of triggers.sort((a,b)=>a.name.localeCompare(b.name))) {
      out.push(`| ${t.name} | ${t.object || '-'} | ${t.events || '-'} | ${t.testsInPr} | ${t.stripInaccessible} | ${t.dmlInLoops} | ${t.hardCodedIds} |`);
    }
    out.push('');
  }

  return out.join('\n');
}
