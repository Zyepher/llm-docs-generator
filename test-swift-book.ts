/**
 * Quick test script for swift-book markdown parsing
 *
 * Run with: npx tsx test-swift-book.ts
 */

import { markdownParser } from './src/parsers/markdown/index.js';
import { formatDocNode } from './src/core/universal-formatter.js';

async function test() {
  console.log('Testing Swift-Book Markdown Parser...\n');

  // Test parsing a single markdown file
  const testFile = '../TSPL.docc/LanguageGuide/BasicOperators.md';

  try {
    console.log(`1. Parsing ${testFile}...`);
    const docNode = await markdownParser.parse(testFile);

    console.log(`   ✓ Parsed successfully`);
    console.log(`   Title: ${docNode.title}`);
    console.log(`   Type: ${docNode.type}`);
    console.log(`   Children: ${docNode.children.length}`);
    console.log(`   Content blocks: ${docNode.content.length}\n`);

    // Test formatting
    console.log('2. Formatting to LLM-optimized output...');
    await formatDocNode(docNode, {
      outputDir: './test-output',
      filenamePrefix: 'swift-basic-operators',
      title: 'Swift Basic Operators',
      systemPrompt: 'Swift Basic Operators documentation for LLMs',
    });

    console.log('   ✓ Generated test-output/swift-basic-operators-full-llms.txt\n');
    console.log('Success! Check test-output/ directory for generated files.');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

test();
