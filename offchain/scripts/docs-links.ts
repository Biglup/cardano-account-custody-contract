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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* CONSTANTS ******************************************************************/

/** The repository root, which the walk starts from. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The directories the walk does not enter, besides every hidden one: dependencies, build output and the task queue. */
export const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', 'todo']);

/** The file a directory stands for when a link points at the directory. */
const DIRECTORY_PAGE = 'README.md';

/** A target the checker leaves alone: one with a scheme, such as https or mailto. */
const EXTERNAL_TARGET = /^[a-z][a-z0-9+.-]*:/i;

/** An inline link or image: the target between the parentheses after `]`, in angle brackets or bare, and an optional title. */
const INLINE_LINK = /\]\(\s*(?:<([^<>]*)>|([^\s<>)]*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** A reference definition: a label and its target, in angle brackets or bare, at the start of a line. */
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^<>]*)>|([^\s<>]+))/;

/** A code span, which holds no link. */
const CODE_SPAN = /`[^`]*`/g;

/** A fence that opens or closes a code block. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** An ATX heading: the hashes, the text and an optional closing sequence. */
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;

/** A line anchor as GitHub renders it: one line, or a range of lines. */
const LINE_ANCHOR = /^L(\d+)(?:-L(\d+))?$/;

/** A link whose text replaces it in a rendered heading. */
const HEADING_LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** The marks a rendered heading drops: code and emphasis marks. */
const HEADING_MARKS = /[`*]/g;

/** What a GitHub slug drops: everything but letters, numbers, marks, spaces, hyphens and underscores. */
const SLUG_DROPPED = /[^\p{L}\p{N}\p{M} _-]/gu;

/* TYPES **********************************************************************/

/** A link of a Markdown file: its target as written and the line it sits on. */
export interface Link {
  target: string;
  line: number;
}

/** A link the checker could not resolve: where it sits, relative to the root, and why. */
export interface BrokenLink {
  file: string;
  line: number;
  target: string;
  reason: string;
}

/** What a walk of the repository found. */
export interface LinkReport {
  files: number;
  links: number;
  broken: BrokenLink[];
}

/* FUNCTIONS ******************************************************************/

/** The lines of a Markdown file outside its fenced code blocks, with their line numbers, so that neither a link nor a heading inside a code sample counts. */
const proseLines = (markdown: string): { text: string; line: number }[] => {
  const lines: { text: string; line: number }[] = [];
  let fence: string | undefined;
  markdown.split('\n').forEach((text, index) => {
    const marker = FENCE.exec(text)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      return;
    }
    if (marker !== undefined) {
      fence = marker;
      return;
    }
    lines.push({ text, line: index + 1 });
  });
  return lines;
};

/** The slug GitHub gives a heading: its rendered text in lower case, punctuation dropped, spaces as hyphens. */
export const slugOf = (heading: string): string =>
  heading.replace(HEADING_LINK, '$1').replace(HEADING_MARKS, '').toLowerCase().replace(SLUG_DROPPED, '').replace(/ /g, '-');

/** The anchors of a Markdown file: the slug of every heading outside a code block, with a later heading of the same slug numbered from 1, as GitHub numbers it. */
export const anchorsOf = (markdown: string): Set<string> => {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text } of proseLines(markdown)) {
    const heading = HEADING.exec(text)?.[1];
    if (heading === undefined) {
      continue;
    }
    const slug = slugOf(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
};

/** The relative links of a Markdown file: every inline link, image and reference definition outside a code block or code span whose target has no scheme. */
export const linksOf = (markdown: string): Link[] => {
  const links: Link[] = [];
  for (const { text, line } of proseLines(markdown)) {
    const prose = text.replace(CODE_SPAN, '');
    const definition = REFERENCE_DEFINITION.exec(prose);
    const targets = definition ? [definition[1] ?? definition[2]] : [...prose.matchAll(INLINE_LINK)].map((match) => match[1] ?? match[2]);
    for (const target of targets) {
      if (target !== undefined && !EXTERNAL_TARGET.test(target)) {
        links.push({ target, line });
      }
    }
  }
  return links;
};

/** The number of lines of a file, which a line anchor must not exceed. */
const lineCount = (content: string): number => content.split('\n').length - (content.endsWith('\n') ? 1 : 0);

/**
 * Why a link does not resolve from the file that holds it, or nothing
 * when it does. The path is taken relative to the file's directory,
 * percent decoded and without its query; an empty path is the file
 * itself. A directory resolves to the README.md it holds. A line anchor
 * must point inside the target. Any other anchor must be the slug of a
 * heading of a Markdown target, written exactly as GitHub renders it.
 */
/** The path as written, percent decoded when every escape is well formed, as GitHub resolves it. */
const decodedPath = (written: string): string => {
  try {
    return decodeURIComponent(written);
  } catch {
    return written;
  }
};

export const brokenReason = (file: string, target: string): string | undefined => {
  const hash = target.indexOf('#');
  const written = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? undefined : target.slice(hash + 1);
  const path = decodedPath(written.split('?')[0] ?? '');
  let resolved = path === '' ? file : resolve(dirname(file), path);
  if (!existsSync(resolved)) {
    return `${path} does not exist`;
  }
  if (statSync(resolved).isDirectory()) {
    if (anchor === undefined) {
      return undefined;
    }
    resolved = join(resolved, DIRECTORY_PAGE);
    if (!existsSync(resolved)) {
      return `${path} holds no ${DIRECTORY_PAGE} to carry #${anchor}`;
    }
  }
  if (anchor === undefined) {
    return undefined;
  }
  const content = readFileSync(resolved, 'utf8');
  const lineAnchor = LINE_ANCHOR.exec(anchor);
  if (lineAnchor) {
    const first = Number(lineAnchor[1]);
    const last = Number(lineAnchor[2] ?? lineAnchor[1]);
    const lines = lineCount(content);
    return first >= 1 && first <= last && last <= lines ? undefined : `#${anchor} is outside the ${lines} lines of ${path === '' ? file : path}`;
  }
  if (!resolved.endsWith('.md')) {
    return `${path} is not a Markdown file, so #${anchor} must be a line anchor`;
  }
  return anchorsOf(content).has(anchor) ? undefined : `${path === '' ? 'the file' : path} has no heading with the anchor #${anchor}`;
};

/** Every Markdown file under the root, outside the skipped and hidden directories, in path order. Symbolic links are not followed. */
export const markdownFiles = (root: string): string[] => {
  const files: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
};

/** Every relative link of every Markdown file under the root, resolved, with the ones that do not resolve. */
export const checkLinks = (root: string): LinkReport => {
  const report: LinkReport = { files: 0, links: 0, broken: [] };
  for (const file of markdownFiles(root)) {
    report.files += 1;
    for (const { target, line } of linksOf(readFileSync(file, 'utf8'))) {
      report.links += 1;
      const reason = brokenReason(file, target);
      if (reason !== undefined) {
        report.broken.push({ file: relative(root, file), line, target, reason });
      }
    }
  }
  return report;
};

/* MAIN ***********************************************************************/

const main = async (): Promise<void> => {
  const { files, links, broken } = checkLinks(REPO_ROOT);
  if (broken.length > 0) {
    throw new Error(broken.map(({ file, line, target, reason }) => `${file}:${line}: ${target}: ${reason}`).join('\n'));
  }
  console.log(`${links} relative links across ${files} Markdown files resolve`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
