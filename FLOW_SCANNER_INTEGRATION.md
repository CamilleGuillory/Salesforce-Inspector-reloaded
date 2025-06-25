# Flow Scanner Integration

This document describes the integration of the Lightning Flow Scanner Core into the Salesforce Inspector extension.

## Overview

The Flow Scanner integration adds static analysis capabilities to Salesforce Inspector when viewing Flow Builder pages. It provides a button that opens a dedicated flow scanner interface for analyzing Salesforce Flows.

## Features

### Flow Scanner Button
- Appears automatically when on a Flow Builder page (`builder_platform_interaction`)
- Positioned next to the existing flow scrollability controls
- Opens a dedicated flow scanner window

### Flow Scanner Interface
- Modern, responsive UI matching Salesforce Inspector design
- Displays current flow information (name, type, status)
- Performs static analysis using Lightning Flow Scanner Core
- Shows results with severity levels (error, warning, info)
- Export functionality for scan results

### Analysis Capabilities
- **Flow Scanner Core Integration**: Uses the official Lightning Flow Scanner Core library
- **Basic Analysis Fallback**: Provides basic analysis when core is unavailable
- **Multiple Rule Types**: Checks for various flow best practices
- **Export Results**: JSON export with detailed scan information

## Files Added/Modified

### New Files
- `addon/flow-scanner.html` - Flow scanner interface
- `addon/flow-scanner.css` - Styling for flow scanner
- `addon/flow-scanner.js` - Flow scanner functionality
- `addon/flow-scanner-core.js` - Built Flow Scanner Core library

### Modified Files
- `addon/manifest.json` - Added flow scanner resources
- `addon/button.js` - Added flow scanner button functionality

## Usage

1. Navigate to a Flow Builder page in Salesforce
2. Look for the "🔍 Flow Scanner" button in the flow header
3. Click the button to open the flow scanner
4. Click "Scan Flow" to analyze the current flow
5. Review the results and export if needed

## Technical Details

### Flow Detection
The extension detects flow pages by checking for the `builder_platform_interaction` URL pattern and looks for the `builder_platform_interaction-container-common` element.

### Flow Information Extraction
- Flow name: Extracted from page title or header elements
- Flow type: Determined from page content (Auto-launched Flow, Screen Flow, etc.)
- Flow status: Extracted from page content (Active, Draft, Inactive)

### Analysis Engine
- **Primary**: Lightning Flow Scanner Core (comprehensive analysis)
- **Fallback**: Basic analysis rules for common flow issues

### API Integration
Attempts to fetch flow metadata via Salesforce Tooling API when possible, with fallback to page content extraction.

## Dependencies

- Lightning Flow Scanner Core v4.48.0
- Built using Vite for browser compatibility
- No additional external dependencies

## Browser Compatibility

- Chrome 88+ (manifest v3)
- Firefox (manifest v2 compatible)
- Edge (Chromium-based)

## Future Enhancements

- Integration with more Flow Scanner Core rules
- Real-time flow analysis as you build
- Custom rule configuration
- Integration with Salesforce CLI for metadata retrieval
- Support for bulk flow analysis

## Troubleshooting

### Flow Scanner Button Not Appearing
- Ensure you're on a Flow Builder page
- Check browser console for errors
- Verify extension permissions

### Analysis Not Working
- Check if Flow Scanner Core loaded (console log)
- Verify flow information extraction
- Check network requests for API calls

### Export Issues
- Ensure scan has been performed
- Check browser download settings
- Verify file permissions

## Contributing

To enhance the Flow Scanner integration:

1. Update Flow Scanner Core version
2. Add new analysis rules
3. Improve UI/UX
4. Add new export formats
5. Enhance error handling

## License

This integration uses the Lightning Flow Scanner Core under MIT license. 