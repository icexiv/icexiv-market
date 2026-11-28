#!/usr/bin/env python3
"""Smoke-test the generator against the server's actual GoAccess binary."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


GENERATOR = Path(__file__).with_name("generate-report.py")


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="market-analytics-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.logs = self.root / "logs"
        self.logs.mkdir()
        self.state = self.root / "state"
        self.environment = {
            **os.environ,
            "MARKET_ANALYTICS_STATE": str(self.state),
            "MARKET_ANALYTICS_LOGS": str(self.logs),
        }
        self.timestamp = int(time.time())

    def append(self, offset, uri="/"):
        entry = {
            "level": "info",
            "ts": self.timestamp + offset + 0.123,
            "logger": "http.log.access.log0",
            "msg": "handled request",
            "request": {
                "remote_ip": "198.51.100.23",
                "remote_port": "12345",
                "proto": "HTTP/2.0",
                "method": "GET",
                "host": "market.icexiv.top",
                "uri": uri,
                "headers": {
                    "User-Agent": ["Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0"],
                    "Referer": ["https://example.org/"],
                },
            },
            "bytes_read": 0,
            "duration": 0.0123,
            "size": 672,
            "status": 200,
        }
        with (self.logs / "market-access.log").open("a") as log:
            log.write(json.dumps(entry) + "\n")

    def generate(self, *arguments):
        result = subprocess.run(
            ["/usr/bin/python3", str(GENERATOR), *arguments],
            env=self.environment,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def hits(self):
        summary = json.loads((self.state / "current/summary.json").read_text())
        return summary["general"]["valid_requests"]

    def test_no_logs(self):
        self.generate()
        self.assertFalse((self.state / "current").exists())

    def test_incremental_and_rotation(self):
        self.append(0)
        self.append(1, "/assets/test.js")
        self.generate()
        self.assertEqual(self.hits(), 2)
        summary = json.loads((self.state / "current/summary.json").read_text())
        self.assertEqual(summary["general"]["unique_static_files"], 1)
        self.generate()
        self.assertEqual(self.hits(), 2, "A repeated run must not count old hits twice")
        self.append(2)
        self.generate()
        self.assertEqual(self.hits(), 3)
        (self.logs / "market-access.log").rename(self.logs / "market-access-rotated.log")
        self.append(3)
        self.generate()
        self.assertEqual(self.hits(), 4, "Rotation must neither duplicate nor lose hits")
        self.assertEqual(len(list(self.state.glob("generation-*"))), 1)

    def test_anonymized_report_and_grouped_queries(self):
        self.append(0, "/?private_query=one")
        self.append(1, "/?private_query=two")
        self.generate()
        html = (self.state / "current/report/index.html").read_text()
        self.assertNotIn("198.51.100.23", html)
        self.assertNotIn("private_query", html)
        summary = json.loads((self.state / "current/summary.json").read_text())
        self.assertEqual(summary["requests"]["data"][0]["hits"]["count"], 2)

    def test_same_second_requests_across_runs_and_rotation(self):
        self.append(0)
        self.generate()
        self.append(0, "/assets/second.js")
        self.generate()
        self.assertEqual(self.hits(), 2)
        (self.logs / "market-access.log").rename(self.logs / "market-access-rotated.log")
        self.append(0, "/assets/third.js")
        self.generate()
        self.assertEqual(self.hits(), 3)

    def test_rebuild_uses_only_retained_logs(self):
        self.append(0)
        self.generate()
        # The previous hits survive normal log retention, but not a rebuild.
        (self.logs / "market-access.log").unlink()
        self.append(1, "/assets/current.js")
        self.generate()
        self.assertEqual(self.hits(), 2)
        self.generate("--rebuild")
        self.assertEqual(self.hits(), 1)

    def test_failed_run_keeps_published_report_and_database(self):
        self.append(0)
        self.generate()
        current = (self.state / "current").resolve()
        before = {p.name: p.read_bytes() for p in (current / "db").iterdir()}
        spec = importlib.util.spec_from_file_location("report_generator", GENERATOR)
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        with patch.dict(os.environ, self.environment), patch.object(
            generator.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "goaccess")
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                generator.generate_report()
        self.assertEqual((self.state / "current").resolve(), current)
        self.assertEqual(before, {p.name: p.read_bytes() for p in (current / "db").iterdir()})
        self.assertEqual(len(list(self.state.glob("generation-*"))), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
