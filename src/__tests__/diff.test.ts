import { parseFileDiff, generateFileCodeDiff, FileDiff, File } from '../diff';

describe('Diff Parser', () => {
  const mockFile: File = {
    filename: 'src/test.ts',
    status: 'modified',
    patch: '@@ -1,5 +1,6 @@\n import { something } from \'somewhere\';\n \n-function oldFunction() {\n+function newFunction() {\n+  // Added comment\n   return true;\n }\n'
  };

  const mockCommentThreads = [];

  test('parseFileDiff correctly parses hunks', () => {
    const fileDiff = parseFileDiff(mockFile, mockCommentThreads);

    expect(fileDiff.hunks.length).toBe(1);
    expect(fileDiff.hunks[0].startLine).toBe(1);
    expect(fileDiff.hunks[0].endLine).toBe(8);
    expect(fileDiff.hunks[0].diff).toContain('@@ -1,5 +1,6 @@');
    expect(fileDiff.hunks[0].diff).toContain('+function newFunction() {');
    expect(fileDiff.hunks[0].diff).toContain('-function oldFunction() {');
  });

  test('generateFileCodeDiff formats diff correctly', () => {
    const fileDiff = parseFileDiff(mockFile, mockCommentThreads);
    const formattedDiff = generateFileCodeDiff(fileDiff);

    expect(formattedDiff).toContain("## File modified: 'src/test.ts'");
    expect(formattedDiff).toContain("__new hunk__");
    expect(formattedDiff).toContain("__old hunk__");
  });

  test('handles files without patches', () => {
    const fileWithoutPatch: File = {
      filename: 'src/binary.png',
      status: 'added'
    };

    const fileDiff = parseFileDiff(fileWithoutPatch, mockCommentThreads);
    expect(fileDiff.hunks.length).toBe(0);

    const formattedDiff = generateFileCodeDiff(fileDiff);
    expect(formattedDiff).toContain("## File added: 'src/binary.png'");
  });
});

  test('renders previous filename for renamed files', () => {
    const file: File = {
      filename: 'src/new.ts',
      previous_filename: 'src/old.ts',
      status: 'renamed',
      patch: '@@ -1,1 +1,1 @@\n-old\n+new\n'
    };
    const fd = parseFileDiff(file, []);
    const out = generateFileCodeDiff(fd);
    expect(out).toContain("'src/old.ts' → 'src/new.ts'");
  });

  test('includes existing comment threads in formatted diff', () => {
    const file: File = {
      filename: 'src/c.ts',
      status: 'modified',
      patch: '@@ -10,1 +10,1 @@\n-old\n+new\n'
    };
    const fd = parseFileDiff(file, []);
    // attach a synthetic thread within hunk range
    fd.hunks[0].commentThreads = [
      {
        file: 'src/c.ts',
        comments: [
          { id: 1, user: { login: 'alice' }, body: 'Looks good', line: fd.hunks[0].startLine, path: 'src/c.ts' } as any,
          { id: 2, user: { login: 'bob' }, body: 'Agreed', in_reply_to_id: 1, line: fd.hunks[0].startLine, path: 'src/c.ts' } as any,
        ],
      } as any,
    ];
    const out = generateFileCodeDiff(fd);
    expect(out).toContain('__existing_comment_thread__');
    expect(out).toContain('@alice: Looks good');
  });

