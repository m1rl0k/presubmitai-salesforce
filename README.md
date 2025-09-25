<div align="center">
  <h1>
   SalesforceAI Code Reviewer - Based on Presubmit.ai
  </h1>

  <p><em>Context-aware, intelligent and instant PR reviews</em></p>

</div>

<br/>

Optimize your code review process with Presubmit's AI Code Reviewer that catches bugs, suggests improvements, and provides meaningful summary - all before human reviewers take their first look.

- 🔍 **Instant, In-depth PR Analysis**: Catches bugs, security issues, and optimization opportunities in real-time
- 🎯 **Focus on What Matters**: Let AI handle the basics while humans focus on architecture and complex logic
- ✨ **Title and description generation**: Save time by having the AI generate meaningful title and description for your PR
- 💬 **Interactive & Smart**: Responds to questions and generates code suggestions right in your PR
- ⚡ **Lightning-Fast Setup**: Up and running in 2 minutes with GitHub Actions

<br/>

> 🤝 **Note**: Presubmit is designed to complement human reviewers, not replace them. It helps catch security issues and bugs early on while also providing context about the overall change, making the human review process more efficient.

<br/>

## See it in Action

> 💡 [View full example PR review](https://github.com/presubmit/ebank-backend/pull/13)

Automated analysis detects potential issues and provides actionable insights:

<div align="left">
  <a href="https://github.com/presubmit/ebank-backend/pull/13">
    <img src="https://github.com/presubmit/ai-reviewer/blob/main/assets/review_example_3.png?raw=true" alt="AI Code Review example" width="650"/>
  </a>
</div>

<br/>

Interactive discussions help clarify implementation details:

<div align="left">
  <a href="https://github.com/presubmit/ebank-backend/pull/13">
    <img src="https://github.com/presubmit/ai-reviewer/blob/main/assets/comment_example.png?raw=true" alt="AI comment thread example" width="650"/>
  </a>
</div>

<br/>

## Usage

### Step 1: Add LLM_API_KEY secret

1. Go to your repository's Settings > Secrets and Variables > Actions
2. Click "New repository secret"
3. Add a new secret with:
   - Name: `LLM_API_KEY`
   - Value: Your API key from one of these providers:
     - [Anthropic Console](https://console.anthropic.com/) (Claude)
     - [OpenAI API](https://platform.openai.com/api-keys) (GPT-4)
     - [Google AI Studio](https://aistudio.google.com/app/apikeys) (Gemini)

### Step 2: Create GitHub Workflow

Add this GitHub Action to your repository by creating `.github/workflows/presubmit.yml`:

```yaml
name: doj-ai-reviewer

permissions:
  contents: read
  pull-requests: write
  issues: write

on:
  pull_request_target:
    types: [opened, synchronize]
  pull_request_review_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Check required secrets
        run: |
          if [ -z "${{ secrets.LLM_API_KEY }}" ]; then
            echo "Error: LLM_API_KEY secret is not configured"
            exit 1
          fi
      - uses: ./doj-ai-reviewer@latest
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          LLM_MODEL: "claude-3-5-sonnet-20241022"
```

The action requires:

- `GITHUB_TOKEN`: Automatically provided by GitHub Actions
- `LLM_API_KEY`: Your API key (added in step 1)
- `LLM_MODEL`: Which LLM model to use. Make sure the model is [supported](https://github.com/presubmit/ai-reviewer/blob/main/src/ai.ts) and matches the `LLM_API_KEY`.

### GitHub Enterprise Server Support

If you're using GitHub Enterprise Server, you can configure the action to work with your instance by adding these environment variables:

```yaml
      - uses: ./doj-ai-reviewer@latest
        env:
          GITHUB_API_URL: "https://github.example.com/api/v3"
          GITHUB_SERVER_URL: "https://github.example.com"
```

You can also configure these settings using input parameters:

```yaml
      - uses: ./doj-ai-reviewer@latest
        with:
          github_api_url: "https://github.example.com/api/v3"
          github_server_url: "https://github.example.com"
```

Make sure to replace `https://github.example.com` with your actual GitHub Enterprise Server URL.

<br/>

## Local CLI (dry-run) runner

Run the reviewer locally against real PRs using your GitHub auth.

Prerequisites:
- Node.js 18+
- GitHub CLI authenticated: `gh auth login`
- `.env` at repo root with at least:
  - `LLM_API_KEY=...`
  - `LLM_MODEL=gpt-5-mini` (or your preferred supported model)
  - Optional: `LLM_PROVIDER=ai-sdk`

Build once:
- `npm run build`

Commands:
- List PRs: `npm run review -- --list-prs --state open --limit 5`
- Review a PR (dry-run): `npm run review -- --pr 36 --dry-run`
- Force full re-review: add `--full`
- Save output to a file: add `--out` or `-out` (optional path). Example:
  - `npm run review -- --pr 36 --dry-run --full -out` → saves to `dry/pr-36.txt`
  - `npm run review -- --pr 36 --dry-run --full --out dry/custom.txt`

Notes:
- Uses your `gh auth token`; no GitHub writes occur in `--dry-run`.
- Defaults to repository `goodyear/sf-main-doj-review`.
- Event-file mode is not yet implemented in the CLI.



## Salesforce mode

When Salesforce DX/metadata is detected (e.g., `force-app/main/default`, files like `*.profile-meta.xml`, `*.permissionset-meta.xml`, `layouts/*.layout-meta.xml`, `externalClientApps/*.eca-meta.xml`, etc.), the reviewer switches to Salesforce-aware analysis with:

- Overview tailored to metadata types:
  - Highlights per component group (Permission Sets, Profiles, Layouts, Validation Rules, External Client Apps, Permission Set Groups, OAuth Custom Scopes)
  - Rationale and Release Notes entries that reference Salesforce features
- Documentation enhancements:
  - Adds a dedicated “Changed Custom Fields” section when fields are added/modified (label, type, required/defaults, help text where available)
  - Summarizes metadata deltas for admin visibility
- Security/FLS checks:
  - Detects org-scoped IDs and non-portable metadata (e.g., `orgScopedExternalApp`)
  - Flags risky permissions (e.g., viewAll/modifyAll, payment-related permissions, broad API capabilities)
  - Calls out Field-Level Security gaps and license dependencies
- Inline suggestions with XML snippets for safer, portable metadata (e.g., remove org-scoped elements, narrow permissions)
- Incremental vs full review:
  - Defaults to incremental when possible; use `--full` to force a clean re-review

Works in CI and locally (with `--dry-run` and optional `--out` for saving results).

### Enable Salesforce mode in GitHub Actions

Add one of the following to your workflow step that uses the action:

- Via environment variable:


````yaml
- uses: ./doj-ai-reviewer@latest
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
    LLM_MODEL: "claude-3-5-sonnet-20241022"
    SALESFORCE_MODE: "on"
````


- Via input parameter:


````yaml
- uses: ./doj-ai-reviewer@latest
  with:
    salesforce_mode: "on"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
    LLM_MODEL: "claude-3-5-sonnet-20241022"
````


Notes:
- Values: "on" | "off" | "auto" (default). "on" forces Salesforce-specific review.
- You can also set SALESFORCE_MODE in local runs via `.env`.


## Features

### 🤖 Smart Reviews

- **In-depth Analysis**: Line-by-line review with context-aware suggestions
- **Auto PR Summary**: Concise, meaningful summaries of changes
- **Code Quality**: Catches bugs, anti-patterns, and style issues
- **Interactive**: Responds to questions and clarifications in comments

### 🛡️ Security & Quality

- **Vulnerability Detection**: Catches security issues and leaked
  secrets
- **Best Practices**: Enforces coding standards and security
  guidelines
- **Performance**: Identifies potential bottlenecks and optimizations
- **Documentation**: Ensures proper code documentation and clarity

### ⚙️ Configurable

- Mention `@presubmit` in PR title for auto-generation
- Disable reviews with `@presubmit ignore` comment
- Configurable review depth and focus areas
- Customizable rules and preferences

### ⚡ Seamless Integration

- 2-minute setup with GitHub Actions
- Works with all major LLM providers (Claude, GPT-4, Gemini)
- Instant feedback on every PR
- Zero maintenance required



## Review Scoping (Salesforce)

To keep reviews fast and precise on large Salesforce PRs, the reviewer runs multiple scoped passes and then merges results into a single overview and a single documentation comment.

Scopes:
- Data Model: Custom Objects/Fields/GlobalValueSets (objects/*, fields/*, globalValueSets/*)
- Flows: Flow metadata (flows/*.flow-meta.xml)
- Apex (catch-all): Apex classes/triggers and the rest of Salesforce metadata (layouts, profiles, permission sets, etc.)

How files are routed:
- Each pass filters PR files by path/type.
- If a scope has no matching files in the PR, it is skipped automatically.
- Files are batched by size to fit LLM context, and each scope may run in 1+ batches.

Prompt selection:
- SALESFORCE_MODE: on | off | auto (default)
  - on: Always uses the Salesforce-aware prompt
  - off: Uses the general code-review prompt
  - auto (default): Uses Salesforce-aware prompts when Salesforce metadata is detected
- Apex scope: even in auto, if the batch includes Salesforce metadata, the Salesforce-aware prompt is used.

Deterministic documentation (no LLM):
- Data Model → “New Custom Fields” and “Changed Custom Fields” tables
- Flows → “Flow Documentation” table (type, trigger, entry conditions, fault connectors, DML-in-loops)
- Apex → “Apex Documentation” table (classes/triggers: sharing, implements, tests in PR, stripInaccessible, DML/SOQL-in-loops, hard-coded IDs)
- Only sections relevant to files in the PR are included.

CLI tips:
- Force a clean re-review: add --full
- Dry-run (no GitHub writes): add --dry-run
- Save output to a file: add --out or -out

Examples:
- Review a PR locally (dry-run):
  - npm run review -- --pr 31 --dry-run --full -out
- Enable Salesforce mode in CI:
  - env: SALESFORCE_MODE=on

Notes:
- Scoping ensures flow/field rules don’t interfere with Apex, while the Apex pass still covers Salesforce metadata outside flows/fields.
- The consolidated documentation comment is deterministic and merges the sections from applicable scopes.
