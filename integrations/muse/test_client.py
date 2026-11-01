import base64
import io
import os
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from client import render_result


class InlineMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="muse-mcp-media-")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "result.bin"
        self.content = b"\x89PNG\r\n\x1a\nexample"
        self.encoded = base64.b64encode(self.content).decode("ascii")

    def result(self, item):
        return {"content": [{"type": "text", "text": "metadata only"}, item]}

    def test_writes_inline_image_to_a_private_new_file(self):
        response = self.result({"type": "image", "data": self.encoded, "mimeType": "image/png"})
        captured = io.StringIO()
        with redirect_stdout(captured):
            render_result(response, str(self.output))
        self.assertEqual(self.output.read_bytes(), self.content)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        self.assertIn("metadata only", captured.getvalue())
        self.assertIn("Saved inline MCP media:", captured.getvalue())
        self.assertNotIn(self.encoded, captured.getvalue())

    def test_writes_embedded_resource_without_printing_base64(self):
        response = self.result({
            "type": "resource",
            "resource": {"uri": "local-dev-artifact://demo/example.bin", "mimeType": "application/octet-stream", "blob": self.encoded},
        })
        captured = io.StringIO()
        with redirect_stdout(captured):
            render_result(response, str(self.output))
        self.assertEqual(self.output.read_bytes(), self.content)
        self.assertIn("application/octet-stream", captured.getvalue())
        self.assertNotIn(self.encoded, captured.getvalue())

    def test_requires_explicit_output_for_binary_data(self):
        response = self.result({"type": "image", "data": self.encoded, "mimeType": "image/png"})
        with self.assertRaisesRegex(ValueError, "--output"):
            render_result(response)
        self.assertFalse(self.output.exists())

    def test_rejects_existing_destination_and_symlink(self):
        self.output.write_bytes(b"original")
        response = self.result({"type": "image", "data": self.encoded, "mimeType": "image/png"})
        with self.assertRaises(FileExistsError):
            render_result(response, str(self.output))
        self.assertEqual(self.output.read_bytes(), b"original")
        self.output.unlink()
        target = Path(self.temp.name) / "target"
        target.write_bytes(b"protected")
        self.output.symlink_to(target)
        with self.assertRaises((FileExistsError, OSError)):
            render_result(response, str(self.output))
        self.assertEqual(target.read_bytes(), b"protected")

    def test_rejects_invalid_payload_and_link_only_results(self):
        bad_base64 = self.result({"type": "image", "data": "not-base64", "mimeType": "image/png"})
        with self.assertRaisesRegex(ValueError, "base64"):
            render_result(bad_base64, str(self.output))
        link = self.result({"type": "resource_link", "uri": "local-dev-artifact://demo/file"})
        with self.assertRaisesRegex(ValueError, "Unsupported MCP media type"):
            render_result(link, str(self.output))
        self.assertFalse(self.output.exists())

    def test_rejects_tool_errors_and_output_without_media(self):
        with self.assertRaisesRegex(RuntimeError, "TOOL_UNAVAILABLE"):
            render_result({"isError": True, "content": [{"type": "text", "text": "TOOL_UNAVAILABLE"}]}, str(self.output))
        with self.assertRaisesRegex(ValueError, "did not return"):
            render_result({"content": [{"type": "text", "text": "text-only"}]}, str(self.output))
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
