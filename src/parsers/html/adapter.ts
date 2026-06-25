/**
 * Static HTML → IR adapter.
 */

import { basename } from 'node:path';

import { DocNodeType, createDocNode, type DocNode } from '../../core/models.js';
import type { HtmlDocument } from './parser.js';
import { getParserDetails } from './parser.js';

export function htmlToDocNode(
  doc: HtmlDocument,
  options?: {
    documentType?: DocNodeType;
  }
): DocNode {
  const metadata = new Map(doc.metadata);
  metadata.set('format', 'html');
  metadata.set('sourcePath', doc.path);
  metadata.set('sourceKind', 'rendered-html-fallback');
  metadata.set('renderedHtmlFallback', true);
  metadata.set('confidence', 'lower');

  return createDocNode(
    options?.documentType ?? DocNodeType.SECTION,
    extractIdFromPath(doc.path),
    doc.title,
    {
      content: doc.content,
      children: doc.children,
      metadata,
    }
  );
}

export function mergeHtmlDocuments(
  docs: HtmlDocument[],
  rootTitle: string,
  sourcePath: string
): DocNode {
  const warnings = docs.flatMap((doc) => doc.metadata.get('warnings') ?? []);
  const links = docs.flatMap((doc) => doc.metadata.get('links') ?? []);
  const metadata = new Map<string, unknown>([
    ['format', 'html'],
    ['sourcePath', sourcePath],
    ['sourcePaths', docs.map((doc) => doc.path)],
    ['sourceKind', 'rendered-html-fallback'],
    ['renderedHtmlFallback', true],
    ['confidence', 'lower'],
    ['parser', 'html-static-subset'],
    ['parserDetails', getParserDetails()],
    ['count', docs.length],
    ['warnings', warnings],
  ]);

  if (links.length > 0) {
    metadata.set('links', links);
  }

  return createDocNode(DocNodeType.ROOT, 'root', rootTitle, {
    children: docs.map((doc) => htmlToDocNode(doc, { documentType: DocNodeType.SECTION })),
    metadata,
  });
}

function extractIdFromPath(path: string): string {
  return basename(path)
    .replace(/\.html?$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
