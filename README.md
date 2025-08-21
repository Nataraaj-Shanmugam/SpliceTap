# 🎭 TurboMock - API Mocker Browser Extension

Mock any API in 30 seconds, directly in your browser. Perfect for frontend development and testing.

## ✨ Features

- **Quick API Mocking**: Create mock responses for any API endpoint in seconds
- **Pattern Matching**: Support for wildcards, regex, and exact URL matching
- **Comprehensive Testing**: Built-in rule validation and testing system
- **Dark/Light Theme**: Automatic theme detection or manual selection
- **Import/Export**: Backup and share your mock rules
- **DevTools Integration**: Monitor intercepted requests in Chrome DevTools
- **Keyboard Shortcuts**: Quick access with customizable shortcuts
- **Context Menu**: Right-click on any page to create rules
- **Response Delays**: Simulate network latency and slow responses
- **Multiple Methods**: Support for GET, POST, PUT, DELETE, PATCH requests

## 🚀 Quick Start

### Installation

#### For Development:
1. Clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension directory
5. The TurboMock icon should appear in your toolbar

#### For Production:
- Install from Chrome Web Store (coming soon)
- Install from Firefox Add-ons (coming soon)

### Basic Usage

1. **Create Your First Rule**:
   - Click the TurboMock icon in your toolbar
   - Click "New Rule" or right-click on any page and select "Mock this Request"
   - Configure your mock response
   - Save and test!

2. **Rule Configuration**:
   - **Name**: Descriptive name for your rule
   - **Method**: HTTP method (GET, POST, etc.)
   - **URL Pattern**: Use wildcards like `*/api/users/*` or regex `/api/users/\d+/`
   - **Status Code**: Response status (200, 404, 500, etc.)
   - **Headers**: Custom response headers (JSON format)
   - **Body**: Response body (JSON format)
   - **Delay**: Simulate network delay in milliseconds

3. **Testing Rules**:
   - Use the "Test" button to validate your rules
   - Use "Test All" to validate all enabled rules
   - Check the status indicators: ✅ (passed), ❌ (failed), ⚠️ (warning), 🔄 (pending)

## 📋 URL Pattern Examples

```
# Wildcard patterns
*/api/users/*          # Matches any URL containing /api/users/
*/api/*/profile        # Matches /api/v1/profile, /api/v2/profile, etc.

# Exact matches
https://api.example.com/users  # Matches exactly this URL

# Regex patterns (wrapped in forward slashes)
/api/users/\d+/        # Matches /api/users/123/, /api/users/456/, etc.
/api/(users|accounts)/ # Matches /api/users/ or /api/accounts/
```

## 🎨 Mock Response Examples

### Success Response
```json
{
  "success": true,
  "data": {
    "id": 123,
    "name": "John Doe",
    "email": "john@example.com"
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### Error Response
```json
{
  "error": "User not found",
  "code": "USER_NOT_FOUND",
  "status": 404,
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### Paginated Response
```json
{
  "data": [
    {"id": 1, "name": "Item 1"},
    {"id": 2, "name": "Item 2"}
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "hasNext": true
  }
}
```

## ⌨️ Keyboard Shortcuts

- `Ctrl+Shift+M` (Cmd+Shift+M on Mac): Toggle extension on/off
- `Ctrl+Shift+N` (Cmd+Shift+N on Mac): Create new rule
- `Ctrl+N`: Create new rule (in popup)
- `Ctrl+F`: Focus search box (in popup)
- `Ctrl+T`: Test all rules (in popup)
- `Ctrl+R`: Refresh data (in popup)
- `Escape`: Close popup

## 🛠️ Advanced Features

### Rule Templates
TurboMock includes several built-in templates:
- **Success Response**: Standard 200 OK response
- **Error Response**: 500 Internal Server Error
- **Not Found**: 404 Not Found response
- **Unauthorized**: 401 Unauthorized response
- **Delayed Response**: Response with network delay

### Import/Export
- Export your rules as JSON files for backup or sharing
- Import rules from JSON files
- Automatic rule validation during import
- Merge or replace existing rules

### Testing & Validation
- **URL Pattern Testing**: Validates regex and wildcard patterns
- **JSON Validation**: Ensures response bodies are valid JSON
- **Header Validation**: Checks header format and values
- **Status Code Validation**: Ensures valid HTTP status codes
- **Performance Testing**: Measures rule matching performance

## 🔧 Technical Details

### Architecture
- **Manifest V3**: Modern extension architecture for better security
- **Service Worker**: Background processing for request interception
- **Content Scripts**: Page injection for rule editor and monitoring
- **DeclarativeNetRequest**: Chrome's modern request interception API
- **Chrome Storage**: Persistent rule and settings storage

### Browser Compatibility
- **Chrome**: 120+ (full support)
- **Edge**: 120+ (full support)
- **Firefox**: 109+ (partial support, some features limited)
- **Safari**: Not supported (WebExtensions API limitations)

### Privacy & Security
- **Local Storage Only**: All data stored locally on your device
- **No Data Collection**: No analytics, tracking, or data sharing
- **Request Privacy**: Only intercepts matching requests, never logs content
- **CSP Compliant**: Follows Content Security Policy best practices
- **Minimal Permissions**: Only requests necessary permissions

### Performance
- **Rule Matching**: < 10ms per request
- **Memory Usage**: < 50MB typical usage
- **Storage Limit**: 10MB local storage (thousands of rules)
- **Background Processing**: Minimal CPU usage when idle

## 📊 Data Management

### Storage Structure
```javascript
{
  "turboMockRules": [
    {
      "id": "rule_123456789",
      "name": "User Profile API",
      "enabled": true,
      "created": "2024-01-01T00:00:00Z",
      "lastModified": "2024-01-01T00:00:00Z",
      "match": {
        "method": "GET",
        "url": "*/api/users/*",
        "headers": {}
      },
      "response": {
        "statusCode": 200,
        "statusText": "OK",
        "headers": {"Content-Type": "application/json"},
        "body": {"id": 123, "name": "John Doe"},
        "delay": 0
      },
      "testStatus": "passed",
      "hitCount": 42
    }
  ],
  "turboMockActive": true,
  "turboMockStats": {
    "intercepted": 156,
    "rulesCount": 12,
    "lastUpdated": "2024-01-01T00:00:00Z"
  },
  "turboMockSettings": {
    "theme": "auto",
    "notifications": true,
    "autoBackup": true,
    "debugMode": false
  }
}
```

### Backup & Restore
- **Auto Backup**: Optional automatic backups to user folder
- **Manual Backup**: Export rules with metadata
- **Restore**: Import from backup files with validation
- **Migration**: Automatic data migration between versions

## 🧪 Testing

### Rule Testing
Each rule can be tested individually or as part of a batch:
- URL pattern validation
- JSON syntax checking
- HTTP status code validation
- Header format verification
- Response body structure validation

### Integration Testing
- Extension lifecycle testing
- Cross-browser compatibility testing
- Performance benchmarking
- Memory usage monitoring

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup
```bash
# Clone the repository
git clone https://github.com/turbomock/browser-extension.git
cd browser-extension

# Load in Chrome for development
# 1. Open chrome://extensions/
# 2. Enable Developer mode
# 3. Click "Load unpacked"
# 4. Select the extension directory
```

### Project Structure
```
turbomock-extension/
├── manifest.json           # Extension manifest
├── assets/                 # Icons and static assets
├── src/                   # Shared utilities
│   ├── utils.js          # Utility functions
│   └── storage.js        # Storage management
├── service_worker/       # Background scripts
│   └── background.js     # Main service worker
├── popup/               # Extension popup
│   ├── popup.html       # Popup UI
│   ├── popup.js         # Popup logic
│   └── popup.css        # Popup styles
├── content/             # Content scripts
│   └── content.js       # Page injection
├── options/             # Settings page
│   ├── options.html     # Settings UI
│   ├── options.js       # Settings logic
│   └── options.css      # Settings styles
├── devtools/            # DevTools integration
│   ├── devtools.html    # DevTools entry
│   └── panel.html       # DevTools panel
└── tests/               # Test suite
    ├── unit/           # Unit tests
    └── integration/    # Integration tests
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with modern web technologies and Chrome Extension APIs
- Inspired by the need for quick and easy API mocking during development
- Thanks to all contributors and users who provide feedback and suggestions

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/turbomock/browser-extension/issues)
- **Discussions**: [GitHub Discussions](https://github.com/turbomock/browser-extension/discussions)
- **Email**: support@turbomock.com

---

Made with ❤️ by the TurboMock team