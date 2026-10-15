// Minimal MCP server (Streamable HTTP, stateless, JSON responses) running inside VS Code,
// so edits go through the live notebook model instead of the .ipynb on disk.
const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TEXT = 20000;

function getNotebook(path) {
  if (path) {
    const nb = vscode.workspace.notebookDocuments.find(d => d.uri.fsPath === path || d.uri.fsPath.endsWith(path));
    if (!nb) throw new Error(`No open notebook matches "${path}"`);
    return nb;
  }
  // The Claude Code terminal may hold focus, so fall back to any visible notebook.
  const ed = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
  if (!ed) throw new Error('No notebook is open. Open one or pass "path".');
  return ed.notebook;
}

function getCell(nb, index) {
  if (!Number.isInteger(index) || index < 0 || index >= nb.cellCount)
    throw new Error(`Cell index ${index} out of range (notebook has ${nb.cellCount} cells)`);
  return nb.cellAt(index);
}

// Selection survives focus moving to the Claude Code terminal, so the last-clicked cell is still reported.
function selectedIndex(nb) {
  const ed = [vscode.window.activeNotebookEditor, ...vscode.window.visibleNotebookEditors].find(e => e?.notebook === nb);
  const i = ed?.selection.start;
  return i !== undefined && i < nb.cellCount ? i : undefined;
}

function truncate(s) {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n...[truncated ${s.length - MAX_TEXT} chars]` : s;
}

const ERROR_MIME = 'application/vnd.code.notebook.error';
const STREAM_MIMES = ['application/vnd.code.notebook.stdout', 'application/vnd.code.notebook.stderr'];
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Most useful rendering first. text/plain beats text/html (a DataFrame's plain repr is compact),
// except when it is just a placeholder like "<IPython.core.display.HTML object>".
const TEXT_PREFERENCE = ['text/markdown', 'text/plain', 'text/html', 'image/svg+xml', 'text/latex', 'application/json'];

const decode = item => new TextDecoder().decode(item.data);
const isPlaceholder = item => item.mime === 'text/plain' && /^<.+ object>$/.test(decode(item).trim());

function itemToContent(item) {
  if (IMAGE_MIMES.includes(item.mime))
    return { type: 'image', data: Buffer.from(item.data).toString('base64'), mimeType: item.mime };
  if (item.mime === ERROR_MIME) {
    const e = JSON.parse(decode(item));
    return { type: 'text', text: truncate(`${e.name}: ${e.message}\n${e.stack || ''}`) };
  }
  return { type: 'text', text: truncate(decode(item)) };
}

// Converts cell outputs to MCP content: one rendering per output (items are alternatives of
// the same value), except streams, whose items are consecutive chunks and get concatenated.
function outputsToContent(cell) {
  const content = [];
  for (const out of cell.outputs) {
    const items = out.items;
    if (items.length && items.every(i => STREAM_MIMES.includes(i.mime))) {
      content.push({ type: 'text', text: truncate(items.map(decode).join('')) });
      continue;
    }
    const by = m => items.find(i => i.mime === m && !isPlaceholder(i));
    const item = by(ERROR_MIME) || IMAGE_MIMES.map(by).find(Boolean) || TEXT_PREFERENCE.map(by).find(Boolean)
      || items.find(i => i.mime.startsWith('text/'));
    content.push(item ? itemToContent(item) : { type: 'text', text: `[${items.map(i => i.mime).join(', ')} output omitted]` });
  }
  return content;
}

// Cells started by run_cell that have not finished yet: cell URI -> start time (ms).
// ponytail: only knows about runs started through this server, not ones the user started by hand.
const pending = new Map();

// Start time if the cell is still running from run_cell, else undefined.
function runningSince(cell) {
  const key = cell.document.uri.toString();
  const startedAt = pending.get(key);
  if (startedAt === undefined) return undefined;
  const end = cell.executionSummary?.timing?.endTime;
  if (end && end >= startedAt) { pending.delete(key); return undefined; }
  return startedAt;
}

function clearPending(nb) {
  for (const c of nb.getCells()) pending.delete(c.document.uri.toString());
}

function describeCell(cell, selected) {
  const kind = cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown';
  const s = cell.executionSummary;
  const status = runningSince(cell) !== undefined ? ' RUNNING' : s?.success === undefined ? '' : s.success ? ' ok' : ' FAILED';
  const order = s?.executionOrder ? ` [${s.executionOrder}]` : '';
  return `--- cell ${cell.index} (${kind}${order}${status})${selected ? ' <- SELECTED' : ''} ---\n${cell.document.getText()}`;
}

// Line diff of two cell sources: ' ', '-', '+' prefixed lines, unchanged runs beyond `ctx` lines
// of a change collapsed to '...'. Returns '' when nothing changed.
// ponytail: O(n*m) LCS table; fine for cell-sized text, switch to Myers if cells get huge.
function lineDiff(before, after, ctx = 2) {
  const A = before.split('\n'), B = after.split('\n'), n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && A[i] === B[j]) { ops.push(' ' + A[i++]); j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) ops.push('-' + A[i++]);
    else ops.push('+' + B[j++]);
  }
  const changed = ops.map((o, k) => o[0] !== ' ' ? k : -1).filter(k => k >= 0);
  if (!changed.length) return '';
  const out = [];
  ops.forEach((o, k) => {
    if (changed.some(c => Math.abs(c - k) <= ctx)) out.push(o);
    else if (out[out.length - 1] !== '...') out.push('...');
  });
  return out.join('\n');
}

// Before/after texts of the latest edit per notebook, served to VS Code's diff editor via the
// notebook-live-edit: scheme. One fixed URI pair per notebook, so a single diff tab updates in place.
const snapshots = new Map();
let snapshotChanged; // vscode.EventEmitter, created in activate()

function showDiff(nb, before, after) {
  // Extension (for syntax highlighting) is per notebook, not per cell, so the URIs stay fixed.
  const lang = nb.getCells().find(c => c.kind === vscode.NotebookCellKind.Code)?.document.languageId;
  const ext = { python: 'py', r: 'r', julia: 'jl' }[lang] || 'txt';
  const uri = side => vscode.Uri.from({ scheme: 'notebook-live-edit', path: `${nb.uri.path}.${side}.${ext}` });
  snapshots.set(uri('before').path, before);
  snapshots.set(uri('after').path, after);
  snapshotChanged.fire(uri('before'));
  snapshotChanged.fire(uri('after'));
  // Already open anywhere (any group or window position the user moved it to)? It just refreshed; leave it there.
  const open = vscode.window.tabGroups.all.some(g => g.tabs.some(t =>
    t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === uri('after').toString()));
  if (open) return;
  const name = nb.uri.path.split('/').pop();
  vscode.commands.executeCommand('vscode.diff', uri('before'), uri('after'), `${name}: Claude's last edit`,
    { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside })
    .then(undefined, e => console.error('notebook-live-edit-mcp: diff view failed', e));
}

async function applyEdit(edit) {
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the edit');
}

// ponytail: polls executionSummary every 100ms; switch to onDidChangeNotebookDocument if latency matters.
async function waitForExecution(cell, startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const end = cell.executionSummary?.timing?.endTime;
    if (end && end >= startedAt) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

// Claude Code aborts an MCP HTTP call after ~60s ("The operation timed out"), losing the result,
// so tools never block longer than this; long cells are polled with get_outputs instead.
const MAX_WAIT_SECONDS = 50;
// unref: a pending timeout must not keep the process alive (matters for node test.js).
const sleep = ms => new Promise(r => setTimeout(r, ms).unref());

function stillRunning(cell, startedAt) {
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const outputs = outputsToContent(cell);
  return [
    { type: 'text', text: `Cell ${cell.index} is still running (${secs}s so far). It may be slow, queued behind another running cell, or waiting for the kernel to start. ` +
      `Poll with get_outputs (wait_seconds), or stop it with interrupt_kernel. ${outputs.length ? 'Outputs so far:' : 'No output yet.'}` },
    ...outputs,
  ];
}

const pathProp = { path: { type: 'string', description: 'Notebook path (optional; defaults to the active/visible notebook)' } };
const indexProp = { index: { type: 'integer', description: '0-based cell index' } };

const tools = {
  list_cells: {
    description: 'List all cells (index, kind, execution count, source) of the notebook open in VS Code.',
    inputSchema: { type: 'object', properties: { ...pathProp } },
    run: ({ path }) => {
      const nb = getNotebook(path);
      const sel = selectedIndex(nb);
      const body = nb.getCells().map(c => describeCell(c, c.index === sel)).join('\n\n');
      return [{ type: 'text', text: `${nb.uri.fsPath} (${nb.cellCount} cells)\n\n${body}` }];
    },
  },
  get_selected_cell: {
    description: 'Get the cell the user has selected in VS Code ("this cell"): its index, kind, and source.',
    inputSchema: { type: 'object', properties: { ...pathProp } },
    run: ({ path }) => {
      const nb = getNotebook(path);
      const sel = selectedIndex(nb);
      if (sel === undefined) throw new Error('No cell is selected.');
      return [{ type: 'text', text: `${nb.uri.fsPath}\n${describeCell(nb.cellAt(sel), true)}` }];
    },
  },
  get_outputs: {
    description: 'Get the current outputs of a cell (text, errors, and images such as plots), and whether it is still running. Omit index for the selected cell.',
    inputSchema: {
      type: 'object',
      properties: {
        ...pathProp, ...indexProp,
        wait_seconds: { type: 'number', description: `If the cell is still running, wait up to this many seconds (max ${MAX_WAIT_SECONDS}) for it to finish first.` },
      },
    },
    run: async ({ path, index, wait_seconds = 0 }) => {
      const nb = getNotebook(path);
      if (index === undefined && (index = selectedIndex(nb)) === undefined) throw new Error('No cell is selected; pass index.');
      const cell = getCell(nb, index);
      let startedAt = runningSince(cell);
      if (startedAt !== undefined && wait_seconds > 0) {
        await waitForExecution(cell, startedAt, Math.min(wait_seconds, MAX_WAIT_SECONDS) * 1000);
        startedAt = runningSince(cell);
      }
      if (startedAt !== undefined) return stillRunning(cell, startedAt);
      const content = outputsToContent(cell);
      return content.length ? content : [{ type: 'text', text: '(no output)' }];
    },
  },
  edit_cell: {
    description: 'Replace the source of a cell in the live notebook editor (not on disk). Outputs are kept. Returns a line diff of the change.',
    inputSchema: { type: 'object', properties: { ...pathProp, ...indexProp, source: { type: 'string' } }, required: ['index', 'source'] },
    run: async ({ path, index, source }) => {
      const nb = getNotebook(path);
      const doc = getCell(nb, index).document;
      const before = doc.getText();
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), source);
      await applyEdit(edit);
      if (before !== source) showDiff(nb, before, source);
      return [{ type: 'text', text: `Cell ${index} updated.\n${lineDiff(before, source) || '(no change)'}` }];
    },
  },
  insert_cell: {
    description: 'Insert a new cell at the given index (use the cell count to append).',
    inputSchema: {
      type: 'object',
      properties: { ...pathProp, ...indexProp, source: { type: 'string' }, kind: { type: 'string', enum: ['code', 'markdown'], default: 'code' } },
      required: ['index', 'source'],
    },
    run: async ({ path, index, source, kind = 'code' }) => {
      const nb = getNotebook(path);
      if (!Number.isInteger(index) || index < 0 || index > nb.cellCount) throw new Error(`Insert index ${index} out of range`);
      const lang = kind === 'code' ? (nb.getCells().find(c => c.kind === vscode.NotebookCellKind.Code)?.document.languageId || 'python') : 'markdown';
      const cellKind = kind === 'code' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
      const edit = new vscode.WorkspaceEdit();
      edit.set(nb.uri, [vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(cellKind, source, lang)])]);
      await applyEdit(edit);
      return [{ type: 'text', text: `Inserted ${kind} cell at ${index}.` }];
    },
  },
  delete_cell: {
    description: 'Delete a cell.',
    inputSchema: { type: 'object', properties: { ...pathProp, ...indexProp }, required: ['index'] },
    run: async ({ path, index }) => {
      const nb = getNotebook(path);
      getCell(nb, index);
      const edit = new vscode.WorkspaceEdit();
      edit.set(nb.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(index, index + 1))]);
      await applyEdit(edit);
      return [{ type: 'text', text: `Deleted cell ${index}.` }];
    },
  },
  run_cell: {
    description: 'Execute a cell in the notebook\'s current kernel (like pressing Run in VS Code) and return its outputs. ' +
      `Waits at most ${MAX_WAIT_SECONDS}s; if the cell is still running then, returns its outputs so far, and get_outputs (wait_seconds) polls it.`,
    inputSchema: {
      type: 'object',
      properties: { ...pathProp, ...indexProp, timeout_seconds: { type: 'number', default: MAX_WAIT_SECONDS, description: `Max ${MAX_WAIT_SECONDS}` } },
      required: ['index'],
    },
    run: async ({ path, index, timeout_seconds = MAX_WAIT_SECONDS }) => {
      const nb = getNotebook(path);
      const cell = getCell(nb, index);
      if (cell.kind !== vscode.NotebookCellKind.Code) throw new Error(`Cell ${index} is not a code cell`);
      const startedAt = Date.now();
      pending.set(cell.document.uri.toString(), startedAt);
      await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 1 }], document: nb.uri });
      if (!(await waitForExecution(cell, startedAt, Math.min(timeout_seconds, MAX_WAIT_SECONDS) * 1000)))
        return stillRunning(cell, startedAt);
      pending.delete(cell.document.uri.toString());
      const status = cell.executionSummary.success === false ? 'FAILED' : 'ok';
      return [{ type: 'text', text: `Cell ${index} [${cell.executionSummary.executionOrder}] ${status}` }, ...outputsToContent(cell)];
    },
  },
  interrupt_kernel: {
    description: 'Interrupt the notebook\'s kernel (like the Interrupt button): stops the running cell and cancels queued ones. Variables are kept.',
    inputSchema: { type: 'object', properties: { ...pathProp } },
    run: async ({ path }) => {
      const nb = getNotebook(path);
      await vscode.commands.executeCommand('jupyter.interruptkernel', { notebookEditor: { notebookUri: nb.uri } });
      clearPending(nb);
      return [{ type: 'text', text: 'Interrupt sent.' }];
    },
  },
  restart_kernel: {
    description: 'Restart the notebook\'s kernel (like the Restart button), e.g. after installing packages or when it hangs. ' +
      'All variables and imports are lost, so rerun the setup cells afterwards. VS Code may ask the user to confirm.',
    inputSchema: { type: 'object', properties: { ...pathProp } },
    run: async ({ path }) => {
      const nb = getNotebook(path);
      // Resolves once the user answers VS Code's confirmation (if enabled); the restart itself continues in the background.
      const answered = await Promise.race([
        vscode.commands.executeCommand('jupyter.restartkernel', nb.uri).then(() => true),
        sleep(MAX_WAIT_SECONDS * 1000).then(() => false),
      ]);
      clearPending(nb);
      return [{ type: 'text', text: answered
        ? 'Kernel restart requested. If VS Code asked to confirm and the user declined, nothing changed; after a restart, execution counts start again at [1].'
        : 'VS Code is still waiting for the user to confirm the restart.' }];
    },
  },
};

async function handleRpc(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  try {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'notebook-live-edit-mcp', version: '0.0.1' },
        } };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: {
          tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
        } };
      case 'tools/call': {
        const tool = tools[params?.name];
        if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } };
        try {
          return { jsonrpc: '2.0', id, result: { content: await tool.run(params.arguments || {}) } };
        } catch (e) {
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } };
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } };
  }
}

// Constant-time check of the "Authorization: Bearer <token>" header.
function authorized(req, token) {
  const got = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function createServer(token) {
  return http.createServer((req, res) => {
    // Browsers always send Origin on cross-site requests; reject them so web pages can't drive the kernel.
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    // Other local processes, and agents started in other VS Code windows, can reach 127.0.0.1 too,
    // so every request must carry this window's token.
    // 403, not 401: a 401 makes MCP clients start an OAuth flow this server does not offer.
    if (!authorized(req, token)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
        .end('Missing or wrong token. Start the agent from a terminal of the VS Code window that has the notebook ' +
          'open, so it gets that window\'s NOTEBOOK_LIVE_EDIT_TOKEN (and NOTEBOOK_LIVE_EDIT_PORT).');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map(handleRpc))).filter(Boolean);
      if (!replies.length) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]));
    });
  });
}

// Listens on the preferred port, or on any free port if another VS Code window already holds it.
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', e => {
      if (e.code !== 'EADDRINUSE' || port === 0) return reject(e);
      listen(server, 0).then(resolve, reject);
    });
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

// `mcp add` commands for each supported agent CLI, run in a terminal so the user sees them.
// Claude Code expands ${VAR} in the URL, so it follows this window's port; Codex cannot, so it always uses
// 7337 and gets a clean 403 (wrong token) when 7337 belongs to another window.
const AGENTS = {
  claude: {
    label: 'Claude Code',
    command: `claude mcp add --transport http -s user notebook 'http://127.0.0.1:\${NOTEBOOK_LIVE_EDIT_PORT:-7337}/mcp' --header 'Authorization: Bearer \${NOTEBOOK_LIVE_EDIT_TOKEN}'`,
  },
  codex: {
    label: 'Codex',
    command: 'codex mcp add notebook --url http://127.0.0.1:7337/mcp --bearer-token-env-var NOTEBOOK_LIVE_EDIT_TOKEN',
  },
};

// Whether an executable is on PATH (plus ~/.local/bin, where both CLIs' installers put them).
function installed(bin) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
  return dirs.some(dir => { try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; } });
}

function addMcpServer(agent) {
  if (process.platform === 'win32') {
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/bwehlin/nbliveedit#setup'));
    return;
  }
  const terminal = vscode.window.createTerminal(`Add Notebook Live Edit MCP server to ${AGENTS[agent].label}`);
  terminal.show();
  terminal.sendText(AGENTS[agent].command);
}

async function activate(context) {
  const preferred = vscode.workspace.getConfiguration('notebookLiveEdit').get('port', 7337);
  // One token per workspace, kept across reloads: a reload doesn't cut off running agent sessions, and an
  // agent started in another window (whose token differs) is refused instead of editing the wrong notebook.
  let token = context.workspaceState.get('token');
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    await context.workspaceState.update('token', token);
  }
  const server = createServer(token);
  context.subscriptions.push({ dispose: () => server.close() });
  // Terminals of this window (where Claude Code runs) learn the token and which port belongs to this window;
  // the MCP config reads them as ${NOTEBOOK_LIVE_EDIT_PORT:-7337} and ${NOTEBOOK_LIVE_EDIT_TOKEN}.
  context.environmentVariableCollection.replace('NOTEBOOK_LIVE_EDIT_TOKEN', token);
  try {
    const port = await listen(server, preferred);
    context.environmentVariableCollection.replace('NOTEBOOK_LIVE_EDIT_PORT', String(port));
  } catch (e) {
    vscode.window.showErrorMessage(`Notebook Live Edit MCP: could not listen on 127.0.0.1: ${e.message}`);
  }
  for (const agent of Object.keys(AGENTS))
    context.subscriptions.push(vscode.commands.registerCommand(`notebookLiveEdit.addTo.${agent}`, () => addMcpServer(agent)));
  // Offer once, and only for the agent CLIs that are actually installed.
  const found = Object.keys(AGENTS).filter(installed);
  if (found.length && !context.globalState.get('setupOffered')) {
    await context.globalState.update('setupOffered', true);
    const buttons = found.map(agent => `Add to ${AGENTS[agent].label}`);
    vscode.window.showInformationMessage(
      `Notebook Live Edit MCP: add this MCP server to ${found.map(a => AGENTS[a].label).join(' and ')}? ` +
      'Runs its `mcp add` command in a terminal.', ...buttons, 'Not now')
      .then(choice => { const i = buttons.indexOf(choice); if (i >= 0) addMcpServer(found[i]); });
  }
  snapshotChanged = new vscode.EventEmitter();
  context.subscriptions.push(snapshotChanged, vscode.workspace.registerTextDocumentContentProvider('notebook-live-edit',
    { onDidChange: snapshotChanged.event, provideTextDocumentContent: uri => snapshots.get(uri.path) ?? '' }));
}

module.exports = { activate, deactivate() {}, createServer, lineDiff, listen };
