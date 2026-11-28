#!/usr/bin/env python3
"""代理 vs 直连：从本机模拟一次页面数据加载的端到端耗时。

三条路径：
  good   —— 走本机系统代理（代表线路正常的用户）
  bad    —— --noproxy 强制直连（代表到 Cloudflare 线路很差的用户）
  proxy  —— 走 market-stage.icexiv.top 的同源反代

每条路径跑两种序列：
  home   —— marketable + data-centers + worlds + aggregated(20 items)
  item   —— 单物品挂单 + 30 天成交历史

冷请求用 `_=<ts>` 打散缓存；热请求用同一 URL 重复。
"""
import json
import statistics
import subprocess
import time

DIRECT = "https://universalis.app"
PROXY = "https://market-stage.icexiv.top/api/universalis"

IDS = "2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21"
HOME = [
    "/api/v2/marketable",
    "/api/v2/data-centers",
    "/api/v2/worlds",
    f"/api/v2/aggregated/%E4%B8%AD%E5%9B%BD/{IDS}",
]
ITEM = [
    "/api/v2/%E4%B8%AD%E5%9B%BD/36114?listings=40",
    "/api/v2/history/%E4%B8%AD%E5%9B%BD/36114?entriesWithin=2592000",
]


def fetch(base: str, paths, noproxy: bool, bust: str | None):
    """一次 curl 调用取完整序列，复用同一条连接（近似浏览器一个页面的请求）。"""
    urls = []
    for path in paths:
        url = base + path
        if bust:
            url += ("&" if "?" in url else "?") + "_=" + bust
        urls.append(url)
    cmd = ["curl", "-s", "--compressed", "-m", "25",
           "-w", "%{http_code} %{time_total} %{size_download}\n"]
    if noproxy:
        cmd += ["--noproxy", "*"]
    # -o 只作用于紧随其后的 URL，所以逐个配对，避免响应体打到 stdout
    for url in urls:
        cmd += ["-o", "/dev/null", url]
    started = time.time()
    out = subprocess.run(cmd, capture_output=True, text=True).stdout.strip().splitlines()
    wall = time.time() - started
    codes, times, sizes = [], [], []
    for line in out:
        code, total, size = line.split()
        codes.append(int(code))
        times.append(float(total))
        sizes.append(int(size))
    # 序列里 curl 依次执行，wall 更接近真实页面；time_total 之和用于看请求本身
    return {"wall": wall, "sum": sum(times), "ok": all(c == 200 for c in codes),
            "codes": codes, "bytes": sum(sizes)}


def summarize(label, rows):
    walls = [r["wall"] for r in rows]
    sums = [r["sum"] for r in rows]
    ok = sum(1 for r in rows if r["ok"])
    print(json.dumps({
        "case": label,
        "runs": len(rows),
        "ok": ok,
        "wall_p50_s": round(statistics.median(walls), 3),
        "wall_max_s": round(max(walls), 3),
        "sum_p50_s": round(statistics.median(sums), 3),
        "sum_max_s": round(max(sums), 3),
        "bytes": statistics.median([r["bytes"] for r in rows]),
    }, ensure_ascii=False), flush=True)


def main():
    runs = {"good": 8, "bad": 3, "proxy": 8}
    for seq_name, paths in (("home", HOME), ("item", ITEM)):
        for route in ("good", "bad", "proxy"):
            base = PROXY if route == "proxy" else DIRECT
            noproxy = route == "bad"
            # 热：同一 URL 重复，代理侧命中缓存
            warm = [fetch(base, paths, noproxy, None) for _ in range(runs[route])]
            summarize(f"{seq_name}/{route}/warm", warm)
            # 冷：每次不同 URL，迫使代理回源
            cold = [fetch(base, paths, noproxy, f"{int(time.time()*1000)}") for _ in range(runs[route])]
            summarize(f"{seq_name}/{route}/cold", cold)


if __name__ == "__main__":
    main()
