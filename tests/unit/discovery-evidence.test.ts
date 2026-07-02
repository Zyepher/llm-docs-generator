import { describe, expect, it } from 'vitest';

import { buildDiscoveryCandidateEvidenceIndex } from '../../src/core/manifest/discovery-evidence.js';

describe('discovery candidate evidence index', () => {
  it('omits empty evidence categories so written indexes match verifier shape rules', () => {
    const index = buildDiscoveryCandidateEvidenceIndex('source', {
      source: {
        input: 'docs',
        resolvedPath: '/tmp/docs',
        type: 'directory',
      },
      candidates: [
        {
          path: 'guide.md',
          kind: 'markdown',
          format: 'markdown',
          evidence: {
            category: '',
            signals: ['kind:markdown'],
          },
          order: 1,
          byteSize: 12,
          sha256: '0'.repeat(64),
        },
      ],
    });

    expect(index.candidates[0]?.evidence).toEqual({
      signals: ['kind:markdown'],
    });
  });
});
