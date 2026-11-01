#!/usr/bin/env python3
"""Minimal stateless MCP client for Meta Muse's Tailscale HTTP CONNECT proxy."""
import argparse
import base64
import binascii
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE_BYTES = 9 * 1024 * 1024
MAX_MEDIA_BYTES = 6 * 1024 * 1024
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


def extract_media(result):
    """Return one MCP image or embedded-resource block, never a resource link."""
    media = [item for item in result.get("content", []) if item.get("type") != "text"]
    if not media:
        return None
    if len(media) != 1:
        raise ValueError("Expected exactly one inline MCP image or embedded resource")
    block = media[0]
    if block["type"] == "image":
        raw = block.get("data")
        mime = block.get("mimeType")
    elif block["type"] == "resource":
        resource = block.get("resource")
        if not isinstance(resource, dict):
            raise ValueError("Invalid MCP embedded resource")
        raw = resource.get("blob")
        mime = resource.get("mimeType")
    else:
        raise ValueError("Unsupported MCP media type: " + str(block["type"]))
    if not isinstance(raw, str) or not isinstance(mime, str) or not mime:
        raise ValueError("Invalid inline media payload")
    if len(raw) > (MAX_MEDIA_BYTES + 2) * 4 // 3 + 4:
        raise ValueError("MCP media exceeds the supported file size")
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("Invalid base64 in MCP media payload") from error
    if len(data) > MAX_MEDIA_BYTES:
        raise ValueError("MCP media exceeds the supported file size")
    return data, mime


def render_result(result, output=None):
    if not isinstance(result, dict):
        raise ValueError("Invalid MCP tool result")
    if result.get("isError"):
        raise RuntimeError("Tool failed: " + "\n".join(
            item.get("text", "") for item in result.get("content", []) if item.get("type") == "text"
        ))
    media = extract_media(result)
    if media and output is None:
        raise ValueError("The tool returned inline image/file data. Run again with --output PATH to save it securely.")
    if output is not None and media is None:
        raise ValueError("--output was specified, but the tool did not return inline image/file data")
    if media:
        data, mime = media
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(output, flags, 0o600)
        try:
            with os.fdopen(fd, "wb") as target:
                target.write(data)
        except BaseException:
            os.unlink(output)
            raise
    for item in result.get("content", []):
        if item.get("type") == "text":
            print(item.get("text", ""))
    if media:
        print("Saved inline MCP media: " + output + " (" + mime + ", " + str(len(data)) + " bytes)")


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
    call.add_argument("--output", help="Save one inline image or embedded resource to a NEW file (mode 0600)")
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
    render_result(result, getattr(args, "output", None))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, urllib.error.URLError, OSError) as error:
        print("local-dev: " + str(error), file=sys.stderr)
        sys.exit(1)
