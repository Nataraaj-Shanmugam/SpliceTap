# Contributing to TurboMock

Thank you for your interest in contributing to TurboMock! This document provides guidelines and information for contributors.

## 🚀 Getting Started

### Prerequisites
- Node.js 16+ (for development scripts)
- Chrome/Chromium browser for testing
- Basic knowledge of JavaScript, HTML, and CSS
- Familiarity with Chrome Extension APIs

### Development Setup
1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/turbomock-extension.git`
3. Navigate to the project: `cd turbomock-extension`
4. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the project directory

## 📋 Development Guidelines

### Code Style
- Use ES6+ features when possible
- Follow consistent naming conventions (camelCase for variables, PascalCase for classes)
- Use meaningful variable and function names
- Add JSDoc comments for public functions
- Keep functions small and focused (single responsibility)

### File Structure
- **src/**: Shared utilities and common code
- **service_worker/**: Background scripts and service worker
- **popup/**: Extension popup UI and logic
- **content/**: Content scripts for page injection
- **options/**: Settings and options page
- **assets/**: Icons, images, and static files
- **tests/**: Test files and test utilities

### Manifest V3 Compliance
- Use service workers instead of background pages
- Use declarativeNetRequest for request interception
- Avoid inline scripts and styles (CSP compliance)
- Use chrome.storage APIs for data persistence

## 🧪 Testing

### Running Tests
```bash
# Run all tests
npm test

# Run specific test file
node tests/test-extension.js

# Validate manifest
npm run validate
```

### Test Requirements
- All new features must include tests
- Tests should cover both success and error cases
- Performance-critical code should include performance tests
- UI changes should include accessibility tests

### Test Categories
1. **Unit Tests**: Test individual functions and utilities
2. **Integration Tests**: Test component interactions
3. **Extension Tests**: Test extension lifecycle and APIs
4. **Performance Tests**: Test response times and memory usage

## 🔧 Making Changes

### Before You Start
1. Check existing issues to avoid duplicate work
2. Create an issue for discussion if adding major features
3. Ensure your development environment is set up correctly

### Development Process
1. Create a feature branch: `git checkout -b feature/your-feature-name`
2. Make your changes following the code style guidelines
3. Add or update tests as needed
4. Test your changes thoroughly
5. Update documentation if necessary
6. Commit with clear, descriptive messages

### Commit Message Format
```
type(scope): brief description

Longer description if needed

Fixes #issue-number
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

### Pull Request Process
1. Ensure all tests pass
2. Update README.md if needed
3. Update CHANGELOG.md with your changes
4. Create a pull request with:
   - Clear title and description
   - Reference to related issues
   - Screenshots for UI changes
   - Testing instructions

## 🐛 Bug Reports

### Before Reporting
- Search existing issues for duplicates
- Test with the latest version
- Try to reproduce the issue consistently

### Bug Report Template
```markdown
**Bug Description**
A clear description of what the bug is.

**Steps to Reproduce**
1. Go to '...'
2. Click on '....'
3. See error

**Expected Behavior**
What you expected to happen.

**Screenshots**
If applicable, add screenshots.

**Environment**
- Browser: [Chrome/Firefox/Edge]
- Version: [Browser version]
- Extension Version: [Extension version]
- OS: [Windows/Mac/Linux]

**Additional Context**
Any other context about the problem.
```

## 🚀 Feature Requests

### Before Requesting
- Check if the feature already exists
- Search existing feature requests
- Consider if the feature fits the project scope

### Feature Request Template
```markdown
**Feature Description**
A clear description of what you want to happen.

**Use Case**
Describe the problem this feature would solve.

**Proposed Solution**
Describe the solution you'd like.

**Alternatives Considered**
Other solutions you've considered.

**Additional Context**
Any other context, mockups, or examples.
```

## 📚 Documentation

### Documentation Guidelines
- Keep documentation up to date with code changes
- Use clear, concise language
- Include code examples where helpful
- Add screenshots for UI features

### Areas to Document
- New features and their usage
- API changes and breaking changes
- Configuration options
- Troubleshooting guides

## 🔐 Security

### Security Guidelines
- Never commit API keys or sensitive data
- Follow principle of least privilege for permissions
- Validate all user inputs
- Use CSP-compliant code only
- Report security issues privately

### Reporting Security Issues
Email security@turbomock.com with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fixes (if any)

## 📄 License

By contributing to TurboMock, you agree that your contributions will be licensed under the MIT License.

## 🤝 Code of Conduct

### Our Standards
- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow
- Maintain a positive environment

### Unacceptable Behavior
- Harassment or discrimination
- Trolling or inflammatory comments
- Personal attacks
- Publishing private information

### Enforcement
Report violations to conduct@turbomock.com. All reports will be reviewed and investigated.

## 🙋 Getting Help

### Resources
- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API)

### Community
- GitHub Discussions for questions and ideas
- GitHub Issues for bugs and feature requests
- Email support@turbomock.com for general inquiries

## 🎉 Recognition

Contributors are recognized in:
- CONTRIBUTORS.md file
- Release notes for significant contributions
- Extension credits in the options page

Thank you for contributing to TurboMock! 🎭