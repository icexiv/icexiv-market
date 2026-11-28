# Medama 自托管统计

国内站的浏览统计保存在自家 Mac mini。公网 Debian 只提供脚本和受限采集转发，不提供 Medama 后台；原有 [Caddy + GoAccess 请求统计](../analytics/README.md) 独立保留。

## 服务与数据

- Mac mini：局域网 `192.168.2.11`，Tailnet `100.119.68.25`，部署目录 `/Users/azurice/Services/medama`。
- `compose.yaml` 固定 Medama `v0.6.2` 的镜像摘要，支持 Apple Silicon；重启策略 `unless-stopped`，上限 1 CPU / 1 GiB，日志最多 3 × 10 MB。
- 容器在 `127.0.0.1` 和 `100.119.68.25` 的 `18180` 端口监听，供本机 Caddy 和公网源站的采集转发使用；不对局域网提供这个明文端口。只读根文件系统；`data/me_app.db` 保存账户/设置，`data/me_analytics.db` 保存浏览数据；`HOME=/app/data` 让 DuckDB 的 ICU 扩展缓存也保存在本机。
- 公网采集直接转发到 `http://100.119.68.25:18180`，仅连接仍使用 Tailscale 加密网络。不使用 Tailscale Serve 或 Funnel。
- 后台由 Mac mini 现有 Caddy 的 `private-https.caddy` 提供：局域网 `https://192.168.2.11:18181/` 不需要客户端安装 Tailscale；外出时连接 Tailnet 使用 `https://100.119.68.25:18181/`。仅绑定这两个私网 IP，不绑定 `0.0.0.0` 或公网 IPv6。用户名 `admin`，后台不由公网源站提供。
- 密码只在初始化时读取私密文件，不保存在 Compose、脚本、环境文件或 Git 中。后台 session 为内存状态，服务重启后需要重新登录。

后台保留 Medama 官方的 `Secure` session Cookie，不修改或移除它。浏览器登录必须使用 `https://` 的 `18181` 端口，不能使用采集上游的普通 HTTP 地址。

### 客户端信任证书

私网 IP 不能取得公信 CA 证书，Caddy 使用 `tls internal` 签发包含对应 IP SAN 的证书。客户端首次需要信任 Caddy 的本地根证书：

- 根证书位于 Mac mini 的 `/Users/azurice/Services/medama/medama-ca.crt`，也可从 `https://192.168.2.11:18181/medama-ca.crt` 下载；首次浏览器警告可以临时继续以下载证书。
- iPhone/iPad 安装证书描述文件后，还需在「设置 → 通用 → 关于本机 → 证书信任设置」中启用该根证书。Android 在系统安全设置中安装 CA 证书；其他设备导入系统或浏览器的受信任根证书库。
- 可在 Mac mini 上用 `openssl x509 -in ~/Services/medama/medama-ca.crt -noout -fingerprint -sha256` 核对指纹，再确认下载文件相同。
- 下载接口只提供公开的根证书，不提供 CA 私钥、Caddy 存储目录或其他服务文件。不自动修改客户端的系统信任库。

使用全局代理时，应让这两个私网 IP 直连；不要把后台请求交给公网代理。不要使用已经停用的 `macmini.tail6b415c.ts.net` Serve 地址。

## 安装与初始化

将 `compose.yaml` 复制到 Mac mini 的部署目录，创建权限为 `700` 的 `data/`，在该目录执行 `docker compose up -d`。首次安装时仅保留 `127.0.0.1` 的端口映射，完成初始化后再启用 Tailnet 端口和 Caddy 入口，避免暴露初始密码。

从操作机器建立临时 SSH 隧道：

```bash
ssh -N -L 127.0.0.1:18189:127.0.0.1:18180 azurice@100.119.68.25
```

用私密卡片创建的密码文件初始化，不把密码放进命令行：

```bash
python3 ops/medama/initialize.py --password-file /private/path/to/password-file
```

脚本先尝试指定密码，必要时才使用初始账户修改密码；随后验证新密码可用、默认密码被拒绝，并注册 `market.icexiv.top`。可重复执行，但实例已有其他密码时会停止，不重置账户。

把 `private-https.caddy` 复制到部署目录。Mac mini 的 `~/flakes/.dotfiles/caddy/Caddyfile` 末尾使用 `import {$HOME}/Services/medama/*.caddy` 加载该私网入口；原有站点、全局配置与 DuckDNS 凭证不变。使用现有 Caddy 启动环境验证配置并 reload，不需要重建 nix-darwin 或另启 Caddy 服务。导出 Caddy 本地 CA 的公开根证书到 `medama-ca.crt`，用于客户端安装和证书下载。

若局域网 IP 改变，需同步更新 `private-https.caddy` 的站点地址和 `bind`，然后 reload Caddy。保留 Tailscale 的 `accept-dns=false`、`accept-routes=false`、`ssh=false` 和无 exit node 的设置。不需要配置 Serve；不要为此启用 Funnel 或路由器端口转发。

## 公网采集

把 `collector.caddy` 安装为源站 `/etc/caddy/market-medama.caddy`，在 Caddyfile 顶层导入文件，并且只在 `market.icexiv.top` 站点内导入 `market_medama_collector`。保留 `market_site`、`market_access_log` 和已有日志配置，验证成功后 reload Caddy。

公网只允许：

- `GET/HEAD /_analytics/tracker.js`：静态脚本，`Cache-Control: no-cache`，不依赖 Mac mini 在线。
- `GET /_analytics/api/event/ping`：保留 Medama 的 HTTP 缓存访客估算协议及每页缓存参数。
- `POST /_analytics/api/event/hit`：要求同源 `Origin`，请求体上限 8 KB，连接超时 2 秒、响应头/读写超时 3 秒。

其他 `/_analytics/*` 路径和错误方法返回 404，后台登录、用户、站点、统计及 OpenAPI 均不在允许列表。客户端转发地址被 Caddy 覆写，Cookie、Authorization、Referer 和伪造 IP 头被清除。Origin 检查不是用户认证，采集接口仍可被非浏览器客户端伪造请求，不应用作审计数据。

## 前端口径

`app/analytics.ts` 仅在 `VITE_SITE_TARGET=cn` 的 production build 中向 `index.html` 插入脚本并输出 `/_analytics/tracker.js`。国际站、开发服务器和 `render.html` 不注入；运行时还校验 HTTPS、正式域名及入口路径。

`tracker.js` 适配 HashRouter：

- `#/item/123?scope=...&quality=...` 记为 `/item/123`，每次真正换页使用独立 beacon ID；范围/品质/查询参数变化不算新页面。
- 只发送已知路由，未知路径统一归入 `/other`；不上传查询字符串、hash、搜索词、自定义事件或外部 referrer 路径。
- 无统计 Cookie、localStorage 或持久用户 ID；使用 Medama 的 HTTP 缓存估算每日访客。访客数不是精确人数；清理缓存、换设备、禁用缓存等会影响估算。
- 尊重 DNT 和 Global Privacy Control。浏览器语言、User-Agent 和时区用于语言/设备/国家概览；国家来自时区推测，不是 IP 精准定位。
- 仅累计可见时间；切页、隐藏、BFCache 恢复及异步请求使用各自页面状态。全部请求不带凭证和 Referer，失败后停止该文档后续采集，不阻塞行情页面。

Mac mini 不可用时只会丢失相应浏览事件，不回补、不让静态站或行情查询依赖统计服务。

## 检查、备份与回滚

```bash
bun run test
python3 ops/medama/check-collector.py
```

单元测试覆盖路由、异步切页、唯一访客/页面、可见时长、BFCache、排除入口、隐私开关、断网和构建注入。公网检查不生成假浏览记录。端到端验证应使用真实浏览器访问并切页，再登录私网后台检查路径；HTTP 204 本身不能证明入库，因为 Medama 会静默过滤机器人。

在 Mac mini 的服务目录中停止**这个 Compose 项目**，完整复制 `data/` 到权限为 `700` 的本机备份目录后立即启动。不要直接复制正在写入的 DuckDB 文件，不要执行 `down -v`。恢复时停服务，保存当前数据，再恢复整份备份；镜像升级前同样备份。数据和备份都不应传到公网源站或加入 Git。

源站配置及初始 HTML 的备份位于 `/var/backups/market-medama/20261113T071949Z/`。Mac mini 的配置备份位于服务目录的 `backups/before-direct-access/` 和 `backups/before-caddy-https/`。移除 `private-https.caddy` 并 reload Mac mini 的 Caddy 可关闭后台 HTTPS，不影响其他站点。移除公网源站的 `market_medama_collector` 导入、验证并 reload Caddy，可停用采集转发而不改变 GoAccess。完全停用还需移除前端注入并重新构建；不要删除 `data/`。Tailscale Serve 状态应保持为空，不应恢复旧的 Serve 上游配置。

自动部署会用 rsync 替换站点，因此 `app/analytics.ts`、Vite 配置和脚本必须随项目提交后，后续 CI 部署才会持续带上统计；不要仅依赖线上 HTML 的手工注入。
