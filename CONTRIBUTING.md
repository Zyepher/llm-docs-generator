# Contributing to llm-docs-generator

Thank you for your interest in contributing! This project uses a community-maintained source hint catalog to help AI coding assistants find likely documentation locations.

## Ways to Contribute

### 1. Add or Update Source Hints

The most valuable contribution is improving `config/known-sources.json`. Despite the compatibility filename, this file is a non-authoritative hint catalog, not a registry of verified sources. Every hint must be checked against the current upstream repository, path, version, and format before use.

#### Requirements

- Documentation must be publicly accessible
- Format must be one the parsers implement today: `openref`, `markdown`, `mdx`, `openapi`, `rst`, or `html` (anything else must be marked as planned until parser and CLI support exists)
- Verify the repository, path, version, and format before submitting
- Include a note that explains how the hint was verified

#### Process

1. Fork the repository
2. Add or update an entry in `config/known-sources.json`
3. Verify the hint against the current upstream source
4. Update `tested: true` only after the hint is verified against upstream and supported by implemented parser/CLI behavior
5. Update related docs only when they describe implemented behavior
6. Submit pull request

#### Hint Entry Format

```json
{
  "id": "unique-project-id",
  "name": "Human Readable Project Name",
  "repository": "https://github.com/org/repo",
  "format": "markdown|openref|restructuredtext",
  "path": "path/to/docs",
  "pattern": "**/*.md",
  "description": "Brief description of the documentation",
  "examples": [
    {
      "file": "path/to/example.md",
      "description": "What this file contains"
    }
  ],
  "hint": "Likely docs live under path/to/docs. Verify the current repository layout before use.",
  "tested": false,
  "maintainer": "Organization or Individual"
}
```

#### Required Fields

- `id`: Unique identifier (lowercase, hyphens)
- `name`: Display name
- `repository`: GitHub repository URL
- `format`: Documentation format; implemented parser formats are `openref`, `markdown`, `mdx`, `openapi`, `rst`, and `html`. Any other value must stay marked as planned until parser/CLI support exists
- `path`: Path to documentation within repo
- `description`: Brief description
- `hint`: Verification-oriented note for agents and maintainers
- `tested`: Boolean (set to true only after confirming the hint against current upstream sources and implemented parser support)
- `maintainer`: Who maintains the original docs

#### Optional Fields

- `pattern`: Glob pattern for finding files
- `examples`: Array of example files
- `sections`: Array of documentation sections
- `subformat`: Additional format info (e.g., "docc" for markdown)
- `languages`: Supported programming languages
- `versions`: Available versions
- `status`: "planned" if not yet tested
- `note`: Additional information

### 2. Add Format Parsers

To support a new documentation format:

1. Create parser in `src/parsers/yourformat/`
2. Implement Parser interface from `src/parsers/base.ts`
3. Create adapter to convert to unified IR (DocNode)
4. Register parser in `src/core/detector.ts`
5. Add tests
6. Update documentation

Required files:
- `src/parsers/yourformat/parser.ts`: Format-specific parser
- `src/parsers/yourformat/adapter.ts`: Format → IR converter
- `src/parsers/yourformat/index.ts`: Parser wrapper

### 3. Improve Existing Code

- Bug fixes
- Performance improvements
- Better error messages
- Documentation improvements

### 4. Add Tests

- Unit tests for models
- Integration tests for parsers
- End-to-end tests for CLI

## Development Setup

```bash
# Clone repository
git clone https://github.com/Zyepher/llm-docs-generator.git
cd llm-docs-generator

# Install dependencies
npm install

# Run tests
npm test

# Run linter
npm run lint

# Build
npm run build
```

## Code Style

- TypeScript with strict mode enabled
- Biome for linting (`npm run lint`)
- Prettier for formatting
- Zod for validation schemas

Run before committing:
```bash
npm run lint:fix
npm run format
npm run type-check
npm test
```

## Commit Messages

Use clear, descriptive commit messages:
- Present tense ("Add feature" not "Added feature")
- Imperative mood ("Move cursor to..." not "Moves cursor to...")
- Reference issues/PRs when applicable

Examples:
```
Add Python documentation source hint
Fix markdown parser handling of nested lists
Update README with new usage examples
```

## Pull Request Process

1. Fork the repository
2. Create feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Run tests and linters
5. Commit with clear messages
6. Push to your fork
7. Submit pull request

### PR Description Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation source addition
- [ ] Format parser
- [ ] Documentation update

## Testing
- [ ] Tests added/updated
- [ ] Manual testing completed
- [ ] Source hint verified (for hint catalog additions)

## Checklist
- [ ] Code follows project style
- [ ] Tests pass
- [ ] Documentation updated
- [ ] No breaking changes (or documented)
```

## Adding Source Hints - Detailed Guide

### Step 1: Find Candidate Documentation

Identify publicly accessible documentation candidates:
- GitHub repositories with markdown/rst docs
- OpenRef YAML specifications
- DocC documentation

### Step 2: Verify the Hint

Clone or inspect the documentation repository and confirm the current path, format, version, and maintainer. Do not assume `config/known-sources.json` is authoritative.

```bash
# Clone docs repo
git clone https://github.com/org/docs-repo
cd docs-repo

# Verify the hinted docs path and format
find ./docs -maxdepth 2 -type f | head
```

Source-driven generation is supported: once you have the source locally, `llm-docs generate --source <path> --output-dir <dir>` produces a pack you can inspect and `llm-docs verify` against. Use it to sanity-check a hint's format before adding it to the catalog.

### Step 3: Add to Hint Catalog

Edit `config/known-sources.json` and add or update the entry with all required fields.

### Step 4: Update Docs When Needed

Update README.md or other docs only when they describe implemented behavior or clearly labeled planned behavior.

### Step 5: Submit PR

Include in PR description:
- What documentation source was added
- How the hint was verified
- Any special considerations

## Questions?

- Open an issue for questions
- Check existing issues and PRs
- Review README.md and code examples

## Code of Conduct

Be respectful and inclusive. This is a community project for AI coding assistants and the developers who use them.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
