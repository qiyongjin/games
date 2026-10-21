# xiangqi.qyjai.com 部署文件

目标：Alibaba Cloud Linux 3，Node 位于 `/usr/bin/node`，Nginx 反代至 `127.0.0.1:5173`。

## 1. 域名解析

在 qyjai.com 的阿里云解析设置中添加：A / 主机记录 xiangqi / 记录值 8.130.10.136 / 默认线路。确认 `getent ahostsv4 xiangqi.qyjai.com` 返回该公网地址后，再申请证书。

## 2. 安装应用与常驻服务

构建包根目录包含 `scripts/`、`src/`、`index.html` 和本 `deploy/` 目录。应用最终安装在 `/opt/xiangqi`，数据始终存入 `/var/lib/xiangqi`，更新代码时不覆盖此数据目录。

对于已确认使用 `/usr/sbin/nginx -c /etc/nginx/nginx.conf`、加载 `/etc/nginx/conf.d/*.conf` 的这台服务器，先在独立上传目录（如 `~/xiangqi-upload`）解压部署包，再执行 `sudo bash ~/xiangqi-upload/deploy/install.sh`。不要提前创建 `/opt/xiangqi`；脚本会创建该目录，完成应用、低权限用户、常驻服务、ACME 目录和独立 HTTP 站点的首次安装。遇到已有同名目录、服务、用户、用户组、站点或端口占用时停止，不覆盖已有安装。它不申请证书，也不修改已有网站与防火墙。

以下命令仅供手动安装替代脚本：先将完整构建包放入 `/opt/xiangqi`，再配置用户与服务。已运行首次安装脚本时跳过此命令块。

```sh
id -u xiangqi || sudo useradd --system --user-group --home-dir /var/lib/xiangqi --shell /sbin/nologin xiangqi
sudo install -m 0644 /opt/xiangqi/deploy/xiangqi.service /etc/systemd/system/xiangqi.service
sudo systemctl daemon-reload
sudo systemctl enable --now xiangqi
sudo systemctl status xiangqi --no-pager
curl -I http://127.0.0.1:5173/
```

部署前确认没有已存在的同名 `xiangqi.service`，或先查看并备份原配置。代码目录应可供服务用户读取和遍历；配置启用了 ProtectHome，因此代码不能放在 `/root` 或仅个人用户可访问的 home 目录。StateDirectory 自动创建私有数据目录。

管理员首次随机密码仅保存在 `/var/lib/xiangqi/admin-credentials.txt`，可在服务器执行 `sudo cat /var/lib/xiangqi/admin-credentials.txt` 自行查看，不要把密码、该文件或 `state.json` 提交到代码仓库。

## 3. 识别现有 Nginx

这台服务器还有 BT-Panel 进程，不能仅根据 `command -v nginx` 决定配置目录。先检查运行中的 Nginx master 命令和二进制，再用同一实例的 `-T` 输出确定主配置与 http 层 include 目录。

先执行 `sudo ps -C nginx -o pid,ppid,args`。确认 master 使用的确实是 `/usr/sbin/nginx -c /etc/nginx/nginx.conf` 后，再执行：

```sh
sudo /usr/sbin/nginx -T -c /etc/nginx/nginx.conf 2>&1 | grep -E '^# configuration file|^[[:space:]]*include[[:space:]]'
```

如果 master 使用其他路径的二进制、`-c` 或 `-p`，请在检查、测试和 reload 时使用相同路径与参数。不要直接覆盖现有 nginx.conf，也不要重启其他网站的服务。

## 4. 子域名与 HTTPS

`nginx.http.conf` 是签发证书前的临时配置，只服务此子域；后台登录临时禁用。将其复制到已经确认被当前 Nginx 加载的 http 层配置目录，使用一个独立的站点配置文件名；如果该文件已存在，先备份并核对。

ACME 验证目录为 `/var/www/xiangqi-acme`，手动部署时先运行 `sudo install -d -m 0755 /var/www/xiangqi-acme/.well-known/acme-challenge` 并确认 Nginx 可读（首次安装脚本已执行）。例如使用 Certbot 的 webroot 模式时，`-w` 应填写此目录，`-d` 填写 `xiangqi.qyjai.com`。证书申请方式需结合服务器已有证书工具选择；不要停止现有 Nginx 抢占 80/443 端口。

证书签发后，`nginx.https.conf` 中的证书默认路径为 `/etc/letsencrypt/live/xiangqi.qyjai.com/`。若现有工具输出其他路径，应相应修改这两行证书文件路径。用 HTTPS 配置替换临时配置，不能同时加载两份同名域名配置。每次变更都先对同一 Nginx 实例执行 `-t`，成功后再 reload，并按实际证书工具配置自动续期与续期后的 reload。

对外只需现有 80/443，5173 保持本机监听。若出现反代 502，先查看应用状态和 Nginx 错误日志；遇到明确 SELinux AVC 拒绝时再针对性处理，不关闭 SELinux。

## 5. 验证与更新

上线后访问 `https://xiangqi.qyjai.com`，后台为 `/admin`。检查未登录 `/api/admin/stats` 返回 401、`/.data/state.json` 返回 404；用两个浏览器实测邀请、准备和轮流落子。

更新时重新构建并复制公开应用文件，保留 `/var/lib/xiangqi`，然后 `sudo systemctl restart xiangqi`。服务为单实例，重启会结束当前在线房间，统计和管理员密码保留。
