// Protocol self-check with a fake vscode module: node test.js
const Module = require('module');
const assert = require('assert');

const cells = [];
const nb = {
  uri: { fsPath: '/tmp/demo.ipynb' },
  get cellCount() { return cells.length; },
  cellAt: i => cells[i],
  getCells: () => cells,
};
const mkCell = (index, text, outText) => ({
  index, kind: 2, outputs: [{ items: [{ mime: 'text/plain', data: Buffer.from(outText) }] }],
  executionSummary: { success: true, executionOrder: 1 },
  document: { getText: () => text, lineCount: 1, languageId: 'python', uri: { toString: () => `cell:${index}` } },
});
cells.push(mkCell(0, 'x = 1\nx', '1'));

const commandCalls = [];
const fakeVscode = {
  commands: { executeCommand: async (...args) => { commandCalls.push(args); } },
  NotebookCellKind: { Markup: 1, Code: 2 },
  window: { activeNotebookEditor: undefined, visibleNotebookEditors: [{ notebook: nb, selection: { start: 0, end: 1 } }] },
  workspace: { notebookDocuments: [nb] },
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? fakeVscode : origLoad(req, ...rest));

const { createServer, lineDiff, listen } = require('./extension');

async function rpc(port, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}

(async () => {
  const server = createServer('test-token').listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;

  let r = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.strictEqual(r.json.result.protocolVersion, '2025-03-26');

  r = await rpc(port, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(r.status, 202);

  r = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepStrictEqual(r.json.result.tools.map(t => t.name).sort(),
    ['delete_cell', 'edit_cell', 'get_outputs', 'get_selected_cell', 'insert_cell', 'interrupt_kernel', 'list_cells', 'restart_kernel', 'run_cell']);

  r = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_cells', arguments: {} } });
  assert.match(r.json.result.content[0].text, /cell 0 \(code \[1\] ok\) <- SELECTED[\s\S]*x = 1/);

  r = await rpc(port, { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'get_selected_cell', arguments: {} } });
  assert.match(r.json.result.content[0].text, /cell 0 [\s\S]*x = 1/);

  fakeVscode.window.visibleNotebookEditors[0].selection = { start: 0, end: 0 };
  cells.length = 0;
  r = await rpc(port, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'get_selected_cell', arguments: {} } });
  assert.strictEqual(r.json.result.isError, true);
  cells.push(mkCell(0, 'x = 1\nx', '1'));

  r = await rpc(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_outputs', arguments: { index: 0 } } });
  assert.strictEqual(r.json.result.content[0].text, '1');

  // Rich outputs: chunked stdout, a figure (placeholder text + png), a DataFrame (plain + html), an HTML display object.
  const item = (mime, data) => ({ mime, data: Buffer.from(data) });
  cells[0].outputs = [
    { items: [item('application/vnd.code.notebook.stdout', 'a\n'), item('application/vnd.code.notebook.stdout', 'b\n')] },
    { items: [item('text/plain', '<Figure size 640x480 with 1 Axes>'), item('image/png', 'PNGDATA')] },
    { items: [item('text/html', '<table>'), item('text/plain', '   x\n0  1')] },
    { items: [item('text/plain', '<IPython.core.display.HTML object>'), item('text/html', '<b>hi</b>')] },
    { items: [item('application/vnd.plotly.v1+json', '{}')] },
  ];
  r = await rpc(port, { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'get_outputs', arguments: {} } });
  assert.deepStrictEqual(r.json.result.content, [
    { type: 'text', text: 'a\nb\n' },
    { type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' },
    { type: 'text', text: '   x\n0  1' },
    { type: 'text', text: '<b>hi</b>' },
    { type: 'text', text: '[application/vnd.plotly.v1+json output omitted]' },
  ]);

  r = await rpc(port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_outputs', arguments: { index: 9 } } });
  assert.strictEqual(r.json.result.isError, true);

  r = await rpc(port, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, { Origin: 'https://evil.example' });
  assert.strictEqual(r.status, 403);

  // Local processes without the token are refused, including a wrong token of the same length.
  r = await rpc(port, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, { Authorization: '' });
  assert.strictEqual(r.status, 403);
  r = await rpc(port, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, { Authorization: 'Bearer test-tokem' });
  assert.strictEqual(r.status, 403);

  // A run that outlives its wait reports RUNNING with partial output instead of hanging past Claude Code's timeout.
  const call = (id, name, args) => rpc(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  cells[0].outputs = [{ items: [item('application/vnd.code.notebook.stdout', 'partial\n')] }];
  r = await call(50, 'run_cell', { index: 0, timeout_seconds: 0.2 });
  assert.match(r.json.result.content[0].text, /still running/);
  assert.strictEqual(r.json.result.content[1].text, 'partial\n');
  r = await call(51, 'list_cells', {});
  assert.match(r.json.result.content[0].text, /cell 0 \(code \[1\] RUNNING\)/);
  cells[0].executionSummary = { success: false, executionOrder: 2, timing: { endTime: Date.now() + 1 } };
  r = await call(52, 'get_outputs', { index: 0, wait_seconds: 1 });
  assert.strictEqual(r.json.result.content[0].text, 'partial\n');
  r = await call(53, 'run_cell', { index: 0, timeout_seconds: 0.2 });
  r = await call(54, 'restart_kernel', {});
  assert.match(r.json.result.content[0].text, /restart requested/);
  assert.deepStrictEqual(commandCalls.at(-1), ['jupyter.restartkernel', nb.uri]);
  r = await call(55, 'list_cells', {});
  assert.doesNotMatch(r.json.result.content[0].text, /RUNNING/);
  r = await call(56, 'interrupt_kernel', {});
  assert.strictEqual(commandCalls.at(-1)[0], 'jupyter.interruptkernel');

  // lineDiff: change in the middle, far-away context collapsed, no-op edit.
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
  assert.strictEqual(lineDiff(before, before.replace('e', 'E')), ['...', ' c', ' d', '-e', '+E', ' f', ' g', '...'].join('\n'));
  assert.strictEqual(lineDiff('x', 'x\ny'), [' x', '+y'].join('\n'));
  assert.strictEqual(lineDiff('x', 'x'), '');

  // Port fallback: preferred port taken by another window -> some other free port.
  const other = createServer('test-token');
  const second = await listen(other, port);
  assert.ok(second > 0 && second !== port);
  other.close();

  server.close();
  console.log('ok');
})().catch(e => { console.error(e); process.exit(1); });
