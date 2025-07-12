# How to Build flow-scanner-core.js for Salesforce Inspector

**Run this script from the root of [`lightning-flow-scanner-core`](https://github.com/Lightning-Flow-Scanner/lightning-flow-scanner-core) — not from the Chrome extension repo.**

## Quick Steps

1. **Clone and enter the core repo:**
   ```sh
   git clone https://github.com/Lightning-Flow-Scanner/lightning-flow-scanner-core.git
   cd lightning-flow-scanner-core
   ```
2. **Build the core file:**
   ```sh
   node scripts/build-flow-scanner.js
   ```
   - This creates `flow-scanner-core.js` in the core repo root.
3. **Move this file to the Salesforce Inspector Reloaded addon directory:**
   ```sh
   cp flow-scanner-core.js /path/to/Salesforce-Inspector-reloaded/addon/lib/flow-scanner-core.js
   ```

### Version Injection

- The build script reads the version from `package.json`