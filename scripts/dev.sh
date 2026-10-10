#!/usr/bin/env bash
# KDJ 开发会话：start | stop | restart | status | logs [行数]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/kdj-dev.log"
APP_BIN="$ROOT/target/debug/kdj-app"
PATTERNS=(
  "$ROOT/node_modules/.bin/tauri dev"
  "$ROOT/node_modules/.bin/vite --config vite.tauri.config.ts"
  "$APP_BIN"
)

running_pids() {
  for p in "${PATTERNS[@]}"; do pgrep -f -- "$p" || true; done | sort -u
}

vite_url() {
  grep -m1 -o 'http://localhost:[0-9]*' "$LOG" 2>/dev/null || true
}

wait_ready() {
  local deadline=$((SECONDS + 240))
  while (( SECONDS < deadline )); do
    if grep -qE '^error(\[|:)' "$LOG" 2>/dev/null && [[ -z "$(running_pids)" ]]; then
      echo "启动失败，编译错误："
      grep -m3 -E '^error(\[|:)' "$LOG"
      echo "完整日志: $LOG"
      return 1
    fi
    if [[ -n "$(vite_url)" && -f "$APP_BIN" && -n "$(pgrep -f -- "$APP_BIN" || true)" ]]; then
      status
      return 0
    fi
    sleep 2
  done
  echo "超时未就绪，查看日志: scripts/dev.sh logs"
  return 1
}

start() {
  if [[ -n "$(running_pids)" ]]; then
    echo "已在运行，复用现有会话"
    status
    return 0
  fi
  : > "$LOG"
  (cd "$ROOT" && env -u KDJ_DATA_DIR -u KDJ_DOWNLOAD_DIR nohup npm run dev >"$LOG" 2>&1 &)
  echo "启动中（首次编译较慢）..."
  wait_ready
}

stop() {
  local pids
  pids="$(running_pids)"
  if [[ -z "$pids" ]]; then
    echo "未在运行"
    return 0
  fi
  # 先正常退出，让应用有机会落盘；超时后才强制结束
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    [[ -z "$(running_pids)" ]] && break
    sleep 1
  done
  pids="$(running_pids)"
  if [[ -n "$pids" ]]; then
    echo "正常退出超时，强制结束: $pids"
    kill -9 $pids 2>/dev/null || true
  fi
  echo "已停止"
}

status() {
  local pids
  pids="$(running_pids)"
  if [[ -z "$pids" ]]; then
    echo "未在运行"
    return 1
  fi
  echo "运行中  pid: $(echo $pids)"
  echo "前端: $(vite_url)"
  echo "日志: $LOG"
}

logs() {
  tail -n "${1:-80}" "$LOG"
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    logs "${2:-80}" ;;
  *)
    echo "用法: scripts/dev.sh start|stop|restart|status|logs [行数]"
    exit 2
    ;;
esac
