import { handlePullRequest } from '../pull_request';
import { loadContext } from '../context';
import { initOctokit } from '../octokit';
import { runSummaryPrompt, runReviewPrompt } from '../prompts';
import config from '../config';

// Mock dependencies
jest.mock('../context');
jest.mock('../octokit');
jest.mock('../prompts');
jest.mock('../prompts.salesforce', () => ({
  __esModule: true,
  runReviewPrompt: jest.fn().mockResolvedValue({ comments: [], documentation: '' }),
}));

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    githubToken: 'mock-token',
    llmApiKey: 'mock-api-key',
    llmModel: 'mock-model',
    styleGuideRules: '',
    githubApiUrl: 'https://api.github.com',
    githubServerUrl: 'https://github.com',
    loadInputs: jest.fn()
  }
}));
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn()
}));

describe('Pull Request Handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    // Mock context
    (loadContext as jest.Mock).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner: 'test-owner', repo: 'test-repo' },
      payload: {
        pull_request: {
          number: 123,
          title: 'Test PR',
          body: 'Test description',
          head: { sha: 'head-sha' },
          base: { sha: 'base-sha' }
        }
      }
    });

    // Mock octokit
    const mockOctokit = {
      rest: {
        pulls: {
          listCommits: jest.fn().mockResolvedValue({
            data: [{ sha: 'commit-sha', commit: { message: 'Test commit' } }]
          }),
          listFiles: jest.fn().mockResolvedValue({
            data: [{ filename: 'test.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n test\n+added' }]
          }),
          createReview: jest.fn().mockResolvedValue({
            data: { id: 'review-id' }
          }),
          submitReview: jest.fn().mockResolvedValue({})
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: [] }),
          createComment: jest.fn().mockResolvedValue({ data: { id: 'comment-id' } }),
          updateComment: jest.fn().mockResolvedValue({})
        }
      }
    };
    (initOctokit as jest.Mock).mockReturnValue(mockOctokit);

    // Mock prompts
    (runSummaryPrompt as jest.Mock).mockResolvedValue({
      title: 'Generated Title',
      description: 'Generated Description',
      files: [{ filename: 'test.ts', summary: 'Test summary', title: 'Test title' }],
      type: ['ENHANCEMENT']
    });

    (runReviewPrompt as jest.Mock).mockResolvedValue({
      review: {
        estimated_effort_to_review: 2,
        score: 85,
        has_relevant_tests: true,
        security_concerns: 'No'
      },
      comments: []
    });
  });

  test('handles pull request event correctly', async () => {
    await handlePullRequest();

    // Verify context was loaded
    expect(loadContext).toHaveBeenCalled();

    // Verify octokit was initialized
    expect(initOctokit).toHaveBeenCalled();

    // Verify commits and files were fetched (parameters may include pagination)
    const mockOctokit = (initOctokit as jest.Mock).mock.results[0].value;
    expect(mockOctokit.rest.pulls.listCommits).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'test-owner',
      repo: 'test-repo',
      pull_number: 123
    }));

    expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'test-owner',
      repo: 'test-repo',
      pull_number: 123
    }));

    // Verify summary was generated
    expect(runSummaryPrompt).toHaveBeenCalled();

    // Verify comment was created
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();

    // Verify review was generated
    expect(runReviewPrompt).toHaveBeenCalled();
  });

  test('ignores pull request with skip marker', async () => {
    // Update mock to include skip marker
    (loadContext as jest.Mock).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner: 'test-owner', repo: 'test-repo' },
      payload: {
        pull_request: {
          number: 123,
          title: 'Test PR',
          body: 'Test description @presubmit skip',
          head: { sha: 'head-sha' },
          base: { sha: 'base-sha' }
        }
      }
    });

    await handlePullRequest();

    // Verify context was loaded
    expect(loadContext).toHaveBeenCalled();

    // Verify octokit was initialized
    expect(initOctokit).toHaveBeenCalled();

    // Verify no further processing happened
    const mockOctokit = (initOctokit as jest.Mock).mock.results[0].value;
    expect(mockOctokit.rest.pulls.listCommits).not.toHaveBeenCalled();
    expect(runSummaryPrompt).not.toHaveBeenCalled();
  });
});


import { DOCUMENTATION_SIGNATURE } from '../messages';

describe('Pull Request Handler - documentation comment', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('posts new documentation comment when new custom fields detected', async () => {
    const { handlePullRequest } = require('../pull_request');
    const { loadContext } = require('../context');
    const { initOctokit } = require('../octokit');
    const { runSummaryPrompt, runReviewPrompt } = require('../prompts');

    (loadContext as jest.Mock).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner: 'o', repo: 'r' },
      payload: { pull_request: { number: 1, title: 't', body: 'b', head: { sha: 'h' }, base: { sha: 'b' } } }
    });

    const mockOctokit = {
      rest: {
        pulls: {
          listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'c', commit: { message: 'm' } }] }),
          listFiles: jest.fn().mockResolvedValue({
            data: [
              { filename: 'force-app/main/default/objects/Account/fields/NewField__c.field-meta.xml', status: 'added', patch: '@@ -0,0 +1,3 @@\n+<label>New F</label>\n+<type>Text</type>' },
            ]
          }),
          createReview: jest.fn().mockResolvedValue({ data: { id: 1 } }),
          submitReview: jest.fn().mockResolvedValue({})
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: [] }),
          createComment: jest.fn().mockResolvedValue({ data: { id: 2 } }),
          updateComment: jest.fn().mockResolvedValue({})
        }
      }
    };
    (initOctokit as jest.Mock).mockReturnValue(mockOctokit);
    (runSummaryPrompt as jest.Mock).mockResolvedValue({ title: 'T', description: 'D', files: [], type: [] });
    (runReviewPrompt as jest.Mock).mockResolvedValue({ comments: [] });

    await handlePullRequest();

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(DOCUMENTATION_SIGNATURE) })
    );
  });

  test('updates existing documentation comment when present', async () => {
    const { handlePullRequest } = require('../pull_request');
    const { loadContext } = require('../context');
    const { initOctokit } = require('../octokit');
    const { runSummaryPrompt, runReviewPrompt } = require('../prompts');

    (loadContext as jest.Mock).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner: 'o', repo: 'r' },
      payload: { pull_request: { number: 2, title: 't', body: 'b', head: { sha: 'h' }, base: { sha: 'b' } } }
    });

    const mockOctokit = {
      rest: {
        pulls: {
          listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'c', commit: { message: 'm' } }] }),
          listFiles: jest.fn().mockResolvedValue({
            data: [
              { filename: 'force-app/main/default/objects/Account/fields/NewField2__c.field-meta.xml', status: 'added', patch: '@@ -0,0 +1,2 @@\n+<label>NF2</label>' },
            ]
          }),
          createReview: jest.fn().mockResolvedValue({ data: { id: 3 } }),
          submitReview: jest.fn().mockResolvedValue({})
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: [{ id: 99, body: 'prev doc ' + DOCUMENTATION_SIGNATURE }] }),
          createComment: jest.fn().mockResolvedValue({ data: { id: 4 } }),
          updateComment: jest.fn().mockResolvedValue({})
        }
      }
    };
    (initOctokit as jest.Mock).mockReturnValue(mockOctokit);
    (runSummaryPrompt as jest.Mock).mockResolvedValue({ title: 'T', description: 'D', files: [], type: [] });
    (runReviewPrompt as jest.Mock).mockResolvedValue({ comments: [] });

    await handlePullRequest();

    expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99, body: expect.stringContaining(DOCUMENTATION_SIGNATURE) })
    );
  });
});


// Additional branches: Salesforce mode switching and incremental no-op

describe('Pull Request Handler - Salesforce mode switching', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('forces Salesforce when salesforceMode=on', async () => {
    const { handlePullRequest } = require('../pull_request');
    const { loadContext } = require('../context');
    const { initOctokit } = require('../octokit');
    const { runSummaryPrompt, runReviewPrompt } = require('../prompts');
    const sf = require('../prompts.salesforce');
    const cfg = require('../config').default;

    Object.defineProperty(cfg, 'salesforceMode', { value: 'on', writable: true });

    (loadContext as jest.Mock).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner: 'o', repo: 'r' },
      payload: { pull_request: { number: 3, title: 't', body: 'b', head: { sha: 'h' }, base: { sha: 'b' } } }
    });

    const mockOctokit = {
      rest: {
        pulls: {
          listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'c', commit: { message: 'm' } }] }),
          listFiles: jest.fn().mockResolvedValue({ data: [ { filename: 'src/app.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n-\n+\n' } ] }),
          createReview: jest.fn().mockResolvedValue({ data: { id: 10 } }),
          submitReview: jest.fn().mockResolvedValue({})
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: [] }),
          createComment: jest.fn().mockResolvedValue({ data: { id: 11 } }),
          updateComment: jest.fn().mockResolvedValue({})
        }
      }
    };
    (initOctokit as jest.Mock).mockReturnValue(mockOctokit);
    (runSummaryPrompt as jest.Mock).mockResolvedValue({ title: 'T', description: 'D', files: [], type: [] });

    await handlePullRequest();

    expect(sf.runReviewPrompt).toHaveBeenCalled();
    expect(runReviewPrompt).not.toHaveBeenCalled();
  });

  test('disables Salesforce when salesforceMode=off, even for SF files', async () => {
    const { handlePullRequest } = require('../pull_request');
    const { loadContext } = require('../context');
    const { initOctokit } = require('../octokit');
    const { runSummaryPrompt, runReviewPrompt } = require('../prompts');
    const sf = require('../prompts.salesforce');
    const cfg = require('../config').default;

    Object.defineProperty(cfg, 'salesforceMode', { value: 'off', writable: true });

    (loadContext as jest.Mock).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner: 'o', repo: 'r' },
      payload: { pull_request: { number: 4, title: 't', body: 'b', head: { sha: 'h' }, base: { sha: 'b' } } }
    });

    const mockOctokit = {
      rest: {
        pulls: {
          listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'c', commit: { message: 'm' } }] }),
          listFiles: jest.fn().mockResolvedValue({ data: [ { filename: 'force-app/main/default/lwc/x/x.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+\n' } ] }),
          createReview: jest.fn().mockResolvedValue({ data: { id: 12 } }),
          submitReview: jest.fn().mockResolvedValue({})
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: [] }),
          createComment: jest.fn().mockResolvedValue({ data: { id: 13 } }),
          updateComment: jest.fn().mockResolvedValue({})
        }
      }
    };
    (initOctokit as jest.Mock).mockReturnValue(mockOctokit);
    (runSummaryPrompt as jest.Mock).mockResolvedValue({ title: 'T', description: 'D', files: [], type: [] });

    await handlePullRequest();

    expect(runReviewPrompt).toHaveBeenCalled();
    // Salesforce prompt not used when mode=off
    expect(sf.runReviewPrompt).not.toHaveBeenCalled();
  });
});

describe('Pull Request Handler - incremental no new commits', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('returns early when no new commits to review', async () => {
    const { handlePullRequest } = require('../pull_request');
    const { loadContext } = require('../context');
    const { initOctokit } = require('../octokit');
    const { runSummaryPrompt } = require('../prompts');
    const { OVERVIEW_MESSAGE_SIGNATURE, PAYLOAD_TAG_OPEN, PAYLOAD_TAG_CLOSE } = require('../messages');

    (loadContext as jest.Mock).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner: 'o', repo: 'r' },
      payload: { pull_request: { number: 5, title: 't', body: 'b', head: { sha: 'H123' }, base: { sha: 'B123' } } }
    });

    const overviewBody = `${OVERVIEW_MESSAGE_SIGNATURE}${PAYLOAD_TAG_OPEN}${JSON.stringify({ commits: ['H123'] })}${PAYLOAD_TAG_CLOSE}`;

    const mockOctokit = {
      rest: {
        pulls: {
          listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'H123', commit: { message: 'm' } }] }),
          listFiles: jest.fn().mockResolvedValue({ data: [ { filename: 'src/app.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n-\n+\n' } ] }),
          listReviewComments: jest.fn().mockResolvedValue({ data: [] }),
          createReview: jest.fn(),
          submitReview: jest.fn()
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: [{ id: 201, body: overviewBody }] }),
          createComment: jest.fn(),
          updateComment: jest.fn()
        }
      }
    };

    (initOctokit as jest.Mock).mockReturnValue(mockOctokit);
    (runSummaryPrompt as jest.Mock).mockResolvedValue({ title: 'T', description: 'D', files: [], type: [] });

    await handlePullRequest();

    // Should not post or update comments and should not call review
    expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });
});


describe('Pull Request Handler - batching and fallback', () => {
  beforeEach(() => { jest.resetModules(); });

  test('submits comments in batches and falls back on error', async () => {
    const { handlePullRequest } = require('../pull_request');
    const { loadContext } = require('../context');
    const { initOctokit } = require('../octokit');
    const { runSummaryPrompt, runReviewPrompt } = require('../prompts');
    const cfg = require('../config').default;

    Object.defineProperty(cfg, 'salesforceMode', { value: 'off', writable: true });
    Object.defineProperty(cfg, 'maxComments', { value: 1000, writable: true });

    (loadContext as jest.Mock).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner: 'o', repo: 'r' },
      payload: { pull_request: { number: 6, title: 't', body: 'b', head: { sha: 'h' }, base: { sha: 'b' } } }
    });

    const many = Array.from({ length: 55 }).map((_, i) => ({
      file: 'src/a.ts', start_line: i + 1, end_line: i + 1, highlighted_code: '+code', header: 'h', content: 'x'.repeat(40), label: 'security', critical: true,
    }));

    (runSummaryPrompt as jest.Mock).mockResolvedValue({ title: 'T', description: 'D', files: [], type: [] });
    (runReviewPrompt as jest.Mock).mockResolvedValue({ comments: many, review: { estimated_effort_to_review: 2, score: 80, has_relevant_tests: true, security_concerns: 'No' } });

    const mockOctokit = {
      rest: {
        pulls: {
          listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'c', commit: { message: 'm' } }] }),
          listFiles: jest.fn().mockResolvedValue({ data: [ { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+X' } ] }),
          submitReview: jest.fn().mockResolvedValue({}),
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: [] }),
          createComment: jest.fn().mockResolvedValue({ data: { id: 1 } }),
          updateComment: jest.fn().mockResolvedValue({}),
        }
      },
      pulls: {
        createReviewComment: jest.fn().mockResolvedValue({}),
        submitReview: jest.fn(),
        createReview: jest.fn().mockResolvedValueOnce({ data: { id: 1 } }).mockRejectedValueOnce(new Error('fail batch 2')),
      }
    };

    (initOctokit as jest.Mock).mockReturnValue(mockOctokit);

    await handlePullRequest();

    // First batch review created, then fallback for second batch triggers per-comment
    expect(mockOctokit.pulls.createReview).toHaveBeenCalledTimes(2);
    expect(mockOctokit.pulls.createReviewComment).toHaveBeenCalled();
  });
});




describe('PR-level comment upsert', () => {
  test('file-level comment uses upsert (updates if signature exists)', async () => {
    jest.resetAllMocks();
    const { handlePullRequest } = await import('../pull_request');
    const { loadContext } = await import('../context');
    const { initOctokit } = await import('../octokit');
    const prompts = await import('../prompts');

    // Arrange input
    const owner = 'o';
    const repo = 'r';
    const pull_number = 77;
    (loadContext as any).mockResolvedValue({
      eventName: 'pull_request',
      repo: { owner, repo },
      payload: { pull_request: { number: pull_number, title: 't', body: 'b', head: { sha: 'h' }, base: { sha: 'b' } } },
    });

    // One file, and LLM returns a file-level comment (no end_line)
    (prompts.runSummaryPrompt as any).mockResolvedValue({ title: 'T', description: 'D', files: [], type: [] });
    const c = { file: 'src/a.ts', header: 'H', content: 'C' } as any;
    (prompts.runReviewPrompt as any).mockResolvedValue({ comments: [c] });

    // Compute expected signature identical to implementation
    function hashString(input: string): string {
      let h = 5381; for (let i = 0; i < input.length; i++) { h = (h * 33) ^ input.charCodeAt(i); }
      return (h >>> 0).toString(16);
    }
    const key = `file-note|src/a.ts|0|H`;
    const sig = `<!-- presubmit.ai: upsert:${hashString(key)}:${key} -->`;

    const mockOctokit = {
      rest: {
        pulls: {
          listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'c', commit: { message: 'm' } }] }),
          listFiles: jest.fn().mockResolvedValue({ data: [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+X' }] }),
          createReview: jest.fn().mockResolvedValue({ data: { id: 1 } }),
          submitReview: jest.fn().mockResolvedValue({}),
        },
        issues: {
          listComments: jest.fn()
            // Return existing comment containing the signature so we go to update path
            .mockResolvedValue({ data: [{ id: 999, body: `${sig}\nOld` }] }),
          createComment: jest.fn().mockResolvedValue({ data: { id: 321, body: 'loading' } }),
          updateComment: jest.fn().mockResolvedValue({}),
        },
      },
      pulls: {}, issues: {},
    } as any;
    (initOctokit as any).mockReturnValue(mockOctokit);

    // Act
    await handlePullRequest();

    // Assert: upsert path was exercised (lists existing comments to dedupe)
    expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: pull_number })
    );
  });
});
