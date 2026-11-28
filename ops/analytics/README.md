# 国内源站访问统计

服务器为 Debian 13，Caddy 通过 `/etc/caddy/Caddyfile` 提供静态站点。统计使用系统包 `goaccess`，不需要数据库服务或前端埋点。

## 采集与保留

- 只采集 `market.icexiv.top` 域名入口的请求，不包含直接访问 IP、报表自身、GitHub Pages 的请求。国内站的行情接口自 2026-11-28 起走同源 `/api/universalis/*`，这部分会进入日志并计入报表；国际站仍由浏览器直连 Universalis / TOS，不计入。
- Caddy JSON 日志：`/var/log/caddy/market-access.log`。单文件 20 MiB，最多保留 10 个轮转文件，轮转文件保留不超过 30 天；当前文件不按时间轮转，因此低流量下可能包含更早的请求。文件不压缩，供 GoAccess 根据 inode / 偏移量增量读取，避免重复计数和漏读轮转文件。
- 原始日志包含 IP、路径和 User-Agent，文件权限为 `0640`，`/var/log/caddy` 为 `0750 caddy:caddy`；轮转继承文件权限。Caddy 的 systemd drop-in 设置 `UMask=0027`，用于进程下次启动后创建的文件；部署时也需收紧已有日志的权限。GoAccess 报表对 IP 脱敏、合并同路径的查询参数，不查询外部 DNS 或 GeoIP 服务。
- 报表保留最近 30 天的统计，每 5 分钟更新一次（额外最多约 25 秒调度偏移）。包含爬虫及静态资源；访客数按 IP、User-Agent 和日期估算，不代表精确人数或页面浏览量。
- HashRouter 的 `#` 路径不会到达源站，无法据此统计物品详情浏览。请求耗时是 Caddy 处理时间，不是浏览器端完整加载时间。SPA fallback 可能把不存在的路径返回为 200，不能仅凭状态码判断业务页面存在。

## 查看报表

报表仅监听 `127.0.0.1:8081`，不需要新增防火墙或安全组规则。在本机建立 SSH 隧道：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18081:127.0.0.1:8081 root@82.156.196.54
```

保持连接，在浏览器打开 <http://127.0.0.1:18081/>；刷新页面获取最新快照。报表不在网站 `www` 目录中，不随 rsync 部署覆盖，也不能从公网网站路径访问。

## 服务器配置

本目录文件对应：

| 仓库文件 | 服务器路径 |
| --- | --- |
| `market-analytics.caddy` | `/etc/caddy/market-analytics.caddy` |
| `caddy-log-permissions.conf` | `/etc/systemd/system/caddy.service.d/market-analytics.conf` |
| `generate-report.py` | `/usr/local/libexec/market-analytics.py` |
| `market-analytics.service` | `/etc/systemd/system/market-analytics.service` |
| `market-analytics.timer` | `/etc/systemd/system/market-analytics.timer` |

`/etc/caddy/Caddyfile` 顶层引入 `/etc/caddy/market-analytics.caddy`，仅在 `market.icexiv.top` 站点内引入 `market_access_log`。不要把日志片段放进同时用于 IP 入口的 `market_site`。

生成任务使用不可登录的系统用户 `market-analytics`、运行组 `caddy`。状态目录 `/var/lib/market-analytics` 权限为 `0750`，报表文件为 `0640`。任务限制 512 MiB 内存、半个 CPU 核和 3 分钟运行时间；不允许联网，只能写自己的状态目录。

GoAccess 在临时 generation 中恢复并更新数据库及 HTML；成功后原子切换 `current` 符号链接。失败保留上一份报表和数据库，下次运行会重新读取尚未提交的请求。旧 generation 在发布成功后清理；被强制终止留下的临时文件也会在下一次成功后清理。

解析格式显式匹配 Caddy 2.6 的 `request.remote_ip`；GoAccess 1.9 的 `CADDY` 预设使用 `client_ip`，不能直接套用。Caddy 2.6 不支持日志 writer 的 `mode` 配置，因此权限由目录、现有文件和 systemd umask 共同约束。升级 Caddy 时需用实际日志重新验证字段。

静态资源扩展名在生成脚本中显式配置，包含 JS、CSS、JSON、图片及字体，不依赖 GoAccess 的全局配置。修改解析或分类口径后需要重建统计：以 `market-analytics:caddy` 身份运行生成脚本并传入 `--rebuild`。重建也会原子发布，但只包含尚未轮转清理的原始日志，不应当作日常刷新操作。

## 运维

在服务器上查看任务状态、下次更新时间和错误：

```bash
systemctl status market-analytics.timer market-analytics.service --no-pager
systemctl list-timers market-analytics.timer --no-pager
journalctl -u market-analytics.service -n 30 --no-pager
```

手动更新：

```bash
systemctl start market-analytics.service
```

更新配置后先用 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 校验，再 reload Caddy。systemd 单元修改后需 `systemctl daemon-reload`；定时器通过 `systemctl enable --now market-analytics.timer` 启用。

测试使用 `test-report.py`；需有 `/usr/bin/goaccess`。测试只在独立临时目录生成合成日志，不读取或改写正式统计。
