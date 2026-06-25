/**
 * reStructuredText → IR adapter.
 */

import { basename } from 'node:path';

import { DocNodeType, createDocNode, type DocNode } from '../../core/models.js';
import type { RstDocument } from './parser.js';

export function rstToDocNode(
  doc: RstDocument,
  options?: {
    documentType?: DocNodeType;
  }
): DocNode {
  const metadata = new Map(doc.metadata);
  metadata.set('format', 'rst');
  metadata.set('sourcePath', doc.path);

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

export function mergeRstDocuments(
  docs: RstDocument[],
  rootTitle: string,
  sourcePath: string
): DocNode {
  const warnings = docs.flatMap((doc) => doc.metadata.get('warnings') ?? []);
  const metadata = new Map<string, unknown>([
    ['format', 'rst'],
    ['sourcePath', sourcePath],
    ['sourcePaths', docs.map((doc) => doc.path)],
    ['parser', 'rst-subset'],
    [
      'parserDetails',
      {
        subset: 'underline headings, paragraphs, simple lists, literal blocks, code directives',
        unsupportedDirectives:
          'warned and preserved as prose where safe; includes are not executed',
      },
    ],
    ['count', docs.length],
    ['warnings', warnings],
  ]);

  return createDocNode(DocNodeType.ROOT, 'root', rootTitle, {
    children: docs.map((doc) => rstToDocNode(doc, { documentType: DocNodeType.SECTION })),
    metadata,
  });
}

function extractIdFromPath(path: string): string {
  return basename(path)
    .replace(/\.rst$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
