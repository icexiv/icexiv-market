#!/usr/bin/env python3
"""Non-recording public collector checks; no administrator credentials required."""

from email.utils import formatdate
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = "https://market.icexiv.top"


def check(path, status, method="GET", headers=None, body=None):
    request = Request(BASE + path, method=method, headers=headers or {}, data=body)
    try:
        with urlopen(request, timeout=10) as response:
            actual, content = response.status, response.read()
    except HTTPError as error:
        actual, content = error.code, b""
    assert actual == status, f"{method} {path}: wanted {status}, got {actual}"
    print(f"{method} {path}: {actual}")
    return content


def main():
    assert b"HashRouter adapter" in check("/_analytics/tracker.js", 200)
    assert check("/_analytics/api/event/ping", 200) == b"0"
    assert check("/_analytics/api/event/ping?u=market.icexiv.top%2Fmateria", 200) == b"0"
    assert check("/_analytics/api/event/ping", 200, headers={
        "If-Modified-Since": formatdate(usegmt=True),
    }) == b"1"
    for path in ["api/auth/login", "api/user", "api/websites", "openapi.yaml", "api/event/hit", "tracker.js/extra"]:
        check("/_analytics/" + path, 404)
    for origin in [None, "https://evil.example"]:
        check("/_analytics/api/event/hit", 404, "POST", {"Origin": origin} if origin else {}, b"{}")
    check("/_analytics/api/event/ping", 404, "POST", {"Origin": BASE}, b"{}")
    for size in [8193, 16384]:
        check("/_analytics/api/event/hit", 413, "POST", {"Origin": BASE}, b"x" * size)
    # Invalid payload exercises forwarding without creating a fake pageview.
    check("/_analytics/api/event/hit", 400, "POST", {"Origin": BASE, "Content-Type": "text/plain"}, b"{}")


if __name__ == "__main__":
    main()
