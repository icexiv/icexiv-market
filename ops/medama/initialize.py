#!/usr/bin/env python3
"""Initialize a loopback-only Medama instance without saving credentials."""

import argparse
from http.cookies import SimpleCookie
from http.client import HTTPException
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18189")
    parser.add_argument("--password-file", required=True)
    parser.add_argument("--hostname", default="market.icexiv.top")
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1"):
        parser.error("initialization requires an HTTP loopback SSH tunnel")
    password = Path(args.password_file).read_text().rstrip("\r\n")
    default = "CHANGE_ME_ON_FIRST_LOGIN"
    if not 5 <= len(password) <= 128 or password == default:
        parser.error("password must be 5–128 characters and not the default")

    deadline = time.monotonic() + 30
    while True:
        try:
            with urlopen(args.base_url.rstrip("/") + "/api/event/ping", timeout=2) as response:
                if response.status == 200 and response.read() == b"0":
                    break
        except (URLError, OSError, HTTPException):
            pass
        if time.monotonic() >= deadline:
            raise SystemExit("Medama is not ready on the loopback tunnel; no credentials changed")
        time.sleep(0.5)

    def request(path, method="GET", data=None, cookie=None):
        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        req = Request(args.base_url.rstrip("/") + "/api" + path,
                      data=None if data is None else json.dumps(data).encode(),
                      headers=headers, method=method)
        try:
            with urlopen(req, timeout=20) as res:
                body = res.read()
                return res.status, res.headers, json.loads(body) if body else None
        except HTTPError as error:
            # Do not print response bodies or authentication headers.
            return error.code, error.headers, None

    def login(value):
        status, headers, _ = request("/auth/login", "POST", {"username": "admin", "password": value})
        if status == 401:
            return None
        if status != 200:
            raise SystemExit(f"login failed (HTTP {status})")
        cookies = SimpleCookie()
        cookies.load(headers.get("Set-Cookie", ""))
        if not cookies:
            raise SystemExit("login returned no session cookie")
        return "; ".join(f"{key}={item.value}" for key, item in cookies.items())

    cookie = login(password)
    if cookie is None:
        cookie = login(default)
        if cookie is None:
            raise SystemExit("neither supplied nor initial credentials work; no changes made")
        status, _, _ = request("/user", "PATCH", {"password": password}, cookie)
        if status != 200:
            raise SystemExit(f"password update failed (HTTP {status})")
        cookie = login(password)
    if cookie is None or login(default) is not None:
        raise SystemExit("password verification failed; keep the service loopback-only")
    status, _, websites = request("/websites", cookie=cookie)
    if status != 200:
        raise SystemExit(f"website list failed (HTTP {status})")
    if not any(site["hostname"] == args.hostname for site in websites):
        status, _, _ = request("/websites", "POST", {"hostname": args.hostname}, cookie)
        if status != 201:
            raise SystemExit(f"website registration failed (HTTP {status})")
    print(f"Verified admin password, rejected default password, registered {args.hostname}.")


if __name__ == "__main__":
    main()
