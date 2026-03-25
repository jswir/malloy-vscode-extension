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
import {CellData, Cell, FileHandler} from '../../common/types/file_handler';

/**
 * Transforms vscode-notebook-cell: Uris to file: or vscode-vfs: URLS
 * based on the workspace, because VS Code can't use a vscode-notebook-cell:
 * as a relative url for non-cells, like external Malloy files.
 *
 * @param uri Document uri
 * @returns Uri with an appropriate protocol
 */
const fixNotebookUri = (uri: vscode.Uri) => {
  if (uri.scheme === 'vscode-notebook-cell') {
    const {scheme} = vscode.workspace.workspaceFolders?.[0].uri || {
      scheme: 'file:',
    };
    const {authority, path, query} = uri;
    uri = vscode.Uri.from({
      scheme,
      authority,
      path,
      query,
    });
  }

  return uri;
};

/**
 * Fetches the text contents of a Uri for the Malloy compiler. For most Uri
 * types this means either from the open file cache, or from VS Code's
 * file system.
 *
 *
 * @param uriString Uri to fetch
 * @returns Text contents for Uri
 */
export async function fetchFile(uriString: string): Promise<string> {
  const uri = vscode.Uri.parse(uriString);
  const openFiles = vscode.workspace.textDocuments;
  if (['http', 'https'].includes(uri.scheme)) {
    const response = await fetch(uriString);
    if (response.status >= 200 && response.status < 300) {
      return response.text();
    } else {
      throw new Error(`Unable to fetch ${uriString}: ${response.statusText}`);
    }
  }

  const openDocument = openFiles.find(
    document => document.uri.toString() === uriString
  );
  // Only get the text from VSCode's open files if the file is already open in VSCode,
  // otherwise, just read the file from the file system
  if (openDocument !== undefined) {
    return openDocument.getText();
  } else {
    const contents = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(contents);
  }
}

export async function fetchBinaryFile(uriString: string): Promise<Uint8Array> {
  const uri = fixNotebookUri(vscode.Uri.parse(uriString));
  if (['http', 'https'].includes(uri.scheme)) {
    const response = await fetch(uriString);
    if (response.status >= 200 && response.status < 300) {
      const body = await response.blob();
      const binary = await body.arrayBuffer();
      return new Uint8Array(binary);
    } else {
      throw new Error(`Unable to fetch ${uriString}: ${response.statusText}`);
    }
  }

  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    console.error(error);
  }
  throw new Error(`fetchBinaryFile: Unable to fetch '${uriString}'`);
}

/**
 * Computes line offsets for each code cell from the live NotebookDocument,
 * mirroring the serializer's output format so offsets stay correct even
 * when the notebook has unsaved edits.
 *
 * Returns a map from code-cell index to the 0-based line where that
 * cell's content starts in the serialized file.
 */
function computeLiveLineOffsets(
  notebook: vscode.NotebookDocument
): Map<number, number> {
  const offsets = new Map<number, number>();
  const metadata = notebook.metadata as {initialComments?: string} | undefined;

  let currentLine = 0;
  let endsWithNewline = true;
  let hasContent = false;

  const initialComments = metadata?.initialComments;
  if (initialComments && initialComments.length > 0) {
    const newlineCount = (initialComments.match(/\n/g) || []).length;
    currentLine += newlineCount;
    endsWithNewline = initialComments.endsWith('\n');
    hasContent = true;
  }

  let codeCellIndex = 0;
  for (const cell of notebook.getCells()) {
    if (hasContent && !endsWithNewline) {
      currentLine += 1;
    }

    // >>>TYPE\n separator occupies one line; content starts on the next
    currentLine += 1;

    if (cell.kind === vscode.NotebookCellKind.Code) {
      offsets.set(codeCellIndex, currentLine);
      codeCellIndex++;
    }

    const value = cell.document.getText();
    if (value) {
      const newlineCount = (value.match(/\n/g) || []).length;
      currentLine += newlineCount;
      endsWithNewline = value.endsWith('\n');
    } else {
      currentLine += 1;
      endsWithNewline = true;
    }
    hasContent = true;
  }

  return offsets;
}

export async function fetchCellData(uriString: string): Promise<CellData> {
  const uri = vscode.Uri.parse(uriString);
  const notebook = vscode.workspace.notebookDocuments.find(
    notebook => notebook.uri.path === uri.path
  );
  const result: CellData = {
    baseUri: uriString,
    cells: [],
  };

  if (notebook) {
    result.baseUri = notebook.uri.toString();
    if (notebook.uri.scheme === 'untitled') {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        result.baseUri = workspaceFolder.uri.toString() + '/';
      }
    }

    const lineOffsets = computeLiveLineOffsets(notebook);

    let codeCellIndex = 0;

    for (const cell of notebook.getCells()) {
      if (cell.kind === vscode.NotebookCellKind.Code) {
        const cellData: Cell = {
          uri: cell.document.uri.toString(),
          text: cell.document.getText(),
          languageId: cell.document.languageId,
          metadata: cell.metadata,
          lineOffset: lineOffsets.get(codeCellIndex) ?? 0,
        };
        result.cells.push(cellData);
        codeCellIndex++;
      }
      if (cell.document.uri.fragment === uri.fragment) {
        break;
      }
    }
  }
  return result;
}

export function fetchWorkspaceFolders(_uriString: string): string[] {
  return (
    vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ||
    []
  );
}

export class ClientFileHandler implements FileHandler {
  /**
   * Requests a file from the worker's controller. Although the
   * file path is a file system path, reading the file off
   * disk doesn't take into account unsaved changes that only
   * VS Code is aware of.
   *
   * @param uri URI to resolve
   * @returns File contents
   */
  async fetchFile(uri: string): Promise<string> {
    return fetchFile(uri);
  }

  /**
   * Requests a binary file from the worker's controller.
   *
   * @param uri URI to resolve
   * @returns File contents
   */

  async fetchBinaryFile(uri: string): Promise<Uint8Array> {
    return fetchBinaryFile(uri);
  }

  /**
   * Requests a set of cell data from the worker's controller.
   *
   * @param uri URI to resolve
   * @returns File contents
   */
  async fetchCellData(uri: string): Promise<CellData> {
    return fetchCellData(uri);
  }

  /**
   * Requests workspace directories from the worker's controller.
   *
   * @param uri URI to resolve
   * @returns workspace directories as an array of URI strings
   */
  async fetchWorkspaceFolders(uri: string): Promise<string[]> {
    return fetchWorkspaceFolders(uri);
  }

  async readURL(url: URL): Promise<string> {
    return this.fetchFile(url.toString());
  }
}

export const fileHandler = new ClientFileHandler();
