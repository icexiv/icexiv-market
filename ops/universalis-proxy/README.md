# Universalis 缓存反代

跑在国内源站上的极小反代：只放行行情相关路径，进程内缓存 + 上游连接复用，用来替代"每个访客各自直连 universalis.app"。

## 为什么需要

国内到 Cloudflare 的直连质量不稳定：本机直连出现过 96 KB / 6.7 s、1.3 KB / 15 s 的情况；服务器直连 Universal­is 会落到 AMS/FRA 边缘（`cf-ray ...-AMS`），RTT 200 ms+，新连接 TLS 0.4–1.6 s、TTFB 0.7–1.9 s。代理的价值不在省流量（一次物品页只有 ~4 KB），而在**把慢而抖的直连换成 0 ms 的命中**，并让"打进一个 IP"的请求量靠缓存压下来。

## 行为

- 只允许 `GET` / `HEAD`；白名单：
  - `/api/v2/marketable`、`/api/v2/data-centers`、`/api/v2/worlds`
  - `/api/v2/aggregated/...`、`/api/v2/history/...`
  - `/api/v2/<world|dc|region>/<id,id,...>`
  - `/healthz`
- 只缓存 2xx；TTL 取上游 `Cache-Control: max-age`，夹在 30–600 s；`marketable` 单独用 `MARKETABLE_TTL`（默认 1 h），`data-centers` / `worlds` 24 h。
- 命中与未命中都返回 `x-proxy-cache: hit|miss`，命中额外带 `Age`，`Cache-Control` 按剩余 TTL 下发，浏览器/CDN 与本机缓存口径一致。
- 上游请求走 reqwest 连接池（TLS 用 rustls，ALPN 协商 h2），复用同一连接，省掉每次 0.4–1.6 s 的握手。
- 缓存为 FIFO 淘汰，容量 `CACHE_MAX_MB` / `CACHE_MAX_ENTRIES`；不落盘，进程重启即清空。

## 异步与任务模型

- `#[tokio::main]` 多线程运行时；每个连接一个 hyper 任务，处理函数全 async，不阻塞 worker。
- 上游用 reqwest 的 async 客户端，连接池 + h2 多路复用：16 并发时实测只保持 3–4 条到 443 的连接（文档上限是每 IP 8 条）。
- 同一 key 的并发未命中用 per-key `tokio::sync::Mutex` 归并，只有 leader 打上游，其余等结果。
- 缓存与统计用 `std::sync::RwLock`/`Mutex`，临界区只有微秒级且不跨 `await` 持有。
- **没有后台任务**：不预热、不定时清理、不做后台刷新。过期判断在读取时做，stale 兜底依赖过期条目还留在 map 里，淘汰在插入时顺带完成。
- 已知缺陷：leader 的请求被客户端中断时，future 被 drop，`inflight` 里那条 key 不会被删除（每中断一次泄漏一个 Arc）。锁会随 future 释放，不会卡死；后续同 key 请求会重新取锁并自行拉取。

## 上游限速（按 Universalis 文档）

文档给的口径：**25 req/s（突发 50）**、**每 IP 最多 8 条并发连接**、建议带上唯一 `User-Agent`。

实现：

| 项 | 做法 |
| --- | --- |
| 出站速率 | 令牌桶 `UPSTREAM_RPS`（默认 12）/ `UPSTREAM_BURST`（默认 20），留出余量；命中不经过限速器 |
| 排队上限 | 每个未命中最多等 3 s，超出直接走 stale / 503，不无限堆积 |
| 429 | 读 `Retry-After`，否则指数退避（0.5 s 起，上限 8 s）；冷却期内不再打上游 |
| 连接数 | `pool_max_idle_per_host(2)` + h2 复用（实测 3–4 条 < 8） |
| User-Agent | `xiv-market-proxy/0.1 (+https://github.com/AzurIce/xiv-market)` |
| 访客归因 | 把 Caddy 的 `X-Forwarded-For` 首跳转成 `CF-Connecting-IP` 发给上游 |
| 观测 | `GET /stats` 输出 hits / shared / misses / stale / cooldown / errors / upstream_429 / 缓存占用 |

改之前实测**16 并发就吃到 25 次 429**；加限速后：

| 压测 | 结果 |
| --- | --- |
| 24 个不同 key，8 并发 | 24/24 成功，p50 651 ms，p99 1.19 s，`upstream_429` 0 |
| 64 个不同 key，16 并发 | 60 成功、4 个排队 3 s 后 503（自我保护），`upstream_429` 0 |
| 1500 次命中 | p50 0.2 ms，p90 0.3 ms |

说明：命中不消耗令牌，所以线上日常（250 IP/天、峰值 163 请求/分钟）几乎不会触发出站限速；限速只在爬虫或缓存穿透时起作用。



## 构建与部署

需要 Rust ≥ 1.85（`Cargo.lock` 已锁到兼容 1.85 的依赖，含把 `idna_adapter` 固定到 1.1.0，避免 ICU 组件要求 1.88）。

```bash
# 本机验证
cd ops/universalis-proxy
cargo build --release
LISTEN=127.0.0.1:18090 ./target/release/universalis-proxy

# 或用仓库 flake（crane + rust-overlay 的 stable 工具链），产物 ./result/bin/universalis-proxy
nix build .#universalis-proxy -L

# 服务器上（Debian 13）
apt-get install -y --no-install-recommends rustc cargo
rsync -a --delete --exclude target/ Cargo.toml Cargo.lock src root@<server>:/opt/universalis-proxy/
ssh root@<server> 'cd /opt/universalis-proxy && cargo build --release'
install -m 755 /opt/universalis-proxy/target/release/universalis-proxy /usr/local/bin/universalis-proxy

install -m 644 deploy/universalis-proxy.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now universalis-proxy

# Caddy：把 deploy/market-api.caddy 放到 /etc/caddy/，在 market.icexiv.top 站点块内 import market_api
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

前端侧只需把 `UNIVERSALIS_BASE_URL` 指到同源 `/api/universalis`（`packages/shared/src/api.ts`），线上不再由浏览器直连上游。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `LISTEN` | `127.0.0.1:18090` | 监听地址；不要绑公网，交给 Caddy |
| `UPSTREAM` | `https://universalis.app` | 上游基地址（测试时可指到镜像） |
| `CACHE_MAX_MB` | `64` | 缓存字节上限 |
| `CACHE_MAX_ENTRIES` | `20000` | 缓存条目上限 |
| `DEFAULT_TTL` | `300` | 上游没给 `max-age` 时的 TTL |
| `MARKETABLE_TTL` | `3600` | 可交易物品 ID 表的 TTL |
| `UPSTREAM_RPS` | `8` | 出站令牌桶速率（文档上限 25/s，留余量） |
| `UPSTREAM_BURST` | `8` | 出站令牌桶容量 |

## 压测

二进制自带 `bench`，与线上请求共用同一个 HTTP 栈，避免用 curl 循环带来的偏差：

```bash
# 直连上游（基线，连接复用）
./target/release/universalis-proxy bench 'https://universalis.app/api/v2/aggregated/中国/2,3,4,5,6,7' 100 8

# 代理未命中：每个请求带不同参数，绕过缓存
./target/release/universalis-proxy bench 'http://127.0.0.1:18090/api/v2/aggregated/中国/2,3,4,5,6,7' 100 8 --bust

# 代理命中：同一 URL 重复
./target/release/universalis-proxy bench 'http://127.0.0.1:18090/api/v2/aggregated/中国/2,3,4,5,6,7' 2000 8
```

## 灰度站部署

`market-stage.icexiv.top` 用同一份前端产物，只是构建时把 API 指到同源反代：

```bash
# DNS：market-stage 已指向 82.156.196.54（DNSPod）
# Caddy：deploy/market-stage.caddy → /etc/caddy/，在 Caddyfile 顶层 import
ops/universalis-proxy/deploy/stage-deploy.sh root@82.156.196.54
```

脚本做三件事：`VITE_UNIVERSALIS_BASE=/api/universalis VITE_SITE_TARGET=cn BASE_URL=/ bun run build`、建 `/srv/market-stage.icexiv.top/www`、rsync 产物。Caddy 首次访问时自动申请证书。

> 注意：不要给上游塞 `CF-Connecting-IP`。它是 Cloudflare 的保留头，服务端自己伪造会被 CF 直接 403（已实测）。

## 实测（阿里云 2C2G，2026-11-28）

服务器直连 Universalis 会落到 AMS/FRA 边缘，即使连接复用，聚合接口 p90 仍有 1.6 s、p99 近 10 s。代理 + 缓存把"重复请求"变成内存读取，同时用 10 s 上限和过期兜底消掉长尾。

| 场景 | 请求数 / 并发 | p50 | p90 | p99 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 直连聚合（连接复用） | 120 / 8 | 812 ms | 1.59 s | 9.76 s | 5 req/s，长尾明显 |
| 代理未命中（不同 key） | 120 / 8 | 724 ms | 1.17 s | 1.41 s | 10 req/s，长尾被 10 s 上限截断 |
| 代理命中 | 2000 / 8 | 0.2 ms | 0.3 ms | 3.3 ms | 回环压测，非真实上限 |
| 直连 `marketable` | 40 / 4 | 923 ms | 1.35 s | 2.36 s | 97 KB |
| 代理 `marketable` 命中 | 504 / 8 | 0.5 ms | 0.7 ms | 2.3 ms | 97 KB |
| `marketable` 冷启动 | 1 | 0.79 s | — | — | 每小时一次 |
| 同一 key 40 并发冷启动 | 40 / 8 | 0.4 ms | 3.46 s | 3.46 s | 只有 1 次上游，其余 39 个共享结果 |

结论：

- **命中路径等于免费**，p90 在 1 ms 以内，2 vCPU 的吞吐远超本站需求（250 IP/天、峰值 163 请求/分钟）。
- **未命中路径和直连一个量级**（p50 0.72 s vs 0.81 s），但 p99 从 9.8 s 降到 1.4 s：代理保持一条热连接、统一 10 s 超时，用户不会卡 30 秒。
- `marketable`（首页唯一的大请求）每次冷拉 0.8 s，之后 1 小时内都是内存命中，是收益最大的一项。
- 上游确实会卡死：并发请求 40 个不同 key 的 `marketable` 时，40 个里 32 个在 10 s 超时。因此**必须**保留 `marketable` 长 TTL，并避免无意义的 cache bust。


## 容量与资源（2C2G 实测，2026-11-28）

方法：`deploy/bench-suite.py`；代理 `CPUAffinity=1`、压测进程 `taskset -c 0`，两者不抢核。资源直接读 systemd cgroup（`cpu.stat` / `memory.current` / `memory.peak`），不含压测程序。

### 资源占用

| 场景 | CPU | 内存（cgroup） |
| --- | --- | --- |
| 空闲 30 s | 0.0 s | 0.7 MiB |
| 命中 4,000 请求（并发 1–128） | 0.17–0.25 s ≈ **43–62 µs/请求** | 5–8 MiB，峰值 25 MiB（并发 128） |
| 未命中（受上游支配） | ≈0.001–0.002 核 | 不变 |
| 缓存 | — | 64 MiB 上限 ≈ 6,900 条（实测均值 9.3 KB/条） |

### 命中吞吐（aggregated 1.8 KB，单核）

| 并发 | req/s | p50 | p99 |
| --- | --- | --- | --- |
| 1 | 7,207 | 0.1 ms | 0.2 ms |
| 8 | 12,694 | 0.4 ms | 4.4 ms |
| 16 | 15,219 | 0.7 ms | 5.5 ms |
| 64 | 11,682 | 3.3 ms | 48.9 ms |
| 128 | 10,769 | 8.4 ms | 64.3 ms |

CPU 始终只有 0.5–0.66 核，说明上限是回环压测端，真实值更高。

`marketable`（97 KB）：5.2k–8.6k req/s，CPU 0.5–0.68 核，p50 0.2–1.9 ms。

### 未命中

| 并发 | req/s | p50 | p99 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 1.4 | 590 ms | 1.81 s | 完全受上游支配 |
| 4 | 5.4 | 560 ms | 1.17 s | |
| 8 | 9.5 | 472 ms | 1.46 s | 限速器把出站压在 8/s 附近，0 × 429 |

### 经过 Caddy 的端到端（同机回环，含 TLS）

`https://market-stage.icexiv.top/api/universalis/...` 命中：**2,513 req/s，p50 2.9 ms，p99 7.3 ms**。

### 客户端对比（从开发者机器发起，一次页面数据加载）

| 序列 | 直连（线路正常） | 直连（`--noproxy`，线路差） | 反代冷 | 反代热 |
| --- | --- | --- | --- | --- |
| 首页 4 个请求 | 1.72 s | 25–77 s，1/3 失败 | 1.85 s | **0.045 s** |
| 物品 2 个请求 | 0.81 s | 9–17 s，1/3 失败 | 0.95 s | **0.030 s** |

同一序列的传输量：首页直连 42.6 KB，反代 20.4 KB（Caddy zstd）。

### 换算

- CPU：45 µs/请求 → 1 万日活（按 13 个 API 请求/天）约 130k 请求/天，≈ 6 CPU·秒/天。
- 带宽：物品会话 6.6 KB、首页会话 20 KB；19 Mbps 出站 ≈ 2.4 MB/s，够 120–360 个会话/秒。
- 出站限速 8/s：1 万日活、20% 未命中约 0.35 miss/s，留足余量。
- 结论：**瓶颈不是这台机器**，是套餐月流量与上游冷路径；机器侧三个数量级余量。
