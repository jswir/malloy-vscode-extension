# Workspace Diagnostics Implementation

This document describes the LSP 3.17 workspace diagnostics feature added to the Malloy VS Code extension.

## Problem

The Malloy extension only showed errors for **open files**. AI coding assistants (like Cursor) couldn't see compilation errors in files they hadn't opened, making it difficult to catch errors across a project.

## Solution

Implemented LSP 3.17 **pull-based workspace diagnostics**, which allows the server to provide diagnostics for all workspace files, not just open ones.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         VS Code Client                          │
├─────────────────────────────────────────────────────────────────┤
│  extension_node.ts / extension_browser.ts                       │
│    - Configures LanguageClient with diagnosticPullOptions       │
│    - Calls createWorkspaceWatcher()                             │
│                                                                 │
│  workspace_indexer.ts (NEW)                                     │
│    - Watches for .malloy/.malloysql/.malloynb file changes      │
│    - Sends workspace/diagnostic/refresh on changes              │
│                                                                 │
│  subscriptions.ts                                               │
│    - Handles malloy/getWorkspaceFiles request                   │
│    - Returns list of workspace Malloy files                     │
│    - Respects maxFilesToIndex and enableWorkspaceDiagnostics    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ LSP 3.17
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Language Server                           │
├─────────────────────────────────────────────────────────────────┤
│  init.ts                                                        │
│    - Advertises diagnosticProvider capability                   │
│    - Handles workspace/diagnostic request                       │
│    - Requests file list via malloy/getWorkspaceFiles            │
│    - Returns diagnostics for each file                          │
└─────────────────────────────────────────────────────────────────┘
```

## Files Changed

| File | Changes |
|------|---------|
| `package.json` | Added `malloy.enableWorkspaceDiagnostics` and `malloy.maxFilesToIndex` settings |
| `src/extension/node/extension_node.ts` | Added `malloy-notebook` to document selector, `diagnosticPullOptions`, workspace watcher |
| `src/extension/browser/extension_browser.ts` | Added `diagnosticPullOptions`, workspace watcher |
| `src/extension/subscriptions.ts` | Added `malloy/getWorkspaceFiles` request handler |
| `src/extension/workspace_indexer.ts` | **NEW** - File watcher for diagnostic refresh |
| `src/server/init.ts` | Added `diagnosticProvider` capability and `workspace/diagnostic` handler |
| `README.md` | Added user-facing documentation |

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `malloy.enableWorkspaceDiagnostics` | boolean | `true` | Enable/disable workspace-wide diagnostics |
| `malloy.maxFilesToIndex` | number | `100` | Max files to check (0 = unlimited, sorted by mtime) |

## Current Status

⚠️ **Partially Implemented**: The workspace diagnostic handler currently returns **empty diagnostics**. The full diagnostic computation logic (`computeDiagnosticsForUri`) is commented out in `init.ts` due to server loading issues during development.

To complete the implementation:
1. Uncomment `computeDiagnosticsForUri` in `src/server/init.ts`
2. Call it for each file in the `workspace/diagnostic` handler
3. Test that the server loads correctly

## How It Works

1. **On startup**: VS Code client configures `diagnosticPullOptions` to enable pull diagnostics
2. **Server advertises**: `diagnosticProvider.workspaceDiagnostics: true`
3. **Client requests**: `workspace/diagnostic` 
4. **Server requests**: `malloy/getWorkspaceFiles` to get file list from client
5. **Server computes**: Diagnostics for each file and returns them
6. **On file change**: `workspace_indexer.ts` sends `workspace/diagnostic/refresh` notification

## File Types Supported

- `.malloy` - Malloy source files
- `.malloysql` - Malloy SQL files  
- `.malloynb` - Malloy notebook files
