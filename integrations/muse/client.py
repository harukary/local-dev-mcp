#!/usr/bin/env python3
"""Minimal stateless MCP client for Meta Muse's Tailscale HTTP CONNECT proxy."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE_BYTES = 9 * 1024 * 1024
PROTOCOL_VERSION = "2025-06-18"


def config():
    url = os.environ.get("LOCAL_DEV_MCP_URL", "")
    secret = os.environ.get("LOCAL_DEV_MCP_MUSE_TOKEN", "")
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy", "")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".ts.net") or parsed.path != "/mcp" or not parsed.port:
        raise ValueError("LOCAL_DEV_MCP_URL must be https://<tailnet-host>.ts.net:<port>/mcp")
    if not secret:
        raise ValueError("LOCAL_DEV_MCP_MUSE_TOKEN must be provided by the secure connector credential injector")
    proxy_parts = urllib.parse.urlsplit(proxy)
    if proxy_parts.scheme not in ("http", "https") or not proxy_parts.hostname or proxy_parts.port is None:
        raise ValueError("HTTPS_PROXY with host, port and current credentials is required inside Muse VM")
    # Muse routes tailnet TCP via the same runtime proxy host, on port 3130.
    authority = proxy_parts.netloc.rsplit(":", 1)[0] + ":3130"
    tailnet_proxy = urllib.parse.urlunsplit((proxy_parts.scheme, authority, "", "", ""))
    return url, secret, tailnet_proxy


class Client:
    def __init__(self):
        self.url, self.secret, proxy = config()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy}))
        self.next_id = 1

    def post(self, method, params):
        call_id = self.next_id
        self.next_id += 1
        req = urllib.request.Request(
            self.url,
            data=json.dumps({"jsonrpc": "2.0", "id": call_id, "method": method, "params": params}).encode("utf-8"),
            headers={
                "Authorization": "Bearer " + self.secret,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": PROTOCOL_VERSION,
            },
            method="POST",
        )
        try:
            with self.opener.open(req, timeout=90) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                mime = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        except urllib.error.HTTPError as error:
            raise RuntimeError("MCP HTTP request rejected (status " + str(error.code) + ")") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RuntimeError("MCP result exceeded the response limit")
        if mime == "text/event-stream":
            events = [line[5:].strip() for line in raw.splitlines() if line.startswith(b"data:")]
            packets = [json.loads(event) for event in events if event and event != b"[DONE]"]
            matched = next((packet for packet in packets if packet.get("id") == call_id), None)
        else:
            matched = json.loads(raw)
        if not isinstance(matched, dict):
            raise RuntimeError("MCP response is missing the expected JSON-RPC result")
        if "error" in matched:
            raise RuntimeError("MCP error: " + str(matched["error"].get("message", "unknown")))
        return matched.get("result")

    def initialize(self):
        self.post("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "muse-local-dev", "version": "1"},
        })


def main():
    parser = argparse.ArgumentParser(description="Call local-dev MCP from Meta Muse over Tailscale")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("projects", help="List registered projects")
    tools = sub.add_parser("tools", help="List tool names, optionally filtered")
    tools.add_argument("--filter", default="")
    schema = sub.add_parser("schema", help="Print the input schema for one tool")
    schema.add_argument("name")
    call = sub.add_parser("call", help="Call a tool with JSON object arguments")
    call.add_argument("name")
    call.add_argument("arguments", help="JSON object string")
    args = parser.parse_args()

    client = Client()
    client.initialize()
    if args.action == "projects":
        result = client.post("tools/call", {"name": "project.list", "arguments": {}})
    elif args.action in ("tools", "schema"):
        result = client.post("tools/list", {})
        entries = result.get("tools", [])
        if args.action == "tools":
            print("\n".join(t["name"] for t in entries if args.filter in t["name"]))
            return
        found = next((tool for tool in entries if tool["name"] == args.name), None)
        if found is None:
            raise ValueError("Unknown tool: " + args.name)
        print(json.dumps(found, ensure_ascii=False, indent=2))
        return
    else:
        params = json.loads(args.arguments)
        if not isinstance(params, dict):
            raise ValueError("Tool arguments must be a JSON object")
        result = client.post("tools/call", {"name": args.name, "arguments": params})
    if result.get("isError"):
        raise RuntimeError("Tool failed: " + "\n".join(i.get("text", "") for i in result.get("content", []) if i.get("type") == "text"))
    for item in result.get("content", []):
        if item.get("type") == "text":
            print(item.get("text", ""))
        else:
            print("[Non-text MCP content: " + str(item.get("type", "unknown")) + "]", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, urllib.error.URLError, OSError) as error:
        print("local-dev: " + str(error), file=sys.stderr)
        sys.exit(1)
