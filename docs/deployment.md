# US 部署记录

## 2026-10-24：地图服务器列表接口待部署

公网 `GET /api/instances?page=1&pageSize=20` 携带 `Origin: http://127.0.0.1:8791` 实测为 Nginx 403 HTML，缺少 CORS 头，浏览器因而报告 `Failed to fetch`。本地网关已有该接口，线上容量版本尚未包含它；仅修改网页错误文案不能恢复列表。

部署时先基于实际运行的容量版本准备独立发布目录，仅移入 `gateway/registry.js` 的分页列表、指定实例选择变更，以及 `gateway/server.js` 的公开列表 GET/OPTIONS 路由与 CORS 分支。不要整包复制当前工作区，其中存在其他未部署的认证与私有房间开发。验证功能测试通过后切换 systemd，并保留原目录和 drop-in 备份。

Nginx 的现有 TLS server 中需增加精确路由（保留其余管理接口限制；CORS 由网关返回）：

```nginx
location = /api/instances {
    limit_except GET OPTIONS { deny all; }
    proxy_pass http://127.0.0.1:8797;
    proxy_set_header Host $host;
}
```

修改前备份实际配置，执行 `nginx -t` 成功后 reload。验收 GET 返回 200 JSON、`Access-Control-Allow-Origin: *`、分页数据只包含编号/人数/容量/状态，OPTIONS 返回 204；无 token 入场仍返回 401，管理写接口仍为 403。最后在正式 Haqi 页面检查列表与真实账号切服 welcome，不能用接口探测替代入场验收。

本轮本机无可用 SSH 密钥，非交互 root 登录被拒绝，因此尚未执行线上部署或 Nginx 修改。

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
| 已部署源码 | 任意来源及10连接版本追加容量修复，发布目录 `capacity-20261024`，未提交Git |
| systemd 服务 | `haqi-game-server-lite.service`，开机自启、故障自动重启 |

2026-10-23 18:47（北京时间）真实Keepwork账号公网验收：HTTPS health 200、CORS预检204、无凭据/无效token/用户名不一致均401；正确身份双客户端WSS welcome、成员与移动同步、离房及重连通过。Haqi源码入口已接入，网页尚未发布；AI-work-company和AIChat待接入。

本地正式Haqi.html另经Edge隔离浏览器真实账号验证：join 200、welcome及连续moved，界面显示已连接游戏服务器，页面异常0；没有进行游戏或存档写入操作。

## 运行与访问边界

- Node 服务仅监听 `127.0.0.1:8797/8798`，Nginx 443提供TLS代理，80仅用于ACME挑战；旧8797仅保留health，其他请求及8798返回426，不再接受明文token或票据。
- 公网管理页可查看状态；`/api/register`、`/api/heartbeat` 和 `/api/admin/action` 返回 403。管理操作通过 SSH 隧道访问本机网关，仍需管理口令。
- 服务端固定向Keepwork profile API验证token及username；世界服验证60秒一次性签名票据。具体边界见 `docs/integration.md`，尚未做角色资产授权。
- `PRESENCE_PUBLIC_SOCKET_URL=wss://us1.gameserver.keepwork.com/world/{port}`；Nginx仅代理8798–8817。2026-10-23用户更新：入场CORS现为 `*`，任意页面来源均可请求；每次入场仍核验Keepwork token和username，管理接口不开放CORS。
- Let's Encrypt证书于2026-10-23签发，到期2027-01-21；certbot自动续期，`/etc/letsencrypt/renewal-hooks/deploy/haqi-nginx.sh`成功后校验并reload Nginx。私钥只在服务器。
- 凭据不存入 Git。服务环境文件位于服务器 `/etc/haqi-game-server-lite/presence.env`，权限为 600。

## 运维路径

- 当前实际运行目录：`/opt/haqi-game-server-lite/releases/capacity-20261024`；旧认证版本保留在 `auth-20261023`。systemd drop-in `haqi-game-server-lite.service.d/auth.conf`明确覆盖WorkingDirectory与ExecStart；旧current链接仍指向原版本，不用它判断运行版本。
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


## 2026-10-23 23:02：本地3002来源被拒（排查记录，现已修复）

用户实际页面为 `http://127.0.0.1:3002/Haqi.html`。公网 OPTIONS `/api/join` 携带该 Origin 实测返回403，JSON为 `{"ok":false,"error":"origin"}`；浏览器不会继续发出带token的POST。这是已复现的连接阻断点。

本地 `.env.example` 已加入精确来源 `http://127.0.0.1:3002`。这不会修改现有公网服务。运维需要在 `/etc/haqi-game-server-lite/presence.env` 的现有 `PRESENCE_ALLOWED_ORIGINS` 末尾追加 `,http://127.0.0.1:3002`，保留全部原值和其他配置，随后重启 `haqi-game-server-lite.service`（现有连接会短暂重连）。不得改为任意来源通配或关闭账号鉴权。

应用后检查该来源预检204、Allow-Origin精确回显；缺token仍401，未登记来源仍403，再在用户页面确认POST join成功与WSS welcome。当前机器没有可用SSH配置，尚未执行公网变更，不宣称修复已上线。

本地验证：`npm test` 28/28通过，新增回归覆盖3002预检放行、缺token仍401、未登记端口及伪造域名仍403。


## 2026-10-23 23:42：3002来源修复已应用公网

用户授权通过本机SSH操作服务器。现场核实：白名单实际位于 `/etc/systemd/system/haqi-game-server-lite.service.d/auth.conf` 的 `Environment="PRESENCE_ALLOWED_ORIGINS=..."`，并非上节推测的环境文件（该环境文件没有此键）。仅在实际配置末尾追加 `http://127.0.0.1:3002`，原来源及其余配置不变。备份为同目录 `auth.conf.before-origin-3002`。执行 daemon-reload 和服务restart后状态active，SSH会话已退出。没有部署源码或记录凭据。

公网实测：health 200；3002 OPTIONS 204且Allow-Origin精确回显；原CDN来源仍204；未登记3003端口及其他域名仍403；3002无token的POST仍401/auth-required且包含正确CORS头。来源阻断已修复。未使用真实Keepwork账号进行本轮WSS welcome验收，不能将以上探测宣称为角色实际入场。


## 2026-10-23：任意来源与同账号10客户端已部署

用户要求允许所有127.0.0.1端口及其他IP/页面来源，凭有效Keepwork token入场，并允许同账号最多10个客户端。已在既有认证包的独立副本 `multiclient-20261023` 中仅应用auth、网关CORS、世界服连接名额与默认来源补丁；未带入本地其他统计功能。票据签名、用户名核验、TLS及管理接口限制保留；同角色新连接使用随机playerId，不再替换旧连接。共享auth同步限制10条，拒绝第11条并在断开/失败时释放名额。

systemd的 `auth.conf` 已切换WorkingDirectory和ExecStart到新目录，`PRESENCE_ALLOWED_ORIGINS=*`；旧配置备份为 `auth.conf.before-multiclient`。daemon-reload/restart后active。回退可恢复此备份并reload/restart，旧运行目录保留。

本地功能测试31/31、Haqi连接专项11/11通过；服务器隔离发布包功能测试25/25通过，包含任意来源、无效token拒绝、同账号同角色10连接、并发第11条拒绝、跨项目/token/世界服合并限额、另一账号不受影响、断开和失败释放。上游Keepwork profile在这些功能测试中为受控stub，使用实际HTTP和WebSocket；不能当作真实Keepwork账号多开验收。

容量测试如实记录：本机新版本spread far relay 1311.7ms，未修改HEAD基线1289.7ms，均超过800ms门槛；服务器新旧发布包均在presence_capacity.test.mjs:111慢连接断言失败。上述容量失败并非本次改动引入，未跳过或修改门槛，不宣称容量验收通过。


公网复测：health 200；127.0.0.1的3002/65535端口、其他IPv4、IPv6、域名、null来源及原CDN来源均OPTIONS 204并返回Allow-Origin `*`。无token POST 401/auth-required；假token首轮遇到上游超时返回503/auth-unavailable，重测401/token-invalid；未把503算作鉴权成功。管理写接口仍403，未带通配CORS头。未取得本轮真实Keepwork会话，未进行公网真实账号10客户端入场验收；服务端实际HTTP/WebSocket限额行为已通过发布包隔离测试。

本次补丁传输包SHA-256：`180ce91061da2e1f4d6d88a7966f47ab3ea9e5e7c32a91584bb41c5f7810e5ce`。密码未写入代码、配置或日志。SSH操作完成后退出；Git未提交/推送，Haqi网页未发布。


## 2026-10-24：容量修复上线

部署目录 `capacity-20261024`，配置备份 `haqi-game-server-lite.service.d/auth.conf.before-capacity-20261024`，原 `multiclient-20261023` 目录保留。仅安装格子查询、发送队列预算及相应测试的修复。服务器功能26/26、完整容量1/1通过（远距广播162.1ms、8000连接群发60.1ms）；本机Windows模拟广播与慢连接测试通过，但真实群发仍约4705ms超标，完整本机容量未通过。详细原因、名单一致性和原门槛验证见[当日开发日志](devlog/devlog_2026-10-24.md)。公网health200、任意本地端口预检204，服务active；未发布网页或提交推送Git。

## 2026-10-24：服务器列表修复已上线，本机 SSH 已配置

- 本机 Windows 已配置 `ssh haqi-us1`；`ssh root@43.130.151.173` 和 `ssh root@us1.gameserver.keepwork.com` 也使用同一专用密钥。配置位于当前用户 `.ssh/config`，私钥为 `.ssh/haqi_us1_ed25519`，仅本机 Administrator/SYSTEM 可读；服务端公钥追加到 root authorized_keys，保留既有登录配置。已用 BatchMode 验证免密码登录。后续先使用此配置，不再重复请求密码。密码未保存到文件或仓库。
- 基于实际 `capacity-20261024` 创建独立 `instances-20261024` 发布包，仅更新网关 registry/server 与列表回归测试，未带入本地并行认证/私有房间开发。当前运行目录已切换为 `/opt/haqi-game-server-lite/releases/instances-20261024`。
- Nginx 新增精确 `/api/instances` GET/OPTIONS 代理；旧配置分别保留为 `haqi-game-server-lite.conf.before-instances-20261024` 和 `auth.conf.before-instances-20261024`。nginx -t 通过，服务重启及代理 reload 成功。
- 生产服务器发布包全部 28/28 测试通过（含鉴权、同账号10连接、分页及8000连接容量）；Windows 同包 27/28，8000连接 fanout 5173.9ms 超过1000ms门槛，既有平台性能失败仍未解决。
- 公网 3002 来源 GET 200，返回服务器1、容量500、真实人数和状态；65535来源 OPTIONS 204，均允许跨域。无 token POST join 401/auth-required，管理写接口仍403。未使用真实Keepwork账号验证本轮切服 welcome，未进行浏览器完整发布验收。Git未提交或推送。


## 2026-10-24：同角色接管部署

用户明确授权部署并使用两个真实页面验收，明确本次不跑8000人负载。起初基于在线 capacity-20261024 提取隔离包（SHA256 `1473187f1b251c656463a5d435f75d616bfe20113ac04fdd562b83cbc52edb98`），本机及服务器27/27功能通过。部署期间另一路已上线 instances-20261024；现场核对 auth.js、gameserver/index.js、gameserver/instance.js 三文件与容量基线一致，遂从该新版本复制 instances-takeover-20261024，仅安装上述三个接管模块及 auth 测试，保留列表接口与Nginx配置。合并包服务器28/28通过。

实际运行目录为 `/opt/haqi-game-server-lite/releases/instances-takeover-20261024`，systemd active。回滚配置为 `/etc/systemd/system/haqi-game-server-lite.service.d/auth.conf.before-instances-takeover-20261024`，恢复后 daemon-reload/restart 可回到 instances-20261024。旧目录保留，不改变服务环境密钥、TLS和鉴权。公网 health200，服务器列表200/CORS *，无token入场401。

正式源码页面 `http://127.0.0.1:3002/Haqi.html` 两个既有Chrome页，真实Keepwork账号 lixizhi / 5级寒冰系小哈奇：第一页入场后，第二页继续旅程成功，第二页设置明确显示“已连接游戏服务器 · https://us1.gameserver.keepwork.com”；第一页显示“该角色已在其他页面登录，你已被踢下线，请重新登录”并返回“选择进入方式 / 登录 Keepwork / 本地访客”。没有读取或保存浏览器token。网页源码经本地HTTP提供，本次没有发布网页CDN、Git提交或推送。

后续防重连验收：手动刷新被踢A页后仍停留登录入口，再额外等待35秒，A仍显示被踢提示、B设置仍显示已连接美国一区；没有自动抢回或循环互踢。

## 2026-10-24：Keepwork鉴权间歇性503已修复

实际运行目录切换至 `/opt/haqi-game-server-lite/releases/auth-network-20261024`。从在线instances-takeover-20261024复制，仅修改入口node:net地址尝试窗口下限为1500ms；没有带入本地其他未部署功能。配置备份 `/etc/systemd/system/haqi-game-server-lite.service.d/auth.conf.before-auth-network-20261024`，恢复后daemon-reload/restart即可回滚。服务active、health200。

根因现场复现：IPv4 TCP握手约332ms，大于Node默认250ms地址尝试窗口，提前放弃后IPv6 ENETUNREACH；Node fetch因此间歇性ETIMEDOUT。1500ms下8次profile请求预期401；部署后12次公网无效token join均401/token-invalid，无503。鉴权总超时8秒、HTTPS、用户名一致性及票据均保留。真实Chrome 127.0.0.1:3002/Haqi.html既有lixizhi会话进入5级寒冰系小哈奇，进入魔法营地并显示已连接游戏服务器。未读取token。

本地npm test 37/37；隔离服务器功能28/28。最初远程测试管道因PowerShell行尾导致tail报错/EPIPE，随后去掉管道完整重跑通过；未把首次失败计为通过。未运行容量负载，未提交推送Git。

## 2026-10-24：远端玩家名单补齐已部署

在线目录 `/opt/haqi-game-server-lite/releases/remote-avatars-20261024` 从auth-network-20261024隔离复制，仅扩充gameserver/instance.js的roster字段（appearance/revision/x/y/facing），增加晚入场回归。配置备份 `/etc/systemd/system/haqi-game-server-lite.service.d/auth.conf.before-remote-avatars-20261024`，恢复后daemon-reload/restart可回滚。服务active，原目录保留。

本地npm test 38/38、发布包功能29/29通过。两个真实Chrome Haqi源码页面分别进入5级小哈奇与50级小虎队 - 西咪，双方可见对方，移动后另一页面位置同步。网页增加名单处理与独立远端人物渲染；未发布网页CDN，Git未提交推送。未改变定时广播算法与连接容量，未跑8000连接负载。

## 2026-10-24：AIChat 私有账号房间已部署

用户明确要求服务端先部署。实际运行目录为 `/opt/haqi-game-server-lite/releases/private-rooms-20261024`，systemd active。从在线 auth-network 版本准备隔离包；切换前发现另一部署已上线 remote-avatars，保护检查中止切换。核对两版本仅 instance.js 与 presence_server 测试有差异后，保留最新头像处理与测试，重新验证再切换。保留既有容量、公开实例列表、同角色接管、十连接限制及 Keepwork 网络超时修复，未带入本地 analytics 功能。Nginx、TLS、环境密钥未改。

初始隔离包本机 npm test 31/31、生产机器功能31/31通过；合并在线头像更新后生产机器32/32通过，所有服务端JS语法检查通过。私有房间测试使用真实HTTP/WebSocket及受控Keepwork身份夹具，覆盖同账号、跨账号拒绝、伪造归属/隐私、跨实例中继、换房拒绝与公开管理隐私；本轮未使用真实账号验证公网私有会话。公网 health200、instances200/CORS *、join预检204/CORS *、无token私有入场401、管理写接口403；匿名管理状态不含privateRooms。按最新部署约定未重跑8000人负载。

原上传包SHA256为 `56ab34804bf5b1e21599a6bf480bb98a3ec9402f6872c3eb81468dd93813603c`（随后合并上述两个在线文件，不代表最终目录校验和）。线上 private_rooms.js SHA256为 `d8beaab9ec86c4b9aa5f45eb146205fcdc9b5a13d2cc5994cca884cb043b0c65`。测试日志 `/tmp/private-rooms-20261024-tests.log`。

回滚：将 `/etc/systemd/system/haqi-game-server-lite.service.d/auth.conf.before-private-rooms-20261024` 复制回同目录 `auth.conf`，执行 `systemctl daemon-reload` 和 `systemctl restart haqi-game-server-lite.service`，即回到保留的 remote-avatars-20261024。回滚前先确认运行版本仍为本次版本，避免覆盖后续部署。AIChat前端未发布，Git未提交或推送。

## 2026-10-24：通用账号房间中继已部署

用户授权泛化并部署。运行目录 `/opt/haqi-game-server-lite/releases/account-relay-20261024`，从实际在线private-rooms-20261024制作隔离包，仅修改auth、private_rooms、gameserver入口、gateway入口及私有房间测试；未带入未部署analytics。部署前确认运行版本未变化，并逐字节核验主入口网络修复、socket、instance头像/游戏逻辑、registry保持原样；所有JS语法检查通过。Nginx、TLS和环境密钥未改。

新接口roomType=account允许任意有效project命名空间，account.relay.v1只转发opaque JSON并填写认证sender。同账号不同应用隔离；所有AIChat通道/请求响应解释移至AIChat。旧AIChat客户端能力检查失败关闭远控，不回退公共房间；前端源码已适配但未发布。普通游戏协议与同角色接管保持不变。

验证：本机完整服务器npm test 41/41；隔离发布包本机35/35、生产机器35/35（Keepwork身份使用受控夹具，HTTP/WebSocket真实）；AIChat 10项单元、2项Edge浏览器测试通过（双桌面、移动视口、无第二大脑真实shell）。公网health200、instances200/CORS *、join预检204/CORS *、无token通用账号入场401、admin/action403、匿名state无私有信息。没有使用真实账号验证公网私有会话；未修改容量/广播或重跑8000人负载。

包SHA256 `bda5dbac813e381415596c9bbf63706cfe2b1441fc7701f186f151d7e43bf38b`。服务器测试日志 `/tmp/account-relay-20261024-tests.log`。回滚配置 `/etc/systemd/system/haqi-game-server-lite.service.d/auth.conf.before-account-relay-20261024`；确认没有后续部署后复制为同目录auth.conf，再daemon-reload/restart服务，回到保留的private-rooms-20261024。Git未提交或推送，AIChat未构建或发布。
