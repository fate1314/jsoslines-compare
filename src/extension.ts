import * as vscode from 'vscode';

type Side = 'left' | 'right';

interface CompareState {
  leftLines: string[];
  rightLines: string[];
  leftLabel?: string;
  rightLabel?: string;
  currentIndex: number;
}

interface ParsedLine {
  raw: string;
  pretty: string;
  error?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('jsonlCompare.open', () => {
    const panel = vscode.window.createWebviewPanel(
      'jsonlCompare',
      'JSONLines Compare',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const state: CompareState = {
      leftLines: [],
      rightLines: [],
      leftLabel: undefined,
      rightLabel: undefined,
      currentIndex: 0
    };

    const monacoBaseUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'monaco-editor', 'min', 'vs')
    );
    panel.webview.html = getWebviewHtml(panel.webview, monacoBaseUri.toString());

    const syncWebview = (): void => {
      panel.webview.postMessage({
        type: 'state',
        payload: buildViewModel(state)
      });
    };

    panel.webview.onDidReceiveMessage(async (message: any) => {
      switch (message?.type) {
        case 'pickFile': {
          const side = message.side as Side;
          await pickAndLoadFile(side, state);
          syncWebview();
          break;
        }
        case 'dropFileContent': {
          const side = message.side as Side;
          const fileName = String(message.fileName ?? 'dropped file');
          const content = String(message.content ?? '');
          loadFromText(side, content, fileName, state);
          syncWebview();
          break;
        }
        case 'dropFilePath': {
          const side = message.side as Side;
          const rawPath = String(message.path ?? '');
          await loadFromDroppedPath(side, rawPath, state);
          syncWebview();
          break;
        }
        case 'navigate': {
          const direction = message.direction as 'next' | 'prev';
          navigate(direction, state);
          syncWebview();
          break;
        }
        case 'jumpTo': {
          const index = Number(message.index);
          if (Number.isInteger(index)) {
            jumpTo(index, state);
            syncWebview();
          }
          break;
        }
        case 'searchSide': {
          const side = message.side as Side;
          const query = String(message.query ?? '').trim();
          const found = searchNextOnSide(side, query, state);
          syncWebview();
          if (!found) {
            vscode.window.showInformationMessage(`No more matches on ${side}: ${query}`);
          }
          break;
        }
        default:
          break;
      }
    });

    syncWebview();
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // no-op
}

async function pickAndLoadFile(side: Side, state: CompareState): Promise<void> {
  const result = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    filters: {
      JSON: ['json', 'jsonl', 'jsonlines', 'txt'],
      All: ['*']
    },
    openLabel: `Load ${side} file`
  });

  if (!result || result.length === 0) {
    return;
  }

  const uri = result[0];
  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = new TextDecoder('utf-8').decode(bytes);
  loadFromText(side, content, uri.fsPath, state);
}

async function loadFromDroppedPath(side: Side, rawPath: string, state: CompareState): Promise<void> {
  const fileUri = tryParseDroppedFileUri(rawPath);
  if (!fileUri) {
    vscode.window.showWarningMessage('Dropped item is not a valid local file path.');
    return;
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const content = new TextDecoder('utf-8').decode(bytes);
    loadFromText(side, content, fileUri.fsPath, state);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to load dropped file: ${reason}`);
  }
}

function tryParseDroppedFileUri(rawPath: string): vscode.Uri | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return undefined;
  }

  const firstLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));

  if (!firstLine) {
    return undefined;
  }

  if (firstLine.startsWith('file://')) {
    try {
      return vscode.Uri.parse(firstLine);
    } catch {
      return undefined;
    }
  }

  return vscode.Uri.file(firstLine);
}

function loadFromText(side: Side, content: string, label: string, state: CompareState): void {
  const lines = parseJsonEntries(content);

  if (side === 'left') {
    state.leftLines = lines;
    state.leftLabel = label;
  } else {
    state.rightLines = lines;
    state.rightLabel = label;
  }

  const maxIndex = getMaxIndex(state);
  if (state.currentIndex > maxIndex) {
    state.currentIndex = Math.max(0, maxIndex);
  }
}

function parseJsonEntries(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.map((entry) => JSON.stringify(entry));
  } catch {
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
  }
}

function navigate(direction: 'next' | 'prev', state: CompareState): void {
  const maxIndex = getMaxIndex(state);
  if (maxIndex < 0) {
    return;
  }

  if (direction === 'next') {
    state.currentIndex = Math.min(maxIndex, state.currentIndex + 1);
  } else {
    state.currentIndex = Math.max(0, state.currentIndex - 1);
  }
}

function jumpTo(index: number, state: CompareState): void {
  const maxIndex = getMaxIndex(state);
  if (maxIndex < 0) {
    return;
  }
  state.currentIndex = Math.max(0, Math.min(maxIndex, index));
}

function searchNextOnSide(side: Side, query: string, state: CompareState): boolean {
  if (!query) {
    return false;
  }

  const maxIndex = getMaxIndex(state);
  if (maxIndex < 0) {
    return false;
  }

  const lower = query.toLowerCase();
  for (let i = state.currentIndex + 1; i <= maxIndex; i++) {
    const raw = side === 'left' ? state.leftLines[i] : state.rightLines[i];
    const text = String(raw ?? '').toLowerCase();
    if (text.includes(lower)) {
      state.currentIndex = i;
      return true;
    }
  }

  return false;
}

function getMaxIndex(state: CompareState): number {
  return Math.max(state.leftLines.length, state.rightLines.length) - 1;
}

function parseCurrent(lines: string[], index: number): ParsedLine {
  const raw = lines[index] ?? '';
  if (!raw) {
    return {
      raw: '',
      pretty: ''
    };
  }

  try {
    const obj = JSON.parse(raw);
    return {
      raw,
      pretty: JSON.stringify(obj, null, 2)
    };
  } catch (error) {
    return {
      raw,
      pretty: raw,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  /*
  return {
    raw,
    pretty: raw
  };
  */
}

function buildViewModel(state: CompareState): any {
  const maxIndex = getMaxIndex(state);
  const leftCurrent = parseCurrent(state.leftLines, state.currentIndex);
  const rightCurrent = parseCurrent(state.rightLines, state.currentIndex);

  return {
    currentIndex: state.currentIndex,
    maxIndex,
    hasBoth: state.leftLines.length > 0 && state.rightLines.length > 0,
    left: {
      label: state.leftLabel ?? 'Not loaded',
      totalLines: state.leftLines.length,
      current: leftCurrent
    },
    right: {
      label: state.rightLabel ?? 'Not loaded',
      totalLines: state.rightLines.length,
      current: rightCurrent
    }
  };
}

function getWebviewHtml(webview: vscode.Webview, monacoBaseUri: string): string {
  const nonce = String(Date.now());
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'unsafe-eval' ${webview.cspSource}`,
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    `font-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource}`,
    'worker-src blob: data:',
    "img-src data:"
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>JSONLines Compare</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --card: #252526;
      --text: #d4d4d4;
      --muted: #999;
      --accent: #4fc1ff;
      --danger: #f48771;
      --border: #3c3c3c;
      --keyword: #569cd6;
      --string: #ce9178;
      --number: #b5cea8;
      --boolean: #569cd6;
      --null: #569cd6;
      --property: #9cdcfe;
      --code-bg: #1b1b1c;
      --toolbar: rgba(37, 37, 38, 0.9);
      --body-gradient: radial-gradient(circle at top, #2a2d35 0%, #1e1e1e 60%);
      --json-font-size: 13px;
    }

    body[data-theme='light'] {
      --bg: #f3f6fb;
      --card: #ffffff;
      --text: #1f2328;
      --muted: #5f6875;
      --accent: #0a66c2;
      --danger: #b42318;
      --border: #d0d7de;
      --keyword: #0a3069;
      --string: #0a6c2f;
      --number: #7c4d00;
      --boolean: #8250df;
      --null: #8250df;
      --property: #0550ae;
      --code-bg: #f6f8fa;
      --toolbar: rgba(255, 255, 255, 0.92);
      --body-gradient: radial-gradient(circle at top, #eef4ff 0%, #f3f6fb 60%);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: var(--vscode-editor-font-family), Consolas, 'Courier New', monospace;
      background: var(--body-gradient);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      background: var(--toolbar);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      align-items: center;
    }

    button, input {
      background: var(--card);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font: inherit;
    }

    button {
      cursor: pointer;
    }

    button:hover {
      border-color: var(--accent);
    }

    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      flex: 1;
      min-height: 0;
    }

    .pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--card);
      overflow: hidden;
    }

    .pane-header {
      padding: 10px;
      border-bottom: 1px solid var(--border);
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
    }

    .pane-body {
      padding: 10px;
      overflow: hidden;
      flex: 1;
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .drop-zone {
      border: 1px dashed var(--muted);
      border-radius: 8px;
      padding: 6px 10px;
      color: var(--muted);
      text-align: center;
      min-width: 0;
    }

    .drop-zone.active {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(79, 193, 255, 0.08);
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      min-height: 120px;
      font-size: var(--json-font-size);
    }

    .pane-search {
      display: flex;
      gap: 8px;
      margin: 10px 0;
    }

    .pane-search input {
      flex: 1;
      min-width: 0;
    }

    .error {
      color: var(--danger);
      margin-bottom: 8px;
    }

    .meta {
      color: var(--muted);
      font-size: 12px;
    }

    .spacer {
      flex: 1;
    }

    .json-editor {
      height: auto;
      flex: 1;
      min-height: 220px;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--code-bg);
    }

    @media (max-width: 900px) {
      .split {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="controls">
    <button id="prevBtn">Prev</button>
    <button id="nextBtn">Next</button>
    <label>Index <input id="jumpInput" type="number" min="0" value="0" style="width: 100px;" /></label>
    <button id="jumpBtn">Jump</button>
    <span class="meta" id="status">No files loaded</span>
    <span class="spacer"></span>
    <button id="themeBtn">Theme: Dark</button>
    <button id="fontDownBtn">A-</button>
    <button id="fontUpBtn">A+</button>
    <button id="fontResetBtn">A=</button>
  </div>

  <div class="split">
    <section class="pane" data-side="left">
      <div class="pane-header">
        <strong>Left</strong>
        <div class="drop-zone" data-drop="left">Drop .json/.jsonl file here</div>
        <button data-pick="left">Choose File</button>
      </div>
      <div class="pane-body">
        <div class="pane-search">
          <input id="leftSearchInput" type="text" placeholder="Search left side" />
          <button id="leftSearchBtn">Find</button>
        </div>
        <div class="meta" id="leftMeta">Not loaded</div>
        <div id="leftError" class="error"></div>
        <div id="leftEditor" class="json-editor"></div>
      </div>
    </section>

    <section class="pane" data-side="right">
      <div class="pane-header">
        <strong>Right</strong>
        <div class="drop-zone" data-drop="right">Drop .json/.jsonl file here</div>
        <button data-pick="right">Choose File</button>
      </div>
      <div class="pane-body">
        <div class="pane-search">
          <input id="rightSearchInput" type="text" placeholder="Search right side" />
          <button id="rightSearchBtn">Find</button>
        </div>
        <div class="meta" id="rightMeta">Not loaded</div>
        <div id="rightError" class="error"></div>
        <div id="rightEditor" class="json-editor"></div>
      </div>
    </section>
  </div>

  <script nonce="${nonce}" src="${monacoBaseUri}/loader.js"></script>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const jumpBtn = document.getElementById('jumpBtn');
    const fontDownBtn = document.getElementById('fontDownBtn');
    const fontUpBtn = document.getElementById('fontUpBtn');
    const fontResetBtn = document.getElementById('fontResetBtn');
    const themeBtn = document.getElementById('themeBtn');
    const jumpInput = document.getElementById('jumpInput');
    const status = document.getElementById('status');

    const leftMeta = document.getElementById('leftMeta');
    const rightMeta = document.getElementById('rightMeta');
    const leftEditorEl = document.getElementById('leftEditor');
    const rightEditorEl = document.getElementById('rightEditor');
    const leftError = document.getElementById('leftError');
    const rightError = document.getElementById('rightError');
    const leftSearchInput = document.getElementById('leftSearchInput');
    const rightSearchInput = document.getElementById('rightSearchInput');
    const leftSearchBtn = document.getElementById('leftSearchBtn');
    const rightSearchBtn = document.getElementById('rightSearchBtn');

    const savedState = vscode.getState() || {};
    let theme = savedState.theme === 'light' ? 'light' : 'dark';
    let jsonFontSize = Number(savedState.jsonFontSize) || 13;
    let leftEditor = null;
    let rightEditor = null;
    let leftModel = null;
    let rightModel = null;
    let latestView = null;

    let editorInitAttempts = 0;
    let editorsInitializing = false;
    window.MonacoEnvironment = {
      getWorkerUrl: function (_workerId, label) {
        const workerScript = 'self.MonacoEnvironment={baseUrl:"${monacoBaseUri}/"};importScripts("${monacoBaseUri}/base/worker/workerMain.js");';
        return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(workerScript);
      }
    };

    const renderEditors = (view) => {
      if (!leftModel || !rightModel || !view) {
        return;
      }
      leftModel.setValue(view.left.current.pretty || '');
      rightModel.setValue(view.right.current.pretty || '');
      leftError.textContent = view.left.current.error ? 'Parse error: ' + String(view.left.current.error) : '';
      rightError.textContent = view.right.current.error ? 'Parse error: ' + String(view.right.current.error) : '';
    };

    const ensureEditors = () => {
      if (leftEditor && rightEditor) {
        return;
      }

      if (editorsInitializing) {
        return;
      }

      const amdRequire = window.require;
      if (!amdRequire || typeof amdRequire !== 'function') {
        editorInitAttempts += 1;
        if (editorInitAttempts <= 20) {
          window.setTimeout(ensureEditors, 50);
        } else {
          leftError.textContent = 'Failed to initialize Monaco editor.';
          rightError.textContent = 'Failed to initialize Monaco editor.';
        }
        return;
      }

      editorsInitializing = true;

      amdRequire.config({ paths: { vs: '${monacoBaseUri}' } });
      amdRequire(['vs/editor/editor.main'], () => {
        leftModel = monaco.editor.createModel('', 'json');
        rightModel = monaco.editor.createModel('', 'json');

        leftEditor = monaco.editor.create(leftEditorEl, {
          model: leftModel,
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          fontFamily: 'var(--vscode-editor-font-family), Consolas, "Courier New", monospace',
          fontSize: jsonFontSize
        });

        rightEditor = monaco.editor.create(rightEditorEl, {
          model: rightModel,
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          fontFamily: 'var(--vscode-editor-font-family), Consolas, "Courier New", monospace',
          fontSize: jsonFontSize
        });

        monaco.editor.onDidChangeMarkers((uris) => {
          if (leftModel && uris.some((u) => u.toString() === leftModel.uri.toString())) {
            const markers = monaco.editor.getModelMarkers({ resource: leftModel.uri });
            if (!latestView?.left?.current?.error) {
              leftError.textContent = markers.length > 0 ? 'JSON error: ' + markers[0].message : '';
            }
          }
          if (rightModel && uris.some((u) => u.toString() === rightModel.uri.toString())) {
            const markers = monaco.editor.getModelMarkers({ resource: rightModel.uri });
            if (!latestView?.right?.current?.error) {
              rightError.textContent = markers.length > 0 ? 'JSON error: ' + markers[0].message : '';
            }
          }
        });

        applyTheme(theme);
        applyFontSize(jsonFontSize);
        renderEditors(latestView);
        editorsInitializing = false;
      }, (err) => {
        editorsInitializing = false;
        leftError.textContent = 'Failed to load Monaco modules.';
        rightError.textContent = 'Failed to load Monaco modules.';
        console.error(err);
      });
    };

    const applyTheme = (nextTheme) => {
      theme = nextTheme;
      document.body.setAttribute('data-theme', theme);
      themeBtn.textContent = theme === 'dark' ? 'Theme: Dark' : 'Theme: Light';
      vscode.setState({ theme, jsonFontSize });
      if (leftEditor && rightEditor && window.monaco) {
        const monacoTheme = theme === 'dark' ? 'vs-dark' : 'vs';
        monaco.editor.setTheme(monacoTheme);
      }
    };

    const applyFontSize = (nextSize) => {
      jsonFontSize = Math.max(12, Math.min(28, nextSize));
      document.documentElement.style.setProperty('--json-font-size', jsonFontSize + 'px');
      vscode.setState({ theme, jsonFontSize });
      if (leftEditor && rightEditor) {
        leftEditor.updateOptions({ fontSize: jsonFontSize });
        rightEditor.updateOptions({ fontSize: jsonFontSize });
      }
    };

    ensureEditors();
    applyTheme(theme);
    applyFontSize(jsonFontSize);

    prevBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'navigate', direction: 'prev' });
    });

    nextBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'navigate', direction: 'next' });
    });

    jumpBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'jumpTo', index: Number(jumpInput.value) });
    });

    themeBtn.addEventListener('click', () => {
      applyTheme(theme === 'dark' ? 'light' : 'dark');
    });

    fontDownBtn.addEventListener('click', () => {
      applyFontSize(jsonFontSize - 1);
    });

    fontUpBtn.addEventListener('click', () => {
      applyFontSize(jsonFontSize + 1);
    });

    fontResetBtn.addEventListener('click', () => {
      applyFontSize(13);
    });

    const searchOnSide = (side, input) => {
      vscode.postMessage({ type: 'searchSide', side, query: input.value });
    };

    leftSearchBtn.addEventListener('click', () => {
      searchOnSide('left', leftSearchInput);
    });

    rightSearchBtn.addEventListener('click', () => {
      searchOnSide('right', rightSearchInput);
    });

    leftSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        searchOnSide('left', leftSearchInput);
      }
    });

    rightSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        searchOnSide('right', rightSearchInput);
      }
    });

    document.querySelectorAll('button[data-pick]').forEach((el) => {
      el.addEventListener('click', () => {
        const side = el.getAttribute('data-pick');
        vscode.postMessage({ type: 'pickFile', side });
      });
    });

    document.querySelectorAll('.drop-zone').forEach((el) => {
      const side = el.getAttribute('data-drop');

      const stop = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };

      el.addEventListener('dragenter', (event) => {
        stop(event);
        el.classList.add('active');
      });

      el.addEventListener('dragover', (event) => {
        stop(event);
      });

      el.addEventListener('dragleave', (event) => {
        stop(event);
        el.classList.remove('active');
      });

      el.addEventListener('drop', async (event) => {
        stop(event);
        el.classList.remove('active');

        const dt = event.dataTransfer;
        if (!dt) {
          return;
        }

        if (dt.files && dt.files.length > 0) {
          const file = dt.files[0];
          try {
            const content = await file.text();
            if (content && content.length > 0) {
              vscode.postMessage({
                type: 'dropFileContent',
                side,
                fileName: file.name,
                content
              });
              return;
            }
          } catch {
            // Ignore and fallback to path/uri loading.
          }
        }

        const uriList = dt.getData('text/uri-list');
        const plain = dt.getData('text/plain');
        const candidate = uriList || plain;
        if (candidate) {
          vscode.postMessage({ type: 'dropFilePath', side, path: candidate });
        }
      });
    });

    window.addEventListener('dragover', (event) => {
      event.preventDefault();
    });

    window.addEventListener('drop', (event) => {
      event.preventDefault();
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type !== 'state') {
        return;
      }

      const view = message.payload;
      latestView = view;
      jumpInput.value = String(view.currentIndex);
      status.textContent = 'Index ' + view.currentIndex + ' / ' + Math.max(0, view.maxIndex);

      leftMeta.textContent = String(view.left.label) + ' | lines: ' + String(view.left.totalLines);
      rightMeta.textContent = String(view.right.label) + ' | lines: ' + String(view.right.totalLines);

      renderEditors(view);
      ensureEditors();
    });
  </script>
</body>
</html>`;
}
