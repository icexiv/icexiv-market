#!/usr/bin/env python3
"""universalis-proxy 容量与资源占用测试。

- 代理固定绑 CPU1，压测进程固定绑 CPU0（调用方用 taskset -c 0 启动本脚本），
  这样 2 vCPU 上测出来的吞吐不会被压测程序抢走。
- 资源数据直接读 systemd cgroup：cpu.stat 的 usage_usec 与 memory.current/peak。
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

CG = Path("/sys/fs/cgroup/system.slice/universalis-proxy.service")
BIN = "/opt/universalis-proxy/target/release/universalis-proxy"
AGG = "http://127.0.0.1:18090/api/v2/aggregated/%E4%B8%AD%E5%9B%BD/2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21"
MKT = "http://127.0.0.1:18090/api/v2/marketable"


def cpu_usec() -> int:
    for line in (CG / "cpu.stat").read_text().splitlines():
        if line.startswith("usage_usec"):
            return int(line.split()[1])
    return 0


def rss_mib() -> float:
    return int((CG / "memory.current").read_text()) / 1048576


def peak_mib() -> float:
    return int((CG / "memory.peak").read_text()) / 1048576


def reset_peak() -> None:
    try:
        (CG / "memory.peak").write_text("0")
    except OSError:
        pass


STAT = re.compile(r"ok=(\d+) err=(\d+)[\s\S]*?p50 ([\d.]+)ms\s+p90 ([\d.]+)ms\s+p99 ([\d.]+)ms")


def run(label: str, url: str, n: int, conc: int, bust: bool = False) -> dict:
    cmd = [BIN, "bench", url, str(n), str(conc)] + (["--bust"] if bust else [])
    reset_peak()
    c0, m0, t0 = cpu_usec(), rss_mib(), time.time()
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    elapsed = time.time() - t0
    c1, m1, t1 = cpu_usec(), rss_mib(), time.time()
    match = STAT.search(out)
    ok, err, p50, p90, p99 = match.groups() if match else ("0", "0", "?", "?", "?")
    row = {
        "case": label,
        "n": n,
        "conc": conc,
        "seconds": round(elapsed, 2),
        "req_per_s": round(int(ok) / elapsed, 1),
        "ok": int(ok),
        "err": int(err),
        "p50_ms": float(p50) if p50 != "?" else None,
        "p90_ms": float(p90) if p90 != "?" else None,
        "p99_ms": float(p99) if p99 != "?" else None,
        "cpu_s": round((c1 - c0) / 1e6, 3),
        "cpu_cores_avg": round((c1 - c0) / 1e6 / max(elapsed, 1e-9), 3),
        "rss_before_mib": round(m0, 1),
        "rss_after_mib": round(m1, 1),
        "rss_peak_mib": round(peak_mib(), 1),
    }
    print(json.dumps(row, ensure_ascii=False), flush=True)
    return row


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "suite"

    if mode == "idle":
        reset_peak()
        c0, t0 = cpu_usec(), time.time()
        time.sleep(30)
        elapsed = time.time() - t0
        cpu = (cpu_usec() - c0) / 1e6
        print(json.dumps({
            "case": "idle_30s",
            "cpu_s": round(cpu, 3),
            "cpu_cores_avg": round(cpu / elapsed, 4),
            "rss_mib": round(rss_mib(), 1),
            "rss_peak_mib": round(peak_mib(), 1),
        }, ensure_ascii=False))
        return

    # 预热：让命中测试真的是命中，并让上游连接建立起来
    subprocess.run(["curl", "-s", "-o", "/dev/null", "-m", "30", AGG], check=False)
    subprocess.run(["curl", "-s", "-o", "/dev/null", "-m", "30", MKT], check=False)

    if mode == "hits":
        for conc in (1, 2, 4, 8, 16, 32, 64, 128):
            run(f"hit_agg", AGG, 4000, conc)
        for conc in (1, 4, 8, 16):
            run(f"hit_marketable", MKT, 1000, conc)
        return

    if mode == "misses":
        for conc in (1, 4, 8):
            run("miss_agg", AGG, 40, conc, bust=True)
        return

    if mode == "soak":
        # 60 秒混合：命中为主，穿插少量未命中（模拟真实流量里的冷条目）
        end = time.time() + 60
        run("soak_hit", AGG, 20000, 32)
        print(json.dumps({"case": "soak_end", "rss_mib": round(rss_mib(), 1),
                          "rss_peak_mib": round(peak_mib(), 1)}))
        return

    if mode == "cache":
        # 用不同 key 灌缓存，看每条目的内存开销
        before = rss_mib()
        run("fill_120_distinct", AGG, 120, 8, bust=True)
        after = rss_mib()
        print(json.dumps({"case": "cache_growth", "before_mib": round(before, 1),
                          "after_mib": round(after, 1),
                          "delta_mib": round(after - before, 1)}, ensure_ascii=False))
        return


if __name__ == "__main__":
    main()
