#!/usr/bin/env bash
# 构建并发布灰度站 market-stage.icexiv.top（同源反代 Universalis）。
# 用法：ops/universalis-proxy/deploy/stage-deploy.sh [user@host]
set -euo pipefail

HOST="${1:-root@82.156.196.54}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET="/srv/market-stage.icexiv.top/www"

cd "$ROOT"

# 灰度站与正式站都编译成同源 /api/universalis；这里只是把产物发到灰度目录
VITE_SITE_TARGET=cn \
VITE_UNIVERSALIS_BASE=/api/universalis \
BASE_URL=/ \
  bun run build

# 站点目录不存在时先建出来（rsync 不会自己递归建父目录）
ssh "$HOST" "install -d -m 755 '$TARGET'"

rsync -rlt --delete --delay-updates --chmod=D755,F644 \
  -e ssh \
  --filter='P /_analytics/***' \
  app/dist/ "$HOST:$TARGET/"

echo "deployed to $HOST:$TARGET"
ssh "$HOST" "curl -s http://127.0.0.1:18090/stats || true"
