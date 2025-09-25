import { getInput, getMultilineInput } from "@actions/core";
import { AIProviderType } from "./ai";

export class Config {
  public llmApiKey: string | undefined;
  public llmModel: string | undefined;
  public llmProvider: string;
  public githubToken: string | undefined;
  public styleGuideRules: string | undefined;
  public githubApiUrl: string;
  public githubServerUrl: string;
  public salesforceMode: string | undefined;
  public reviewScopes: string[] | undefined; // e.g., ['data-model','flows','apex']
  public allowTitleUpdate: boolean = false; // gate PR title updates; default off
  public maxComments: number; // cap per run for inline comments
  public maxCodeblockLines: number; // cap lines inside fenced code blocks in comments
  public maxReviewChars: number; // cap total characters of diffs per LLM call

  public sapAiCoreClientId: string | undefined;
  public sapAiCoreClientSecret: string | undefined;
  public sapAiCoreTokenUrl: string | undefined;
  public sapAiCoreBaseUrl: string | undefined;
  public sapAiResourceGroup: string | undefined;

  constructor() {
    this.githubToken = process.env.GITHUB_TOKEN;
    if (!this.githubToken) {
      throw new Error("GITHUB_TOKEN is not set");
    }

    this.llmModel = process.env.LLM_MODEL || getInput("llm_model");
    if (!this.llmModel?.length) {
      throw new Error("LLM_MODEL is not set");
    }

    this.llmProvider = process.env.LLM_PROVIDER || getInput("llm_provider");
    if (!this.llmProvider?.length) {
      this.llmProvider = AIProviderType.AI_SDK;
      console.log(`Using default LLM_PROVIDER '${this.llmProvider}'`);
    }

    this.llmApiKey = process.env.LLM_API_KEY;
    const isSapAiSdk = this.llmProvider === AIProviderType.SAP_AI_SDK;
    // SAP AI SDK does not require an API key
    if (!this.llmApiKey && !isSapAiSdk) {
      throw new Error("LLM_API_KEY is not set");
    }

    // GitHub Enterprise Server support
    this.githubApiUrl =
      process.env.GITHUB_API_URL || getInput('github_api_url') || 'https://api.github.com';
    this.githubServerUrl =
      process.env.GITHUB_SERVER_URL || getInput('github_server_url') || 'https://github.com';

    // Salesforce review mode: 'on' | 'off' | 'auto' (default)
    this.salesforceMode = (
      process.env.SALESFORCE_MODE || getInput('salesforce_mode') || 'auto'
    ).toLowerCase();

    // Review scopes: comma-separated list; default to all three
    const scopesRaw = process.env.REVIEW_SCOPES || getInput('review_scopes') || 'data-model,flows,apex';
    this.reviewScopes = scopesRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => !!s);

    // Gate PR title updates (disabled by default per requirements)
    const allowTitle = process.env.ALLOW_TITLE_UPDATE || getInput('allow_title_update') || 'false';
    this.allowTitleUpdate = String(allowTitle).toLowerCase() === 'true';

    // Reviewer caps (configurable)
    const maxCommentsEnv = process.env.REVIEW_MAX_COMMENTS || getInput('max_comments');
    const parsedMax = maxCommentsEnv && parseInt(maxCommentsEnv, 20);
    this.maxComments = Number.isFinite(parsedMax as any) && (parsedMax as any)! > 0 ? (parsedMax as any) : 40;

    const maxCodeblockLinesEnv = process.env.REVIEW_MAX_CODEBLOCK_LINES || getInput('max_codeblock_lines');
    const parsedMaxCode = maxCodeblockLinesEnv && parseInt(maxCodeblockLinesEnv, 10);
    this.maxCodeblockLines = Number.isFinite(parsedMaxCode as any) && (parsedMaxCode as any)! > 0 ? (parsedMaxCode as any) : 60;

    const maxReviewCharsEnv = process.env.REVIEW_MAX_REVIEW_CHARS || getInput('max_review_chars');
    const parsedMaxReviewChars = maxReviewCharsEnv && parseInt(maxReviewCharsEnv, 10);
    this.maxReviewChars = Number.isFinite(parsedMaxReviewChars as any) && (parsedMaxReviewChars as any)! > 0 ? (parsedMaxReviewChars as any) : 725000;

    // SAP AI Core configuration
    this.sapAiCoreClientId = process.env.SAP_AI_CORE_CLIENT_ID;
    this.sapAiCoreClientSecret = process.env.SAP_AI_CORE_CLIENT_SECRET;
    this.sapAiCoreTokenUrl = process.env.SAP_AI_CORE_TOKEN_URL;
    this.sapAiCoreBaseUrl = process.env.SAP_AI_CORE_BASE_URL;
    this.sapAiResourceGroup = process.env.SAP_AI_RESOURCE_GROUP;
    if (
      isSapAiSdk &&
      (!this.sapAiCoreClientId ||
        !this.sapAiCoreClientSecret ||
        !this.sapAiCoreTokenUrl ||
        !this.sapAiCoreBaseUrl)
    ) {
      throw new Error(
        "SAP AI Core configuration is not set. Please set SAP_AI_CORE_CLIENT_ID, SAP_AI_CORE_CLIENT_SECRET, SAP_AI_CORE_TOKEN_URL, and SAP_AI_CORE_BASE_URL."
      );
    }

    if (!process.env.DEBUG) {
      return;
    }
    console.log("[debug] loading extra inputs from .env");

    this.styleGuideRules = process.env.STYLE_GUIDE_RULES;
  }

  public loadInputs() {
    if (process.env.DEBUG) {
      console.log("[debug] skip loading inputs");
      return;
    }

    // Custom style guide rules
    try {
      const styleGuideRules = getMultilineInput("style_guide_rules") || [];
      if (
        Array.isArray(styleGuideRules) &&
        styleGuideRules.length &&
        styleGuideRules[0].trim().length
      ) {
        this.styleGuideRules = styleGuideRules.join("\n");
      }
    } catch (e) {
      console.error("Error loading style guide rules:", e);
    }
  }
}

// For testing, we'll modify how the config instance is created
// This prevents the automatic loading when the module is imported
let configInstance: Config | null = null;

// If not in test environment, create and configure the instance
if (process.env.NODE_ENV !== "test") {
  configInstance = new Config();
  configInstance.loadInputs();
}

// Export the instance or a function to create one for tests
export default process.env.NODE_ENV === "test"
  ? {
      // Default values for tests
      githubToken: "mock-token",
      llmApiKey: "mock-api-key",
      llmModel: "mock-model",
      llmProvider: "mock-provider",
      styleGuideRules: "",
      sapAiCoreClientId: "mock-client-id",
      sapAiCoreClientSecret: "mock-client-secret",
      sapAiCoreTokenUrl: "mock-token-url",
      sapAiCoreBaseUrl: "mock-base-url",
      sapAiResourceGroup: "default",
      githubApiUrl: "https://api.github.com",
      githubServerUrl: "https://github.com",
      salesforceMode: "off",
      reviewScopes: ["data-model","flows","apex"],
      allowTitleUpdate: false,
      loadInputs: jest.fn(),
    }
  : configInstance!;
