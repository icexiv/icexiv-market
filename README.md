<p align="center">
  <img src="app/public/logo.png" width="160" height="160" alt="XIV Market：交易板与 IceXIV 冰方块" />
</p>

# XIV Market

FFXIV 市场行情查询。数据来自 [Universalis](https://universalis.app) 公开 API，纯前端静态部署，不需要后端。

- 站点：<https://market.icexiv.top/> ｜ <https://icexiv.github.io/icexiv-market/>

## 功能

- 市场行情浏览与中文物品搜索
- 挂单与成交分布、历史走势图表
- 数据中心 / 服务器 / 区域筛选、NQ 与 HQ 品质切换
- 响应式布局，适配手机与桌面

## 技术栈

Solid.js + @solidjs/router、Tailwind CSS v4、Kobalte、Chart.js、Vite、bun。

## 开发

```bash
bun install
bun run dev     # 本地开发
bun run build   # 生产构建
bun run test    # 测试
```

物品数据由 `bun run update-items` 生成，通过 Shadow 发布到 TOS，仓库只记录版本与内容哈希。发布流程见 `AGENTS.md`。

## 文档

- `AGENTS.md`：开发约定、目录结构、数据链路与实现细节
- `DESIGN.md`：前端设计规范
- `ops/`：部署与统计相关运维脚本

## License

MIT
