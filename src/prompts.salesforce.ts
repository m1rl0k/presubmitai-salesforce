import { runPrompt } from "./ai";
import { z } from "zod";
import { FileDiff, generateFileCodeDiff } from "./diff";
import config from "./config";
import type { PullRequestReview } from "./prompts";

export type PullRequestReviewPrompt = {
  prTitle: string;
  prDescription: string;
  prSummary: string;
  files: FileDiff[];
};

// Reuse the same output shape as standard review
export type { PullRequestReview };

function isMetadataFileName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    (n.includes('/objects/') && n.endsWith('.object-meta.xml')) ||
    (n.includes('/objects/') && n.includes('/fields/') && n.endsWith('.field-meta.xml')) ||
    (n.includes('/flows/') && n.endsWith('.flow-meta.xml')) ||
    (n.includes('/validationrules/') && n.endsWith('.validationrule-meta.xml')) ||
    (n.includes('/duplicaterules/') && n.endsWith('.duplicaterule-meta.xml')) ||
    /(profile|permissionset).*\.xml$/.test(n) ||
    (n.includes('/globalvaluesets/') && n.endsWith('.globalvalueset-meta.xml'))
  );
}

function isFlowFileName(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes('/flows/') && n.endsWith('.flow-meta.xml');
}

function isFieldOrObjectFileName(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return (
    (n.includes('/objects/') && (n.endsWith('.object-meta.xml') || n.includes('/fields/')))
  ) || (n.includes('/globalvaluesets/') && n.endsWith('.globalvalueset-meta.xml'));
}

export async function runReviewPrompt({
  prTitle,
  prDescription,
  prSummary,
  files,
}: PullRequestReviewPrompt): Promise<PullRequestReview> {
  // Salesforce-focused system prompt additions
  const hasMetadata = files.some((f) => isMetadataFileName(f.filename));
  const hasFlows = files.some((f) => isFlowFileName(f.filename));
  const hasFieldsOrObjects = files.some((f) => isFieldOrObjectFileName(f.filename));
  let systemPrompt = `
<IMPORTANT INSTRUCTIONS>
You are a senior Salesforce developer reviewing a GitHub Pull Request (PR) for Salesforce code and configuration. Provide only high-value, actionable comments that improve correctness, security, performance, and compliance with Salesforce best practices. Do not comment on cosmetic formatting unless it causes functional issues.

Focus areas by artifact type:
- Apex (classes/triggers):
  - Enforce bulkification: no SOQL/DML inside loops; use collections and aggregate operations
  - Respect governor limits; avoid unnecessary queries; cache results where possible
  - Enforce CRUD/FLS (e.g., Security.stripInaccessible) before DML and sensitive reads
  - Prefer "with sharing" unless there is a justified reason; call out data exposure risks
  - Avoid hard-coded IDs, org-specific settings, and secrets
  - Proper exception handling; do not swallow exceptions silently
- SOQL/SOSL:
  - Use bind variables; never concatenate user input into queries (avoid injection)
  - Ensure selective filters for large data; avoid full-table scans where possible
- LWC/Aura:
  - Avoid unsafe DOM manipulation and unsanitized HTML; follow Locker/security constraints
  - Use @wire/adapters appropriately; avoid excessive server round-trips
- Metadata (profiles/permission sets/layouts):
  - Sanity-check permission changes; avoid destructive changes without rationale
  - Ensure dependency order and deployment compatibility`;

  if (hasMetadata) {
    systemPrompt += `

<SALESFORCE METADATA REVIEW RULES>
# Salesforce Metadata Review Rules (DX)

${hasFieldsOrObjects ? `
1) Custom Objects — avoid over-customization
- Prefer standard objects; new custom objects require justification (data model/lifecycle can't be modeled with standard).
- Require a note on expected volumes (12/36mo), OWD/sharing, reporting needs, and archival/retention.
- Flag generic names (e.g., “Data__c”, “Record__c”); prefer clear, singular labels and PascalCase API names.

2) Custom Fields — prevent duplicates & enforce governance
- Duplicate check: When a new field is added to an object, compare its Label/API/Help Text to existing fields on the same object; if similar, ask why an existing field won't work and suggest consolidation.
- Prefer Global Value Sets over free-text or ad-hoc picklists when values are shared or standardized.
- Set Data Classification on every new field (Data Owner, Field Usage, Data Sensitivity Level, Compliance Categorization). Call out when missing and request values.
- No hard-coded IDs or org-specific literals in Default Values or formulas; use Custom Metadata Types / Custom Labels instead.
- Validation: if a field is required for integrations, prefer a Validation Rule (with user-friendly message) over “Required on layout” only.
` : ''}

${hasFlows ? `
3) Flows — reliability, scale, and orchestration
- Use before-save record-triggered flows for simple updates; after-save for side effects.
- Must include fault paths on DML/Get elements; flag flows with no fault connectors.
- Bulk safety: disallow Get/Update inside loops; gather collections first; avoid nested loops; author must state they tested with ~200 records.
- Entry conditions should be selective; if multiple record-triggered flows exist on the same object/context, request orchestration (entry order or consolidation).
` : ''}

4) Duplicate Management & Validation
- Duplicate Rules should reference an approved Matching Rule and specify create/edit behavior; flag if missing.
- Validation Rule messages must be actionable (what to fix/how).

5) Security & Access
- Enforce least-privilege changes: adding fields must not silently expand CRUD/FLS in profiles/PSGs without justification.
- If Data Sensitivity indicates PII/regulated data, request encryption/classification confirmation and retention notes.

6) UX (Layouts/Record Types/Lightning Pages)
- Record Types only when distinct process/values require it; not just for page layout differences.
- Keep admin/technical fields off business profiles’ default layouts.

7) Documentation hygiene
- For derived fields, include a brief formula comment in the Description.

8) Auto-flag patterns (quick comments)
- New object with <5 fields and no relationships → likely premature.
- New text field mirrors an existing picklist (or GVS) → suggest reusing/aligning values.
${hasFlows ? `- Flow with hard-coded IDs/names, or missing fault connectors, or loop-SOQL → request fix.` : ''}

</SALESFORCE METADATA REVIEW RULES>`;
  }

  systemPrompt += `

Only comment on code introduced in this PR (lines starting with '+'). If no actionable issues are found, return an empty comments array.

When suggesting changes, provide minimal, targeted code with fenced code blocks and language hints (e.g., Apex code fences) and keep snippets <= 15 lines.
  `;

  if (hasFlows || hasFieldsOrObjects) {
    systemPrompt += `

In addition to review comments, you MUST produce a "Salesforce Metadata Change Documentation" markdown block that enumerates all NEW Salesforce metadata introduced in this PR (based on the file diffs). Focus on NEW Custom Fields with full details; other categories may be listed briefly. Do not include Test/QA instructions, deployment notes, or rollback plans here:
- Custom Objects: API Name, Label, (if present) Description, notable settings (e.g., deployment status, sharing model)
- Custom Fields: Parent Object, API Name, Label, Data Type, Required (true/false), Default Value (if present), Picklist values or Global Value Set reference (if applicable), Formula summary (if formula field), Data Classification (if present)
- Flows: API Name and Type (brief)
- Validation Rules: Name and message (brief)
- Duplicate Rules: Name and matching rule (brief)
- Profiles: Names and CRUD/FLS changes relevant to new fields/objects (brief)
- Permission Sets: Names and CRUD/FLS grants relevant to new fields/objects (brief)
- Global Value Sets: Name and values (brief)

Format the documentation as a concise, paste-ready markdown section with headings:
## Salesforce Metadata Change Documentation
### New Custom Objects
- <Object API Name>: Label="..."; Description="..."; Sharing="..."; Notes: ...
### New Custom Fields
- <Object>.<Field API Name>: Label="..."; Type=...; Required=...; Default=...; Values=...; Classification=...; Notes: ...
### New Flows
- <Flow API Name>: Type=...; Object/Context=...; Entry=...; FaultPaths=Yes/No; Notes: ...
### New Validation Rules
- <Object>.<Rule Name>: Message="..."; Fields=...; Notes: ...
### New Duplicate Rules
- <Object>.<Rule Name>: MatchingRule=...; Create/Edit=Alert|Block; Notes: ...
### New Profiles
- <Profile Name>: CRUD/FLS changes relevant to new metadata (summary)
### New Permission Sets
- <Permission Set Name>: CRUD/FLS grants relevant to new metadata (summary)
### New Global Value Sets
- <GVS Name>: Values=[...]
    `;
  }

  systemPrompt += `

${config.styleGuideRules && config.styleGuideRules.length > 0 ? `\nGuidelines to enforce (critical violations should be marked critical):\n${config.styleGuideRules}` : ""}
</IMPORTANT INSTRUCTIONS>`;

  const userPrompt = `
<PR title>
${prTitle}
</PR title>

<PR Description>
${prDescription}
</PR Description>

<PR Summary>
${prSummary}
</PR Summary>

<PR File Diffs>
${files.map((file) => generateFileCodeDiff(file)).join("\n\n")}
</PR File Diffs>
`;

  const commentSchema = z.object({
    file: z.string().describe("The full file path of the relevant file"),
    start_line: z
      .number()
      .describe(
        "Relevant line number (inclusive) from a '__new hunk__' section where comment starts"
      ),
    end_line: z
      .number()
      .describe(
        "Relevant line number (inclusive) from a '__new hunk__' section where comment ends"
      ),
    content: z
      .string()
      .describe(
        "Actionable comment to enhance/fix the new code introduced in the PR. Use markdown. When proposing code, include fenced code blocks with language (e.g., ```apex) and keep snippets under 15 lines."
      ),
    header: z
      .string()
      .describe(
        "Concise, single-sentence overview of the comment. Focus on the 'what'."
      ),
    highlighted_code: z
      .string()
      .describe(
        "Short code snippet from a '__new hunk__' the comment refers to, without line numbers."
      ),
    label: z
      .string()
      .describe(
        "Single, descriptive label: 'security', 'possible bug', 'bug', 'performance', 'enhancement', etc."
      ),
    critical: z
      .boolean()
      .describe(
        "True if the PR should not be merged without addressing the comment; false otherwise."
      ),
  });

  const reviewSchema = z.object({
    estimated_effort_to_review: z
      .number()
      .min(1)
      .max(5)
      .describe(
        "Estimated effort (1-5) required to review this PR by an experienced developer."
      ),
    score: z
      .number()
      .min(0)
      .max(100)
      .describe(
        "PR quality score (0-100), where 100 means production-grade with no issues."
      ),
    has_relevant_tests: z
      .boolean()
      .describe(
        "True if PR includes relevant tests added/updated; false otherwise."
      ),
    security_concerns: z
      .string()
      .describe(
        "Summarize any potential security or compliance issues, or 'No' if none."
      ),
  });

  const schema = z.object({
    review: reviewSchema.describe("The full review of the PR"),
    documentation: z
      .string()
      .describe(
        "Concise PR documentation in markdown that the author can paste into the PR description or release notes. Include only: Summary/Rationale, Release Notes Entry, and Suggested component descriptions (if missing). Do NOT include Test/QA instructions, Deployment Notes, or Rollback Plan."
      ),
    comments: z
      .array(commentSchema)
      .describe("Actionable comments on issues introduced by this PR"),
  });

  return (await runPrompt({
    prompt: userPrompt,
    systemPrompt,
    schema,
  })) as PullRequestReview;
}

