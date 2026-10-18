#!/usr/bin/env bash
# DEEPSEEK OF DUTY 一键部署：构建 → 推送 GitHub → 同步服务器 → 健康检查
#
# 用法:
#   scripts/deploy.sh                 # 完整流程：构建 + 提交推送 + 服务器部署 + 线上验证
#   SKIP_GIT=1 scripts/deploy.sh      # 跳过 git 提交/推送，只同步服务器
#   DEPLOY_COMMIT_MSG="..." scripts/deploy.sh
#
# 环境变量（一般不用改）:
#   SERVER=root@8.136.26.140  APP_DIR=/opt/dod-web  SITE_URL=https://dod.goodpoint.top
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${SERVER:-root@8.136.26.140}"
APP_DIR="${APP_DIR:-/opt/dod-web}"
SITE_URL="${SITE_URL:-https://dod.goodpoint.top}"
COMMIT_MSG="${DEPLOY_COMMIT_MSG:-chore(deploy): sync site build $(date '+%F %H:%M')}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
T0=$(date +%s)

step "0/6 预检"
command -v npm >/dev/null || fail "本地没有 npm"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$SERVER" 'echo ok' >/dev/null 2>&1 || fail "无法 SSH 到 $SERVER"
ok "SSH 连通: $SERVER"

step "1/6 本地构建"
npm run build >/dev/null
[ -f dist/index.html ] || fail "构建产物缺失"
ok "vite build 完成（dist/）"

step "2/6 打包构建产物"
# macOS/BSD mktemp 要求 X 在模板末尾；tar 不在乎扩展名，上传到服务器时固定命名为 dist.tar.gz
TARBALL=$(mktemp /tmp/dod-dist.XXXXXXXX)
trap 'rm -f "$TARBALL"' EXIT
tar --exclude='.DS_Store' -czf "$TARBALL" -C dist .
ok "$(du -h "$TARBALL" | cut -f1) → $TARBALL"

step "3/6 推送 GitHub"
if [ "${SKIP_GIT:-0}" = "1" ]; then
    echo "SKIP_GIT=1，跳过"
else
    git add -A
    if git diff --cached --quiet; then
        echo "工作区干净，无新提交"
    else
        git commit -m "$COMMIT_MSG" --quiet
        ok "已提交: $COMMIT_MSG"
    fi
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    # 远端可能有人在网页上直接改过（如 README），先 rebase 再推；有真冲突才停下来
    git fetch origin "$BRANCH" --quiet
    if ! git merge-base --is-ancestor origin/"$BRANCH" HEAD; then
        git rebase origin/"$BRANCH"
        ok "已 rebase 到 origin/$BRANCH"
    fi
    git push origin "$BRANCH" --quiet
    ok "已推送 origin/$BRANCH"
fi

step "4/7 上传构建产物与部署脚本"
ssh "$SERVER" "mkdir -p $APP_DIR/build /opt/dod-leaderboard/data"
scp -q "$TARBALL" "$SERVER:$APP_DIR/build/dist.tar.gz"
scp -q deploy/Dockerfile deploy/nginx-container.conf "$SERVER:$APP_DIR/build/"
scp -q scripts/server-deploy.sh "$SERVER:$APP_DIR/build/"
scp -q server/leaderboard.mjs "$SERVER:/opt/dod-leaderboard/"
ok "已上传 → $SERVER:$APP_DIR/build/ 与 /opt/dod-leaderboard/"

step "5/7 服务器原子部署（失败自动回滚）"
ssh "$SERVER" "bash $APP_DIR/build/server-deploy.sh $APP_DIR/build/dist.tar.gz"

step "6/7 排行榜服务更新"
ssh "$SERVER" '
  if docker ps -a --format "{{.Names}}" | grep -qx dod-leaderboard; then
    docker restart dod-leaderboard >/dev/null && echo "dod-leaderboard 已重启"
  else
    [ -f /opt/dod-leaderboard/.secret ] || (openssl rand -hex 32 > /opt/dod-leaderboard/.secret && chmod 600 /opt/dod-leaderboard/.secret)
    docker run -d --name dod-leaderboard --restart unless-stopped \
      -v /opt/dod-leaderboard:/app -w /app -p 127.0.0.1:8320:8787 \
      -e PORT=8787 -e LB_DATA_DIR=/app/data -e LB_SECRET="$(cat /opt/dod-leaderboard/.secret)" \
      node:20-alpine node leaderboard.mjs >/dev/null && echo "dod-leaderboard 已创建"
  fi
  sleep 1
  curl -fsS http://127.0.0.1:8320/api/health >/dev/null && echo "排行榜健康检查通过"
'

step "7/7 线上验证"
sleep 1
code=$(curl -s -o /dev/null -w "%{http_code}" "$SITE_URL/")
[ "$code" = "200" ] || fail "$SITE_URL 返回 $code"
ok "$SITE_URL → HTTP 200"
api=$(curl -s -o /dev/null -w "%{http_code}" "$SITE_URL/api/health")
[ "$api" = "200" ] || fail "$SITE_URL/api/health 返回 $api"
ok "$SITE_URL/api/health → HTTP 200"

S=$(( $(date +%s) - T0 ))
printf '\n\033[1;32m🚀 部署完成，耗时 %ds → %s\033[0m\n' "$S" "$SITE_URL"
