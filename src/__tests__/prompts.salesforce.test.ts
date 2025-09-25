import { jest } from '@jest/globals';

describe('prompts.salesforce.runReviewPrompt', () => {
  const mockRunPrompt = jest.fn().mockResolvedValue({
    review: {
      estimated_effort_to_review: 1,
      score: 100,
      has_relevant_tests: true,
      security_concerns: 'No',
    },
    documentation: 'Doc',
    comments: [],
  });

  beforeEach(() => {
    jest.resetModules();
    mockRunPrompt.mockClear();
  });

  test('includes Salesforce metadata rules when metadata files present', async () => {
    process.env = { ...process.env }; // keep env

    jest.doMock('../ai', () => ({
      __esModule: true,
      runPrompt: mockRunPrompt,
    }));

    const { runReviewPrompt } = await import('../prompts.salesforce');

    const files = [
      {
        filename: 'force-app/main/default/flows/MyFlow.flow-meta.xml',
        status: 'modified',
        hunks: [
          { startLine: 1, endLine: 1, diff: "@@ -1,1 +1,1 @@\n+<flow/>" },
        ],
      },
    ] as any;

    const result = await runReviewPrompt({
      prTitle: 'T',
      prDescription: 'D',
      prSummary: 'S',
      files,
    });

    expect(result.documentation).toBe('Doc');
    expect(mockRunPrompt).toHaveBeenCalledTimes(1);
    const call = mockRunPrompt.mock.calls[0][0];
    expect(call.systemPrompt).toContain('<SALESFORCE METADATA REVIEW RULES>');
    expect(call.systemPrompt).toContain('Salesforce Metadata Change Documentation');
    // Ensure file diffs were embedded
    expect(call.prompt).toContain("MyFlow.flow-meta.xml");
    expect(call.prompt).toContain('__new hunk__');
  });

  test('omits Salesforce metadata rules when no metadata files', async () => {
    jest.resetModules();
    mockRunPrompt.mockClear();

    jest.doMock('../ai', () => ({
      __esModule: true,
      runPrompt: mockRunPrompt,
    }));

    const { runReviewPrompt } = await import('../prompts.salesforce');

    const files = [
      {
        filename: 'src/some.ts',
        status: 'modified',
        hunks: [
          { startLine: 1, endLine: 1, diff: "@@ -1,1 +1,1 @@\n+const x=1;" },
        ],
      },
    ] as any;

    await runReviewPrompt({ prTitle: 'T', prDescription: 'D', prSummary: 'S', files });

    const call = mockRunPrompt.mock.calls[0][0];
    expect(call.systemPrompt).not.toContain('<SALESFORCE METADATA REVIEW RULES>');
  });
});



  test('includes styleGuideRules when provided', async () => {
    jest.resetModules();
    const mockRunPrompt = jest.fn().mockResolvedValue({ review: { estimated_effort_to_review:1, score:100, has_relevant_tests:true, security_concerns:'No' }, documentation:'', comments:[] });
    jest.doMock('../ai', () => ({ __esModule: true, runPrompt: mockRunPrompt }));
    jest.doMock('../config', () => ({ __esModule: true, default: { styleGuideRules: 'RULE1\nRULE2' } }));

    const { runReviewPrompt } = await import('../prompts.salesforce');

    const files: any = [ { filename: 'src/a.ts', status: 'modified', hunks: [{ startLine:1, endLine:1, diff: '@@ -1,1 +1,1 @@\n+X' }] } ];
    await runReviewPrompt({ prTitle: 't', prDescription: 'd', prSummary: 's', files });

    const call = (mockRunPrompt as any).mock.calls[0][0];
    expect(call.systemPrompt).toContain('Guidelines to enforce');
    expect(call.systemPrompt).toContain('RULE1');
  });


  test('includes styleGuideRules when provided and metadata present', async () => {
    jest.resetModules();
    const mockRunPrompt = jest.fn().mockResolvedValue({ review: { estimated_effort_to_review:1, score:100, has_relevant_tests:true, security_concerns:'No' }, documentation:'', comments:[] });
    jest.doMock('../ai', () => ({ __esModule: true, runPrompt: mockRunPrompt }));

    const { runReviewPrompt } = await import('../prompts.salesforce');
    const cfg = (await import('../config')).default as any;
    cfg.styleGuideRules = 'R1';

    const files: any = [ { filename: 'force-app/main/default/flows/F.flow-meta.xml', status: 'modified', hunks: [{ startLine:1, endLine:1, diff: '@@ -1,1 +1,1 @@\n+<flow/>' }] } ];
    await runReviewPrompt({ prTitle: 't', prDescription: 'd', prSummary: 's', files });

    const call = (mockRunPrompt as any).mock.calls[0][0];
    expect(call.systemPrompt).toContain('<SALESFORCE METADATA REVIEW RULES>');
    expect(call.systemPrompt).toContain('Guidelines to enforce');
    expect(call.systemPrompt).toContain('R1');
  });
