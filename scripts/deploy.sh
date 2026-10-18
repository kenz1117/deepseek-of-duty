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
    git push origin "$BRANCH" --quiet
    ok "已推送 origin/$BRANCH"
fi

step "4/6 上传构建产物与部署脚本"
ssh "$SERVER" "mkdir -p $APP_DIR/build"
scp -q "$TARBALL" "$SERVER:$APP_DIR/build/dist.tar.gz"
scp -q deploy/Dockerfile deploy/nginx-container.conf "$SERVER:$APP_DIR/build/"
scp -q scripts/server-deploy.sh "$SERVER:$APP_DIR/build/"
ok "已上传 → $SERVER:$APP_DIR/build/"

step "5/6 服务器原子部署（失败自动回滚）"
ssh "$SERVER" "bash $APP_DIR/build/server-deploy.sh $APP_DIR/build/dist.tar.gz"

step "6/6 线上验证"
sleep 1
code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/")
[ "$code" = "200" ] || fail "$SITE_URL 返回 $code"
ok "$SITE_URL → HTTP 200"

S=$(( $(date +%s) - T0 ))
printf '\n\033[1;32m🚀 部署完成，耗时 %ds → %s\033[0m\n' "$S" "$SITE_URL"
