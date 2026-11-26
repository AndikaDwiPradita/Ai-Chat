"""MCP (Model Context Protocol) client manager for Cosmic AI.

Runs a single background event loop that keeps MCP server sessions alive.
Flask (sync) callers schedule coroutines via run_coroutine_threadsafe.
"""
import asyncio
import threading
from contextlib import AsyncExitStack

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.sse import sse_client

    MCP_AVAILABLE = True
    MCP_IMPORT_ERROR = None
except Exception as _exc:  # mcp bersifat opsional
    ClientSession = None
    StdioServerParameters = None
    stdio_client = None
    sse_client = None
    MCP_AVAILABLE = False
    MCP_IMPORT_ERROR = str(_exc)


class MCPServerState:
    def __init__(self, config):
        self.config = config
        self.session = None
        self.exit_stack = None
        self.task = None
        self.ready = threading.Event()
        self.error = None
        self.tools = []


class MCPManager:
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        self.servers = {}  # id -> MCPServerState
        self.lock = threading.Lock()

    def _run_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _schedule(self, coro):
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return future.result(timeout=60)

    def add_server(self, server_id, config):
        if not MCP_AVAILABLE:
            raise RuntimeError(
                "SDK MCP belum terpasang. Jalankan 'pip install -r requirements-optional.txt'."
            )
        with self.lock:
            if server_id in self.servers:
                self.remove_server(server_id)
            state = MCPServerState(config)
            self.servers[server_id] = state
        # start connection task
        task = self.loop.create_task(self._connect(server_id, state))
        state.task = task
        # wait for ready or error (with timeout)
        state.ready.wait(timeout=30)
        if state.error:
            raise RuntimeError(state.error)
        return state

    async def _connect(self, server_id, state):
        cfg = state.config
        try:
            stack = AsyncExitStack()
            state.exit_stack = stack
            transport_type = cfg.get("transport", "stdio")
            if transport_type == "stdio":
                params = StdioServerParameters(
                    command=cfg["command"],
                    args=cfg.get("args", []),
                    env=cfg.get("env"),
                )
                read, write = await stack.enter_async_context(stdio_client(params))
            elif transport_type in ("sse", "http"):
                url = cfg["url"]
                read, write = await stack.enter_async_context(sse_client(url))
            else:
                raise ValueError(f"Unknown transport: {transport_type}")
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            state.session = session
            # fetch tools
            tools_result = await session.list_tools()
            state.tools = [
                {
                    "name": t.name,
                    "description": getattr(t, "description", "") or "",
                    "inputSchema": getattr(t, "inputSchema", None) or {},
                }
                for t in (tools_result.tools or [])
            ]
            state.ready.set()
            # keep alive
            await asyncio.Event().wait()
        except Exception as exc:
            state.error = str(exc)
            state.ready.set()
        finally:
            try:
                if state.exit_stack is not None:
                    await state.exit_stack.aclose()
            except Exception:
                pass
            state.session = None

    def remove_server(self, server_id):
        with self.lock:
            state = self.servers.pop(server_id, None)
        if state is not None and state.task is not None:
            self.loop.call_soon_threadsafe(state.task.cancel)
            # wait briefly
            try:
                state.task.result(timeout=5)
            except Exception:
                pass

    def list_servers(self):
        with self.lock:
            out = []
            for sid, st in self.servers.items():
                out.append({
                    "id": sid,
                    "config": st.config,
                    "connected": st.session is not None,
                    "error": st.error,
                    "tools": st.tools,
                })
            return out

    def list_tools(self, server_id=None):
        with self.lock:
            if server_id:
                st = self.servers.get(server_id)
                return st.tools if st else []
            all_tools = []
            for sid, st in self.servers.items():
                for t in st.tools:
                    all_tools.append({"server": sid, **t})
            return all_tools

    def call_tool(self, server_id, tool_name, arguments):
        state = self.servers.get(server_id)
        if not state or state.session is None:
            raise RuntimeError("Server not connected")
        session = state.session
        async def _call():
            return await session.call_tool(tool_name, arguments or {})
        result = self._schedule(_call())
        # normalize result
        content = []
        for c in (result.content or []):
            if hasattr(c, "text"):
                content.append({"type": "text", "text": c.text})
            elif hasattr(c, "data"):
                content.append({"type": "image", "data": c.data, "mimeType": getattr(c, "mimeType", None)})
            else:
                content.append({"type": "text", "text": str(c)})
        return {"content": content, "isError": getattr(result, "isError", False)}

    def shutdown(self):
        for sid in list(self.servers.keys()):
            self.remove_server(sid)
        self.loop.call_soon_threadsafe(self.loop.stop)


_manager = None
_manager_lock = threading.Lock()


def get_manager():
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = MCPManager()
        return _manager
