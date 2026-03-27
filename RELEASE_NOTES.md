# ProWorkbench v0.1.2

## Highlights
- Fixed Alex Factory Reset so it clears user conversations, memory data, session state, and temporary workspace artifacts without deleting MCP servers, tool registrations, provider settings, or the memory system itself.
- Factory Reset now returns auth to first-run setup by clearing the stored admin password and active admin tokens while keeping the app functional after reset.
- Added a standardized desktop release pipeline for Linux, Windows, and macOS with normalized artifact names staged into `release/`.

## Packaging
- Linux artifacts: `proworkbench-v0.1.2-linux.AppImage` and `proworkbench-v0.1.2-linux.deb`
- Windows artifact: `proworkbench-v0.1.2-windows.exe`
- macOS artifact: `proworkbench-v0.1.2-macos.dmg`

## Verification
- `node --test server/src/http/factoryReset.test.js`
- `npm run release:build:linux`
- Tagged releases now build installers on GitHub Actions for Ubuntu, Windows, and macOS runners.

## Manual follow-up
- macOS signing and notarization still require Apple credentials on the GitHub runner or a post-build notarization step.
- Windows code signing remains optional but recommended before public distribution.
