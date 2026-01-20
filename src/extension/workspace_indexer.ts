/*
 * Copyright 2023 Google LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files
 * (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import * as vscode from 'vscode';
import {BaseLanguageClient} from 'vscode-languageclient';
import {malloyLog} from './logger';
import debounce from 'lodash/debounce';

/**
 * Create a file system watcher to track changes to Malloy files.
 * When files change, triggers LSP 3.17 workspace/diagnostic refresh
 * so the server re-computes diagnostics for all workspace files.
 */
export function createWorkspaceWatcher(
  context: vscode.ExtensionContext,
  client: BaseLanguageClient
): vscode.FileSystemWatcher {
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{malloy,malloysql,malloynb}'
  );

  // Debounced function to request diagnostic refresh
  // This batches rapid file changes to avoid excessive server load
  const refreshDiagnostics = debounce(() => {
    malloyLog.appendLine('Workspace watcher: Triggering diagnostic refresh');
    // LSP 3.17: Request the server to refresh workspace diagnostics
    client.sendNotification('workspace/diagnostic/refresh');
  }, 500);

  // When a new Malloy file is created, refresh diagnostics
  watcher.onDidCreate(uri => {
    malloyLog.appendLine(`Workspace watcher: New file created ${uri.fsPath}`);
    refreshDiagnostics();
  });

  // When a Malloy file is deleted, refresh diagnostics
  watcher.onDidDelete(uri => {
    malloyLog.appendLine(`Workspace watcher: File deleted ${uri.fsPath}`);
    refreshDiagnostics();
  });

  // When a Malloy file changes on disk (external edit), refresh diagnostics
  // Note: Changes made in VS Code are handled by the normal LSP textDocument sync
  watcher.onDidChange(uri => {
    // Check if the document is already open in VS Code - if so, LSP handles it
    const openDoc = vscode.workspace.textDocuments.find(
      doc => doc.uri.toString() === uri.toString()
    );
    if (openDoc) {
      return; // Already handled by normal LSP flow
    }

    malloyLog.appendLine(
      `Workspace watcher: Closed file changed ${uri.fsPath}`
    );
    refreshDiagnostics();
  });

  context.subscriptions.push(watcher);
  return watcher;
}
