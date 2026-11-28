#!/usr/bin/env python3
"""Incrementally parse Caddy logs and atomically publish a private GoAccess report."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


# Caddy 2.6 logs remote_ip; GoAccess 1.9's CADDY preset expects the newer
# client_ip field. Match the installed server explicitly, without trusting XFF.
CADDY_FORMAT = json.dumps({
    "ts": "%x.%^",
    "request": {
        "remote_ip": "%h",
        "proto": "%H",
        "method": "%m",
        "host": "%v",
        "uri": "%U",
        "headers": {"User-Agent": ["%u"], "Referer": ["%R"]},
    },
    "duration": "%T",
    "size": "%b",
    "status": "%s",
})
STATIC_EXTENSIONS = (
    ".css", ".js", ".mjs", ".json", ".map", ".ico", ".png", ".jpg",
    ".jpeg", ".gif", ".svg", ".webp", ".avif", ".woff", ".woff2", ".ttf", ".wasm",
)


def generate_report(rebuild=False):
    # Overrides are for isolated smoke tests; production uses these defaults.
    state = Path(os.environ.get("MARKET_ANALYTICS_STATE", "/var/lib/market-analytics"))
    logs = Path(os.environ.get("MARKET_ANALYTICS_LOGS", "/var/log/caddy"))
    os.umask(0o027)
    state.mkdir(parents=True, exist_ok=True)

    with (state / "generate.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        files = sorted(logs.glob("market-access*.log"), key=lambda p: p.stat().st_mtime_ns)
        files = [path for path in files if path.stat().st_size]
        if not files:
            print("No access logs yet; keeping the previous report.")
            return

        current = state / "current"
        previous = current.resolve() if current.is_symlink() else None
        generation = Path(tempfile.mkdtemp(prefix="generation-", dir=state))
        published = False
        link = state / "current.next"
        try:
            generation.chmod(0o750)
            database = generation / "db"
            report = generation / "report"
            report.mkdir(mode=0o750)
            command = [
                "/usr/bin/goaccess",
                "--no-global-config",
                f"--log-format={CADDY_FORMAT}",
                "--date-format=%s",
                "--time-format=%s",
                "--tz=Asia/Shanghai",
                "--keep-last=30",
                "--no-query-string",
                "--anonymize-ip",
                "--no-term-resolver",
                "--no-progress",
                "--jobs=1",
                "--persist",
                f"--db-path={database}",
                "--html-report-title=XIV Market - origin requests (Asia/Shanghai)",
                f"--output={report / 'index.html'}",
                f"--output={generation / 'summary.json'}",
            ]
            command.extend(f"--static-file={extension}" for extension in STATIC_EXTENSIONS)
            if previous and (previous / "db").is_dir() and not rebuild:
                # GoAccess updates database files in place. Work on a copy so a
                # failed/killed run cannot corrupt the last successful database.
                shutil.copytree(previous / "db", database)
                command.append("--restore")
            else:
                database.mkdir(mode=0o750)

            # Pass regular, uncompressed files directly: GoAccess tracks inodes
            # and offsets across runs and Caddy renames during log rotation.
            subprocess.run(command + [str(path) for path in files], check=True)
            (report / "index.html").chmod(0o640)
            link.unlink(missing_ok=True)
            link.symlink_to(generation.name)
            link.replace(current)
            published = True
            print("Published access report (last 30 days, known bots included).")
        finally:
            link.unlink(missing_ok=True)
            if not published:
                shutil.rmtree(generation)

        # Only clean our own generations, after committing both report and DB.
        # This also removes unfinished generations left by an interrupted run.
        for old in state.glob("generation-*"):
            if old != generation and old.is_dir() and not old.is_symlink():
                shutil.rmtree(old)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--rebuild", action="store_true",
        help="Rebuild from retained raw logs instead of restoring the database.",
    )
    generate_report(rebuild=parser.parse_args().rebuild)
