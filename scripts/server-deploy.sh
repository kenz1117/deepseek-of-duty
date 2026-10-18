#!/usr/bin/env bash
# 服务器端原子部署脚本（由 scripts/deploy.sh 或 GitHub Actions 上传构建产物后调用）
# 用法: server-deploy.sh <dist-tarball-path>
# 流程: 解压 → 构建带时间戳镜像 → 切换容器 → 健康检查 → 失败自动回滚旧镜像
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dod-web}"
CONTAINER="${CONTAINER:-dod-web}"
HOST_PORT="${HOST_PORT:-8310}"
CONTAINER_PORT=8080
KEEP_RELEASES=3
HEALTH_RETRIES=15

TS=$(date +%Y%m%d-%H%M%S)
BUILD_DIR="$APP_DIR/build"
RELEASE_DIR="$APP_DIR/releases/$TS"
TARBALL="$1"

log()  { printf '\n\033[1;36m[server] %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[server] ✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m[server] ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "${TARBALL:-}" ] && [ -f "$TARBALL" ] || fail "用法: server-deploy.sh <dist-tarball-path>"
[ -f "$BUILD_DIR/Dockerfile" ] || fail "缺少 $BUILD_DIR/Dockerfile（先上传 deploy/Dockerfile 与 nginx-container.conf）"

log "解压构建产物 → $RELEASE_DIR"
mkdir -p "$RELEASE_DIR/dist"
tar -xzf "$TARBALL" -C "$RELEASE_DIR/dist"
[ -f "$RELEASE_DIR/dist/index.html" ] || fail "tarball 里没有 index.html"
cp "$BUILD_DIR/Dockerfile" "$BUILD_DIR/nginx-container.conf" "$RELEASE_DIR/"

# 记住当前线上镜像，用于失败回滚
PREV_TAG=""
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    PREV_TAG="previous"
    docker tag "$(docker inspect -f '{{.Image}}' "$CONTAINER")" "dod-web:$PREV_TAG"
    ok "已标记回滚点: dod-web:$PREV_TAG"
fi

log "构建镜像 dod-web:$TS"
docker build -t "dod-web:$TS" -t "dod-web:latest" "$RELEASE_DIR" >/dev/null

log "切换容器 $CONTAINER (127.0.0.1:$HOST_PORT)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --restart unless-stopped \
    -p "127.0.0.1:$HOST_PORT:$CONTAINER_PORT" "dod-web:$TS" >/dev/null

log "健康检查（最多 ${HEALTH_RETRIES} 次）"
healthy=0
for i in $(seq 1 $HEALTH_RETRIES); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/" || true)
    if [ "$code" = "200" ]; then healthy=1; break; fi
    sleep 1
done

if [ "$healthy" != "1" ]; then
    if [ -n "$PREV_TAG" ]; then
        printf '\033[1;31m[server] ✗ 健康检查失败，回滚到 dod-web:%s\033[0m\n' "$PREV_TAG" >&2
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
        docker run -d --name "$CONTAINER" --restart unless-stopped \
            -p "127.0.0.1:$HOST_PORT:$CONTAINER_PORT" "dod-web:$PREV_TAG" >/dev/null
        sleep 1
        curl -fsS -o /dev/null "http://127.0.0.1:$HOST_PORT/" \
            && ok "已回滚，线上恢复旧版本" \
            || printf '\033[1;31m[server] ✗ 回滚后仍不健康，需人工介入\033[0m\n' >&2
    fi
    fail "部署失败"
fi
ok "健康检查通过 (HTTP 200)"

# 清理：每次安装后回收备份与缓存
# 1) 版本目录只保留最近 KEEP_RELEASES 个
ls -1dt "$APP_DIR/releases"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
# 2) 历史版本镜像只保留最近 KEEP_RELEASES 个（latest/previous 两个指针除外）
docker images "dod-web" --format '{{.Tag}}' \
    | grep -Ev '^(latest|previous)$' | sort -r | tail -n +$((KEEP_RELEASES + 1)) \
    | while read -r t; do docker rmi "dod-web:$t" >/dev/null 2>&1 || true; done
# 3) 悬空镜像与 7 天前的 Docker 构建缓存
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || true
# 4) 过期的构建暂存 tar 包
find "$APP_DIR/build" -name '*.tar.gz' -mtime +1 -delete 2>/dev/null || true
ok "清理完成（版本目录/镜像保留 ${KEEP_RELEASES} 份，构建缓存仅留 7 天内）"
ok "磁盘占用: $(du -sh "$APP_DIR/releases" 2>/dev/null | cut -f1) releases · $(docker images "dod-web" -q | wc -l | tr -d " ") 个 dod-web 镜像"

ok "部署完成: dod-web:$TS（线上 http://127.0.0.1:$HOST_PORT）"
