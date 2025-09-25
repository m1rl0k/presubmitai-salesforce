import { context } from "@actions/github";
import { FileDiff } from "./diff";
import { AIComment, PullRequestSummary } from "./prompts";
import { Context } from "@actions/github/lib/context";
import config from "./config";

export const OVERVIEW_MESSAGE_SIGNATURE =
  "\n<!-- presubmit.ai: overview message -->";

export const COMMENT_SIGNATURE = "\n<!-- presubmit.ai: comment -->";
export const DOCUMENTATION_SIGNATURE = "\n<!-- presubmit.ai: documentation -->";

export const PAYLOAD_TAG_OPEN = "\n<!-- presubmit.ai: payload --";
export const PAYLOAD_TAG_CLOSE = "\n-- presubmit.ai: payload -->";

function getCommitUrl(
  serverUrl: string,
  owner: string,
  repo: string,
  sha: string
): string {
  // Remove trailing slash if present
  const baseUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  return `${baseUrl}/${owner}/${repo}/commit/${sha}`;
}

export function buildLoadingMessage(
  baseCommit: string,
  commits: {
    sha: string;
    commit: {
      message: string;
    };
  }[],
  fileDiffs: FileDiff[]
): string {
  const { owner, repo } = context.repo;

  let message = `⏳ **Analyzing changes in this PR...** ⏳\n\n`;
  message += `_This might take a few minutes, please wait_\n\n`;

  // Group files by operation
  message += `<details>\n<summary>📥 Commits</summary>\n\n`;
  message += `Analyzing changes from base (\`${baseCommit.slice(
    0,
    7
  )}\`) to latest commit (\`${commits[commits.length - 1].sha.slice(
    0,
    7
  )}\`):\n`;

  for (const commit of commits.reverse()) {
    message += `- [${commit.sha.slice(0, 7)}](${getCommitUrl(
      config.githubServerUrl,
      owner,
      repo,
      commit.sha
    )}): ${commit.commit.message}\n`;
  }

  message += "\n\n</details>\n\n";

  message += `<details>\n<summary>📁 Files being considered (${fileDiffs.length})</summary>\n\n`;
  for (const diff of fileDiffs) {
    let prefix = "🔄"; // Modified
    if (diff.status === "added") prefix = "➕";
    if (diff.status === "removed") prefix = "➖";
    if (diff.status === "renamed") prefix = "📝";

    let fileText = `${prefix} ${diff.filename}`;
    if (diff.status === "renamed") {
      fileText += ` (from ${diff.previous_filename})`;
    }
    fileText += ` _(${diff.hunks.length} ${
      diff.hunks.length === 1 ? "hunk" : "hunks"
    })_`;
    message += `${fileText}\n`;
  }
  message += "\n</details>\n\n";

  // Removed visible footer line to keep comments clean; retain hidden signature below
  message += OVERVIEW_MESSAGE_SIGNATURE;

  return message;
}

export function buildOverviewMessage(
  summary: PullRequestSummary,
  commits: string[],
  fileDiffs: FileDiff[],
  rationale?: string
): string {
  // Concise but context-aware summary. Add a short Highlights block with key names.
  const desc = (summary.description || "").replace(/\s+/g, " ").trim();
  const shortDesc = desc.length > 500 ? desc.slice(0, 497) + "..." : desc;

  // Counters for quick scope read
  const counters: Record<string, number> = {};
  const inc = (k: string) => (counters[k] = (counters[k] || 0) + 1);

  // Buckets for highlights
  const newFields: string[] = [];
  const changedFields: string[] = [];
  const flowsTouched: string[] = [];
  const apexTouched: string[] = [];
  const permSets: string[] = [];
  const profiles: string[] = [];
  const externalApps: string[] = [];
  const permSetGroups: string[] = [];
  const oauthScopes: string[] = [];

  for (const f of fileDiffs) {
    const n = f.filename;
    const lower = n.toLowerCase();
    if (lower.includes("/classes/") && lower.endsWith(".cls")) {
      inc("Apex");
      const m = n.match(/classes\/([^\/]+)\.cls$/i);
      const name = m?.[1] || n;
      if (!/test$/i.test(name)) apexTouched.push(name);
    } else if (lower.includes("/flows/") && lower.endsWith(".flow-meta.xml")) {
      inc("Flows");
      const m = n.match(/flows\/([^\/]+)\.flow-meta\.xml$/i);
      if (m) flowsTouched.push(m[1]);
    } else if (lower.includes("/objects/") && lower.endsWith(".object-meta.xml")) {
      inc("Objects");
    } else if (lower.includes("/objects/") && lower.includes("/fields/") && lower.endsWith(".field-meta.xml")) {
      inc("Fields");
      const m = n.match(/objects\/([^\/]+)\/fields\/([^\/]+)\.field-meta\.xml$/i);
      if (m) {
        if (f.status === "added") newFields.push(`${m[1]}.${m[2]}`);
        else if (f.status === "modified") changedFields.push(`${m[1]}.${m[2]}`);
      }
    } else if (lower.includes("/layouts/") && lower.endsWith(".layout-meta.xml")) inc("Layouts");
    else if (lower.includes("/flexipages/") && lower.endsWith(".flexipage-meta.xml")) inc("Flexipages");
    else if (lower.includes("/permissionsets/") && lower.endsWith(".permissionset-meta.xml")) {
      inc("PermissionSets");
      const m = n.match(/permissionsets\/([^\/]+)\.permissionset-meta\.xml$/i);
      if (m) permSets.push(m[1]);
    } else if (lower.includes("/profiles/") && lower.endsWith(".profile-meta.xml")) {
      inc("Profiles");
      const m = n.match(/profiles\/([^\/]+)\.profile-meta\.xml$/i);
      if (m) profiles.push(m[1]);
    } else if (lower.includes("/externalclientapps/") && lower.endsWith(".eca-meta.xml")) {
      inc("ExternalClientApps");
      const m = n.match(/externalClientApps\/([^\/]+)\.eca-meta\.xml$/i);
      if (m) externalApps.push(m[1]);
    } else if (lower.includes("/permissionsetgroups/") && lower.endsWith(".permissionsetgroup-meta.xml")) {
      inc("PermissionSetGroups");
      const m = n.match(/permissionsetgroups\/([^\/]+)\.permissionsetgroup-meta\.xml$/i);
      if (m) permSetGroups.push(m[1]);
    } else if (
      (lower.includes("/extlclntappglobaloauthsets/") && lower.endsWith(".ecaglbloauth-meta.xml")) ||
      (lower.includes("/extlclntappoauthsettings/") && lower.endsWith(".ecaoauth-meta.xml")) ||
      (lower.includes("/extlclntappoauthpolicies/") && lower.endsWith(".ecaoauthplcy-meta.xml"))
    ) {
      inc("OAuthScopes");
      const m = n.match(/(?:extlClntAppGlobalOauthSets|extlClntAppOauthSettings|extlClntAppOauthPolicies)\/([^\/]+)\./i);
      if (m) oauthScopes.push(m[1]);
    } else if (lower.includes("/globalvaluesets/") && lower.endsWith(".globalvalueset-meta.xml")) inc("GlobalValueSets");
    else if (lower.includes("/custommetadata/") && lower.endsWith(".md-meta.xml")) inc("CustomMetadata");
    else if (lower.includes("/dashboards/")) inc("Dashboards");
    else if (lower.includes("/lwc/")) inc("LWC");
    else if (lower.includes("/aura/")) inc("Aura");
  }

  const categorySummary = Object.entries(counters)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}(${v})`)
    .join(", ");

  // Helper to render full list without truncation
  const list = (arr: string[]) => {
    if (!arr.length) return "";
    return arr.join(", ");
  };

  let message = `PR Summary: ${shortDesc}\n\n`;
  message += `Scope: ${fileDiffs.length} files changed` + (categorySummary ? `; ${categorySummary}` : "") + `\n\n`;

  // Highlights (only include non-empty bullets; do not truncate items)
  const bullets: string[] = [];
  if (newFields.length) bullets.push(`New custom fields: ${list(newFields)}`);
  if (changedFields.length) bullets.push(`Changed custom fields: ${list(changedFields)}`);
  if (flowsTouched.length) bullets.push(`Flows changed: ${list(flowsTouched)}`);
  if (apexTouched.length) bullets.push(`Apex classes changed: ${list(apexTouched)}`);
  if (permSets.length) bullets.push(`Permission Sets updated: ${list(permSets)}`);
  if (permSetGroups.length) bullets.push(`Permission Set Groups updated: ${list(permSetGroups)}`);
  if (externalApps.length) bullets.push(`External Client Apps: ${list(externalApps)}`);
  if (oauthScopes.length) bullets.push(`OAuth custom scopes/settings: ${list(oauthScopes)}`);
  if (profiles.length) bullets.push(`Profiles updated: ${list(profiles)}`);

  if (bullets.length) {
    message += `Highlights:\n- ` + bullets.join(`\n- `) + `\n\n`;
  }

  // Optional combined rationale/release-notes block
  if (rationale && rationale.trim().length > 0) {
    let r = rationale.trim();
    // Strip any leading duplicate heading the model may include
    r = r.replace(/^\s*(summary\/rationale|rationale)\s*:\s*/i, "");
    r = r.replace(/^\s*(summary\/rationale|rationale)\s*:?[\r\n]+/i, "");
    message += `Rationale:\n\n${r}\n\n`;
  }

  const payload = { commits: commits };
  // Removed visible footer line; keep hidden signature and payload for upsert/machine parsing
  message += OVERVIEW_MESSAGE_SIGNATURE;
  message += PAYLOAD_TAG_OPEN;
  message += JSON.stringify(payload);
  message += PAYLOAD_TAG_CLOSE;

  return message;
}

export function buildReviewSummary(
  context: Context,
  files: FileDiff[],
  commits: {
    sha: string;
    commit: {
      message: string;
    };
  }[],
  actionableComments: AIComment[],
  skippedComments: AIComment[],
  documentation?: string
) {
  // Minimal review body: prefer documentation block; otherwise note inline comments.
  {
    const doc = documentation && documentation.trim().length > 0 ? documentation.trim() + "\n\n" : "Inline review comments have been posted.\n\n";
    return doc;
  }

  const { owner, repo } = context.repo;

  let body = "";
  if (actionableComments.length === 0) {
    body += `✅ **LGTM!**\n\n`;
  } else {
    body += `🚨 **Pull request needs attention.**\n\n`;
  }


  // Commits section

  for (const commit of commits) {
    body += `- [${commit.sha.slice(0, 7)}](${getCommitUrl(
      config.githubServerUrl,
      owner,
      repo,
      commit.sha
    )}): ${commit.commit.message}\n`;
  }
  body += "\n</details>\n\n";

  // Files section
  body += `<details>\n<summary>Files Processed (${files.length})</summary>\n\n`;
  for (const diff of files) {
    let fileText = `- ${diff.filename}`;
    if (diff.status === "renamed") {
      fileText += ` (from ${diff.previous_filename})`;
    }
    fileText += ` _(${diff.hunks.length} ${
      diff.hunks.length === 1 ? "hunk" : "hunks"
    })_`;
    body += `${fileText}\n`;
  }
  body += "\n</details>\n\n";

  // Actionable comments section
  body += `<details>\n<summary>Actionable Comments (${actionableComments.length})</summary>\n\n`;
  for (const comment of actionableComments) {
    body += `- <details>\n`;
    body += `  <summary>${comment.file} [${comment.start_line}-${comment.end_line}]</summary>\n\n`;
    body += `  > ${comment.label}: "${comment.header}"\n`;
    body += `  </details>\n`;
  }
  body += "\n</details>\n\n";

  // Skipped comments section
  body += `<details>\n<summary>Skipped Comments (${skippedComments.length})</summary>\n\n`;
  for (const comment of skippedComments) {
    body += `- <details>\n`;
    body += `  <summary>${comment.file} [${comment.start_line}-${comment.end_line}]</summary>\n\n`;
    body += `  > ${comment.label}: "${comment.header}"\n`;
    body += `  </details>\n`;
  }
  body += "</details>\n\n";

  if (documentation && documentation.trim().length > 0) {
    body += `### Documentation\n\n`;
    body += `${documentation.trim()}\n\n`;
  }

  return body;
}
