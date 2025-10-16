# Contributing to llm-docs-generator

Thank you for your interest in contributing! This project is designed to be a community-driven registry of documentation sources for AI coding assistants.

## Ways to Contribute

### 1. Add New Documentation Sources to the Registry

The most valuable contribution is adding new documentation sources to `config/known-sources.json`.

#### Requirements

- Documentation must be publicly accessible
- Format must be supported (openref, markdown, rst) or you provide a parser
- Successfully test generation before submitting
- Include usage example

#### Process

1. Fork the repository
2. Add entry to `config/known-sources.json`
3. Test generation with your source
4. Update `tested: true` if successful
5. Add entry to README.md Known Sources table (if tested)
6. Submit pull request

#### Registry Entry Format

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
  "usage": "llm-docs generate --source path/to/docs",
  "tested": false,
  "maintainer": "Organization or Individual"
}
```

#### Required Fields

- `id`: Unique identifier (lowercase, hyphens)
- `name`: Display name
- `repository`: GitHub repository URL
- `format`: Documentation format
- `path`: Path to documentation within repo
- `description`: Brief description
- `usage`: Command to generate docs
- `tested`: Boolean (set to true only after successful test)
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
- ESLint configuration provided
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
Add Python documentation to known sources
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
- [ ] Generation tested (for registry additions)

## Checklist
- [ ] Code follows project style
- [ ] Tests pass
- [ ] Documentation updated
- [ ] No breaking changes (or documented)
```

## Adding Documentation Sources - Detailed Guide

### Step 1: Find Documentation Source

Identify publicly accessible documentation:
- GitHub repositories with markdown/rst docs
- OpenRef YAML specifications
- DocC documentation

### Step 2: Test Locally

Clone the documentation repository and test generation:

```bash
# Clone docs repo
git clone https://github.com/org/docs-repo
cd docs-repo

# Test generation
npx tsx /path/to/llm-docs-generator/src/cli.ts generate --source ./docs --format markdown

# Check output
ls ./output/
cat ./output/*-full-llms.txt
```

### Step 3: Add to Registry

Edit `config/known-sources.json` and add entry with all required fields.

### Step 4: Update README (if tested successfully)

Add row to README.md Known Documentation Sources table:

```markdown
| **Project Name** | Format | [`/path`](https://github.com/...) | ✅ Tested | Notes |
```

### Step 5: Submit PR

Include in PR description:
- What documentation source was added
- Screenshot or sample of generated output
- Confirmation that generation succeeded
- Any special considerations

## Questions?

- Open an issue for questions
- Check existing issues and PRs
- Review README.md and code examples

## Code of Conduct

Be respectful and inclusive. This is a community project for AI coding assistants and the developers who use them.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
