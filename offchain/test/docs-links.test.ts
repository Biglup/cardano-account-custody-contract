/**
 * Copyright 2026 IOG.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* IMPORTS ********************************************************************/

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorsOf, brokenReason, checkLinks, linksOf, markdownFiles, slugOf } from '../scripts/docs-links.js';

/* CONSTANTS ******************************************************************/

/** The directories a test wrote a repository into, removed after it. */
const directories: string[] = [];

/** A page with a heading, a duplicate heading and three lines of prose. */
const PAGE = '# Scope\n\n## Checks\n\nSome prose.\n\n## Checks\n\nMore prose.\n';

/* FUNCTIONS ******************************************************************/

/** A fresh repository holding the given files, by path relative to its root, removed after the test. */
const repositoryWith = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'custody-docs-'));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

/* TESTS **********************************************************************/

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('slugOf', () => {
  it('lowers the case and joins the words with hyphens', () => {
    expect(slugOf('Build and test the validators')).toBe('build-and-test-the-validators');
    expect(slugOf('Flows 43 to 54')).toBe('flows-43-to-54');
  });

  it('drops punctuation and keeps every space as a hyphen, as GitHub does', () => {
    expect(slugOf('ADR 0001: permanent proxy')).toBe('adr-0001-permanent-proxy');
    expect(slugOf('Datums, redeemers & types')).toBe('datums-redeemers--types');
    expect(slugOf('logic_v1 and logic_v2')).toBe('logic_v1-and-logic_v2');
  });

  it('renders code, emphasis and links before slugging', () => {
    expect(slugOf('`else`')).toBe('else');
    expect(slugOf('**Bold** heading')).toBe('bold-heading');
    expect(slugOf('The [glossary](glossary.md) terms')).toBe('the-glossary-terms');
  });
});

describe('anchorsOf', () => {
  it('numbers a later heading of the same slug from 1', () => {
    expect([...anchorsOf('# Purpose\n\n## Purpose\n\n### Purpose\n\n## Other\n')]).toEqual(['purpose', 'purpose-1', 'purpose-2', 'other']);
  });

  it('drops a closing sequence of hashes and leaves a line that only starts with a hash', () => {
    expect([...anchorsOf('## Scope ##\n\n#hashtag\n')]).toEqual(['scope']);
  });

  it('leaves the headings inside fenced code blocks, whatever the fence', () => {
    const markdown = '# Kept\n\n```sh\n# Dropped\n```\n\n~~~\n## Dropped too\n~~~\n\n````md\n```\n# Still inside\n```\n````\n\n## Kept too\n';
    expect([...anchorsOf(markdown)]).toEqual(['kept', 'kept-too']);
  });
});

describe('linksOf', () => {
  it('lists inline links and images with the line they sit on', () => {
    const markdown = 'See [the page](page.md#scope) and ![a diagram](diagram.svg).\n\nThen [another](../other.md).\n';
    expect(linksOf(markdown)).toEqual([
      { target: 'page.md#scope', line: 1 },
      { target: 'diagram.svg', line: 1 },
      { target: '../other.md', line: 3 },
    ]);
  });

  it('reads a target in angle brackets, with a title, and a reference definition', () => {
    expect(linksOf('[a](<my page.md> "Title")\n\n[ref]: target.md\n')).toEqual([
      { target: 'my page.md', line: 1 },
      { target: 'target.md', line: 3 },
    ]);
  });

  it('leaves targets with a scheme alone', () => {
    expect(linksOf('[a](https://example.com/page.md) [b](mailto:someone@example.com) [c](local.md)\n')).toEqual([{ target: 'local.md', line: 1 }]);
  });

  it('leaves links inside code spans and fenced code blocks', () => {
    expect(linksOf('A `[code](span.md)` and\n\n```\n[fenced](block.md)\n```\n\n[prose](prose.md)\n')).toEqual([{ target: 'prose.md', line: 7 }]);
  });
});

describe('brokenReason', () => {
  it('resolves a file relative to the file holding the link, and refuses a missing one', () => {
    const root = repositoryWith({ 'docs/a.md': PAGE, 'docs/guides/b.md': '' });
    expect(brokenReason(join(root, 'docs/guides/b.md'), '../a.md')).toBeUndefined();
    expect(brokenReason(join(root, 'docs/guides/b.md'), '../missing.md')).toBe('../missing.md does not exist');
  });

  it('resolves a heading anchor, a duplicate heading anchor and an anchor of the file itself', () => {
    const root = repositoryWith({ 'a.md': PAGE, 'b.md': '' });
    expect(brokenReason(join(root, 'b.md'), 'a.md#scope')).toBeUndefined();
    expect(brokenReason(join(root, 'b.md'), 'a.md#checks-1')).toBeUndefined();
    expect(brokenReason(join(root, 'a.md'), '#checks')).toBeUndefined();
    expect(brokenReason(join(root, 'b.md'), 'a.md#checks-2')).toBe('a.md has no heading with the anchor #checks-2');
    expect(brokenReason(join(root, 'a.md'), '#Scope')).toBe('the file has no heading with the anchor #Scope');
  });

  it('holds a line anchor inside the target and refuses one outside it', () => {
    const root = repositoryWith({ 'a.md': '', 'code.ak': 'one\ntwo\nthree\n', 'unterminated.ak': 'one\ntwo' });
    expect(brokenReason(join(root, 'a.md'), 'code.ak#L3')).toBeUndefined();
    expect(brokenReason(join(root, 'a.md'), 'code.ak#L1-L3')).toBeUndefined();
    expect(brokenReason(join(root, 'a.md'), 'unterminated.ak#L2')).toBeUndefined();
    expect(brokenReason(join(root, 'a.md'), 'code.ak#L4')).toBe('#L4 is outside the 3 lines of code.ak');
    expect(brokenReason(join(root, 'a.md'), 'code.ak#L3-L2')).toBe('#L3-L2 is outside the 3 lines of code.ak');
    expect(brokenReason(join(root, 'a.md'), 'code.ak#L0')).toBe('#L0 is outside the 3 lines of code.ak');
  });

  it('refuses a heading anchor on a file that is not Markdown', () => {
    const root = repositoryWith({ 'a.md': '', 'code.ak': 'one\n' });
    expect(brokenReason(join(root, 'a.md'), 'code.ak#scope')).toBe('code.ak is not a Markdown file, so #scope must be a line anchor');
  });

  it('resolves a directory, and an anchor of a directory against its README', () => {
    const root = repositoryWith({ 'a.md': '', 'docs/README.md': PAGE, 'bare/file.txt': '' });
    expect(brokenReason(join(root, 'a.md'), 'docs')).toBeUndefined();
    expect(brokenReason(join(root, 'a.md'), 'docs/#scope')).toBeUndefined();
    expect(brokenReason(join(root, 'a.md'), 'docs#missing')).toBe('docs has no heading with the anchor #missing');
    expect(brokenReason(join(root, 'a.md'), 'bare#scope')).toBe('bare holds no README.md to carry #scope');
  });

  it('decodes the path and drops its query', () => {
    const root = repositoryWith({ 'a.md': '', 'my page.md': PAGE, '50%.md': '' });
    expect(brokenReason(join(root, 'a.md'), 'my%20page.md?plain=1#scope')).toBeUndefined();
    expect(brokenReason(join(root, 'a.md'), '50%.md')).toBeUndefined();
  });
});

describe('markdownFiles', () => {
  it('walks the tree in path order and leaves the skipped and hidden directories and other files', () => {
    const root = repositoryWith({
      'README.md': '',
      'docs/b.md': '',
      'docs/a.md': '',
      'docs/deep/c.md': '',
      'docs/notes.txt': '',
      'node_modules/dep/README.md': '',
      'build/out.md': '',
      'todo/task.md': '',
      '.hidden/secret.md': '',
      'fixtures/build/inner.md': '',
    });
    expect(markdownFiles(root).map((file) => file.slice(root.length + 1))).toEqual(['README.md', 'docs/a.md', 'docs/b.md', 'docs/deep/c.md']);
  });
});

describe('checkLinks', () => {
  it('counts the files and links and names each broken link by file, line and reason', () => {
    const root = repositoryWith({
      'README.md': 'See [docs](docs/a.md#scope) and [more](docs/a.md#missing).\n',
      'docs/a.md': `${PAGE}\n[up](../README.md)\n\n[gone](nowhere.md)\n`,
    });
    expect(checkLinks(root)).toEqual({
      files: 2,
      links: 4,
      broken: [
        { file: 'README.md', line: 1, target: 'docs/a.md#missing', reason: 'docs/a.md has no heading with the anchor #missing' },
        { file: 'docs/a.md', line: 13, target: 'nowhere.md', reason: 'nowhere.md does not exist' },
      ],
    });
  });
});
