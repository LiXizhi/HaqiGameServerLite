# US 部署记录

更新日期：2026-10-23。

## 当前服务器

| 项目 | 当前配置 |
| --- | --- |
| 服务器 | haqi-web服务器－弗吉尼亚一区 |
| 公网 IP | `43.130.151.173` |
| 域名 | `us1.gameserver.keepwork.com`，DNS A 记录指向上述 IP |
| 管理页 | <https://us1.gameserver.keepwork.com/admin> |
| 网关 | `https://us1.gameserver.keepwork.com` |
| 世界服 | `wss://us1.gameserver.keepwork.com/world/8798` |
| 系统 / 运行时 | Ubuntu 24.04 / Node.js 22.23.1 |
| 已部署源码 | `147f88c20c1946e1e51927ccde5e336ef9613ce1` 基础上的本地认证补丁，发布目录 `auth-20261023`，未提交Git |
| systemd 服务 | `haqi-game-server-lite.service`，开机自启、故障自动重启 |

2026-10-23 18:47（北京时间）真实Keepwork账号公网验收：HTTPS health 200、CORS预检204、无凭据/无效token/用户名不一致均401；正确身份双客户端WSS welcome、成员与移动同步、离房及重连通过。Haqi源码入口已接入，网页尚未发布；AI-work-company和AIChat待接入。

本地正式Haqi.html另经Edge隔离浏览器真实账号验证：join 200、welcome及连续moved，界面显示已连接游戏服务器，页面异常0；没有进行游戏或存档写入操作。

## 运行与访问边界

- Node 服务仅监听 `127.0.0.1:8797/8798`，Nginx 443提供TLS代理，80仅用于ACME挑战；旧8797仅保留health，其他请求及8798返回426，不再接受明文token或票据。
- 公网管理页可查看状态；`/api/register`、`/api/heartbeat` 和 `/api/admin/action` 返回 403。管理操作通过 SSH 隧道访问本机网关，仍需管理口令。
- 服务端固定向Keepwork profile API验证token及username；世界服验证60秒一次性签名票据。具体边界见 `docs/integration.md`，尚未做角色资产授权。
- `PRESENCE_PUBLIC_SOCKET_URL=wss://us1.gameserver.keepwork.com/world/{port}`；Nginx仅代理8798–8817。CORS允许Keepwork两个域名及localhost/127.0.0.1的8791、5173端口，不接受任意来源。
- Let's Encrypt证书于2026-10-23签发，到期2027-01-21；certbot自动续期，`/etc/letsencrypt/renewal-hooks/deploy/haqi-nginx.sh`成功后校验并reload Nginx。私钥只在服务器。
- 凭据不存入 Git。服务环境文件位于服务器 `/etc/haqi-game-server-lite/presence.env`，权限为 600。

## 运维路径

- 当前实际运行目录：`/opt/haqi-game-server-lite/releases/auth-20261023`。systemd drop-in `haqi-game-server-lite.service.d/auth.conf`明确覆盖WorkingDirectory与ExecStart；旧current链接仍指向原版本，不用它判断运行版本。
- 本轮发布包SHA-256：`620870a6638a0cc4cb927916b3b65d3334b73372b3816971d939c2f5fe94bb69`。仅含认证改动，不含并行统计开发。发布包隔离测试21/21，服务器现场认证测试3/3通过；共享工作区测试25/25、8000人容量测试1/1通过。
- Node 可执行文件：`/opt/haqi-game-server-lite/runtime/node`。
- systemd 配置：`/etc/systemd/system/haqi-game-server-lite.service`。
- Nginx 配置：`/etc/nginx/conf.d/haqi-game-server-lite.conf`。
- Nginx原配置备份：`/etc/nginx/haqi-game-server-lite.pre-auth.conf`；回滚应用需移除auth drop-in并恢复旧ExecStart，但不要恢复未鉴权公网入场。保留TLS并暂停join直到认证恢复。
- `ExecStart` 使用发布目录的真实路径；当前入口检查不支持使用 `current` 符号链接路径启动。

在服务器上查看状态与日志：

```sh
systemctl status haqi-game-server-lite
journalctl -u haqi-game-server-lite -n 50 --no-pager
curl -fsS http://127.0.0.1:8797/api/health
```

## 迁移记录

2026-10-23 从 `43.165.70.60` 迁移到 `43.130.151.173`。旧服务器上的服务已停止并禁用开机自启，旧端口代理及对应云防火墙放行规则已撤销；旧发布文件保留。
