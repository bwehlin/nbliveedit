# Notebook Live Edit MCP

An MCP server that runs inside VS Code and lets an AI coding agent work in the notebook you have open: read cells, edit them, run them in the notebook's kernel, and look at the outputs, including plots.

Edits go through the live notebook editor, not the `.ipynb` file on disk. Your kernel state, unsaved changes and outputs stay intact, and you see every change happen in the editor.

## Features

- **Live editing:** list, insert, edit and delete cells in the open notebook.
- **Running cells:** run a cell in the notebook's current kernel and get its output back: text, errors with tracebacks, and images such as matplotlib plots.
- **"This cell":** the agent can see which cell you have selected, so you can say "change this cell to ...".
- **Diffs:** every edit returns a line diff, and a VS Code diff tab beside the notebook shows the latest edit. The tab updates in place, wherever you move it.
- **Long-running cells:** a call never blocks for more than 50 seconds. A cell that is still running is reported as running, together with its output so far.
- **Kernel control:** interrupt or restart the kernel. Restarting asks for your confirmation in VS Code.
- **Several windows:** each VS Code window runs its own server, and an agent started in a window's terminal talks to that window.

## Setup

1. Install the extension.
2. Add the server to Claude Code once:

   ```sh
   claude mcp add --transport http -s user notebook \
     'http://127.0.0.1:${NOTEBOOK_LIVE_EDIT_PORT:-7337}/mcp' \
     --header 'Authorization: Bearer ${NOTEBOOK_LIVE_EDIT_TOKEN}'
   ```

   Keep the single quotes, so the variables are expanded by Claude Code when it connects, not by your shell now.
3. Open a notebook, open a new terminal in that VS Code window, and start Claude Code there.

The extension sets `NOTEBOOK_LIVE_EDIT_PORT` and `NOTEBOOK_LIVE_EDIT_TOKEN` in VS Code's integrated terminals. Claude Code started anywhere else won't have the token, and the server will refuse it.

## Tools

| Tool | What it does |
|---|---|
| `list_cells` | All cells with index, kind, execution count, status and source; marks the selected cell |
| `get_selected_cell` | The cell you have selected in VS Code |
| `get_outputs` | A cell's outputs (text, errors, images); can wait for a running cell to finish |
| `edit_cell` | Replace a cell's source; returns a diff and updates the diff tab |
| `insert_cell` | Insert a code or markdown cell |
| `delete_cell` | Delete a cell |
| `run_cell` | Run a cell and return its outputs, waiting at most 50 seconds |
| `interrupt_kernel` | Interrupt the kernel; variables are kept |
| `restart_kernel` | Restart the kernel; VS Code asks you to confirm |

## Security

The server listens on 127.0.0.1 only, so other machines cannot reach it. Every request must carry a random token that the extension creates once and keeps across reloads. Requests from web pages, which always send an `Origin` header, are rejected.

Anyone who has the token can run code in your kernel. It is visible to programs started from VS Code's terminals, and it is stored with VS Code's other extension data.

## Settings

| Setting | Default | Description |
|---|---|---|
| `notebookLiveEdit.port` | `7337` | Preferred port. If another window already uses it, the window picks a free port and tells its terminals through `NOTEBOOK_LIVE_EDIT_PORT`. Reload the window after changing it. |

## Dev containers and remote windows

The extension runs where the notebook's workspace is, so in a dev container it has to be installed inside the container.

## Requirements

- VS Code 1.90 or newer
- The [Jupyter extension](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter), for the kernel commands
- An MCP client that supports Streamable HTTP and custom headers, for example Claude Code

## Limitations

- Only runs started through the server are tracked as running. Cells you start yourself show their final status once they finish.
- Interactive outputs that need a browser, such as Plotly figures and widgets, are reported as omitted.
- The thing is vibe coded (and vibe documented), obviously. Use at your own peril...

## License

Apache-2.0
