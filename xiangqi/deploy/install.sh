#!/usr/bin/env bash
# First installation only. Existing applications and site files are never overwritten.
set -euo pipefail
umask 022

fail() { printf '安装停止：%s\n' "$*" >&2; exit 1; }
[[ "${EUID}" -eq 0 ]] || fail '请使用 sudo bash deploy/install.sh。'

APP_SOURCE="$(realpath "$(dirname "$0")/..")"
APP_TARGET=/opt/xiangqi
UNIT_TARGET=/etc/systemd/system/xiangqi.service
SITE_TARGET=/etc/nginx/conf.d/xiangqi.qyjai.com.conf
NGINX=/usr/sbin/nginx
NGINX_MAIN=/etc/nginx/nginx.conf

for program in node curl ss systemctl useradd getent; do
    command -v "$program" >/dev/null || fail "找不到命令：$program"
done
[[ -x /usr/bin/node && -x "$NGINX" ]] || fail 'Node 或 Nginx 路径与已确认环境不同。'
/usr/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || fail '需要 Node.js 20 或更高版本。'
[[ -f "$APP_SOURCE/scripts/serve.mjs" && -f "$APP_SOURCE/deploy/xiangqi.service" ]] || fail '请从完整部署包执行安装。'
[[ -d /etc/nginx/conf.d && ! -L /etc/nginx/conf.d ]] || fail 'Nginx 站点目录不存在或是符号链接，请先核实。'
for target in "$APP_TARGET" "$UNIT_TARGET" "$SITE_TARGET" /var/lib/xiangqi; do
    [[ ! -e "$target" && ! -L "$target" ]] || fail "已有文件或目录：$target；本脚本只用于首次安装，不覆盖已有内容。"
done
if systemctl cat xiangqi.service >/dev/null 2>&1; then fail '系统已有 xiangqi.service，请先核对。'; fi
if getent passwd xiangqi >/dev/null; then fail '系统已有 xiangqi 用户，请先核对。'; fi
if getent group xiangqi >/dev/null; then fail '系统已有 xiangqi 用户组，请先核对。'; fi
if find "$APP_SOURCE" -type l -print -quit | grep -q .; then fail '部署包目录含符号链接，请使用原始构建包。'; fi
[[ -z "$(ss -H -ltn 'sport = :5173')" ]] || fail '5173 端口已被占用。'
"$NGINX" -t -c "$NGINX_MAIN"
nginx_dump="$("$NGINX" -T -c "$NGINX_MAIN" 2>&1)"
grep -Fq '/etc/nginx/conf.d/*.conf' <<< "$nginx_dump" || fail '当前 Nginx 未加载 /etc/nginx/conf.d/*.conf。'
if grep -E '^[[:space:]]*server_name[[:space:]].*xiangqi\.qyjai\.com([[:space:];]|$)' <<< "$nginx_dump" >/dev/null; then
    fail 'Nginx 已有 xiangqi.qyjai.com 站点，请先核对。'
fi
unset nginx_dump

site_created=0
on_error() {
    local status=$?
    trap - ERR
    if [[ "$site_created" -eq 1 ]]; then
        # This exact file did not exist before this invocation and was created below.
        rm -f -- "$SITE_TARGET"
        "$NGINX" -t -c "$NGINX_MAIN" || true
    fi
    printf '安装未完成（退出码 %s）。保留应用文件和数据供排查；不会删除数据或改动其他站点。\n' "$status" >&2
    printf '查看日志：sudo journalctl -u xiangqi -n 60 --no-pager\n' >&2
    exit "$status"
}
trap on_error ERR

printf '安装应用到 %s\n' "$APP_TARGET"
useradd --system --user-group --home-dir /var/lib/xiangqi --shell /sbin/nologin xiangqi
install -d -m 0755 "$APP_TARGET"
for name in index.html styles.css admin.html admin.css package.json; do install -m 0644 "$APP_SOURCE/$name" "$APP_TARGET/$name"; done
for directory in src scripts deploy assets; do cp -R -- "$APP_SOURCE/$directory" "$APP_TARGET/"; done
find "$APP_TARGET" -type d -exec chmod 0755 {} +
find "$APP_TARGET" -type f -exec chmod 0644 {} +
install -m 0644 "$APP_TARGET/deploy/xiangqi.service" "$UNIT_TARGET"
systemctl daemon-reload
systemctl enable --now xiangqi.service

healthy=0
for attempt in {1..20}; do
    if systemctl is-active --quiet xiangqi.service && health_page="$(curl --max-time 2 --fail --silent http://127.0.0.1:5173/)" && [[ "$health_page" == *'id="board"'* ]]; then healthy=1; break; fi
    sleep 0.5
done
[[ "$healthy" -eq 1 ]] || fail '象棋服务尚未响应，请查看 journalctl -u xiangqi。'

install -d -m 0755 /var/www/xiangqi-acme/.well-known/acme-challenge
site_created=1
install -m 0644 "$APP_TARGET/deploy/nginx.http.conf" "$SITE_TARGET"
"$NGINX" -t -c "$NGINX_MAIN"
"$NGINX" -s reload -c "$NGINX_MAIN"
trap - ERR

printf '\n象棋服务与独立 HTTP 站点已安装。\n'
printf '本机验证：curl -I -H "Host: xiangqi.qyjai.com" http://127.0.0.1/\n'
printf '下一步：确认 xiangqi.qyjai.com 解析到 8.130.10.136，再签发 HTTPS 证书。\n'
printf 'HTTP 阶段后台登录暂不可用；HTTPS 配置完成后访问 /admin。\n'
printf '管理员首次密码保存在 /var/lib/xiangqi/admin-credentials.txt，请自行在服务器查看。\n'
