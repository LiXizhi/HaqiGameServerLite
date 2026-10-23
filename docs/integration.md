# 三个项目共享服务器

通用私有账号房间使用 `roomType:"account"` 与 `account.relay.v1`，任意应用可独立演进payload协议；服务器只认证、隔离及中继。参见 [私有房间协议](private-rooms.md) 与部署记录。

HaqiCombatSim、AI-work-company 和 AIChat 使用同一部署的网关及世界服。各项目配置网关 URL，无需相互引用源码，也无需各自启动一份服务器。2026-10-23 Haqi 本地正式入口已接入认证连接；AI-work-company 和 AIChat 仍待各自接入。Haqi 网页尚未发布本轮修改。

## 2026-10-23 账号认证（当前公网必需）

网关为 `https://us1.gameserver.keepwork.com`。POST `/api/join` 使用 `Authorization: Bearer <Keepwork token>`，正文为 `{username, project, roleId, roomId, x, y}`。`project` 允许 `haqi`、`awc`、`aichat`；`roleId` 为1–64位英文数字、下划线或短横线；房间须以对应 `project:` 开头。不再信任客户端传入的 playerId。

服务端固定请求 `https://api.keepwork.com/core/v0/users/profile`，禁止重定向，8秒超时；返回的 `username` 必须与提交值严格一致。缺少/失效token、用户名不匹配返回401，上游不可用返回503，均拒绝入场。依据 KeepworkSDK 的 `src/core/keepworkSDK.core.ts` 和 `src/core/api-origin.ts`，不是本地解析JWT或信任SDK缓存。

成功应答含服务端生成的 `playerId`、`username`、`instanceId`、WSS `url`、一次性 `ticket`。票据用进程内随机密钥HMAC签名，有效期60秒，绑定账号、项目、角色、独立连接ID、房间及实例；世界服校验并消费票据，拒绝复用/篡改/绕过网关。密钥不落盘，服务重启后旧票据失效；当前同进程多世界服共享验票器，独立进程部署须先设计密钥、票据消费和账号连接名额的共享。已连接会话最长一小时，之后重连再次核验token；不宣称Keepwork注销可即时踢出其他现存连接。

hello 使用应答的 playerId/instanceId/ticket，token仅用于HTTPS请求头，不进入WebSocket URL、日志或存档。每次鉴权生成独立的随机 playerId，Haqi 同账号同角色新入场会由服务器替换旧连接（大厅除外），重连也会得到新的 playerId。客户端角色编号用于标识账号内业务角色，**尚未查云端角色目录证明角色存在或拥有某项游戏资产**；本轮验收是账号token与用户名一致，不是战斗/资产授权。

`PRESENCE_ALLOWED_ORIGINS=*` 为默认及当前公网策略：允许任意页面来源（包括127.0.0.1任意端口、任意IP/域名和null Origin）进行Authorization预检，仅对 `/api/join` 返回 `Access-Control-Allow-Origin: *`，不启用跨域Cookie。所有POST仍向Keepwork验证Bearer token及username；管理接口不继承CORS。显式来源列表仍可用于隔离部署；`auth:null`不会启用通配来源。公网HTTP旧端口返回426。`PRESENCE_PUBLIC_SOCKET_URL` 支持 `{port}`，当前代理支持8798–8817，新增超出范围的世界服需先增加代理路由。认证默认在 `startPresence` 开启；低层 `startGateway/startGameServer` 的 `auth:null` 仅用于隔离协议测试，不得用它替代生产启动入口。


### 同账号最多10个客户端（用户约定2026-10-23）

按Keepwork返回并核验一致的username计数，跨角色、项目、token、同进程多个世界服合并计算；不是按IP限流。同一账号、同一角色最多10条在场连接，每条拥有独立playerId。网关获取票据尚不占连接名额，世界服消费一次性票据后同步占位，第11个hello返回 `reject / account-connection-limit` 并关闭新连接，不踢走已有客户端。断线、超时、会话到期、服务关闭和首次入场失败都会释放名额；释放幂等，批量并发入场不得超过10条。客户端应提示关闭其他客户端再重试，不把容量拒绝当作token无效。

当前生产网关及其多个世界服在同一Node进程中，复用同一个auth对象管理名额。未来多进程/多机器扩容必须共享原子名额账本，不能每个进程各放10条而宣称全局上限。这里的客户端数是游戏服连接数，不改变云存档现有写入模型。

```js
const client = createPresenceClient({gatewayUrl: 'https://us1.gameserver.keepwork.com'});
const hello = {username: sdk.user.username, project: 'haqi', roleId: 'role-1', roomId: 'haqi:camp', x: 0, y: 0};
await client.join(hello, {token: sdk.token});
await client.connect({...hello, name: '哈奇玩家', appearance: {}});
await client.waitFor(message => message.type === 'welcome', 10000);
// 继续每秒move心跳；退出必须close；断线重新join获取新票据。
```

下文无凭据示例仅适用于显式 `auth:null` 的本地协议测试，不能用于当前公网部署。

## 标识约定

| 项目 | `PROJECTS` 常量 | 玩家示例 | 房间示例 |
| --- | --- | --- | --- |
| HaqiCombatSim | `haqi` | `haqi_user-1` | `haqi:camp` |
| AI-work-company | `aiWorkCompany` | `awc_user-1` | `awc:lobby` |
| AIChat | `aiChat` | `aichat_user-1` | `aichat:lobby` |

使用 `presenceIdentity(project, playerId, roomId)` 统一生成标识；玩家与房间最终长度均不得超过64字符。超限明确报错，不截断。切换房间也必须使用相同项目前缀。需要跨项目见面时，双方明确约定共同命名空间及稳定玩家 ID。当前约定防止误碰撞，不提供多租户安全隔离。

## 客户端示例

下例保存为新仓库根目录的本地脚本可用 Node 运行。浏览器通过调用方自身静态服务提供 `client.js`、`interpolation.js` 和 `namespace.js`，它们不依赖 Node 或第三方包。公开源码仓库不是 CDN；遵守各产品既有资源发布约定。

```js
import {createPresenceClient, presenceIdentity, PROJECTS} from './src/presence/client.js';

const identity = presenceIdentity(PROJECTS.aiChat, 'user-1', 'lobby');
const client = createPresenceClient({gatewayUrl: 'http://127.0.0.1:8797'});
await client.join({...identity, x: 0, y: 0});
await client.connect({...identity, name: '访客', appearance: {}, x: 0, y: 0});
await client.waitFor(message => message.type === 'welcome');

// 每秒最多一次。静止时也需定期发消息，30秒无消息会断开。
const heartbeat = setInterval(() => {
    client.send({type: 'move', x: 0, y: 0});
}, 1000);

// 离开页面时执行：clearInterval(heartbeat); client.close();
```

网关仅对允许的页面源提供 `/api/join` CORS，生产地址与HTTPS/WSS见上节及部署记录；控制面接口仍由反向代理禁止公网访问。

当前 SDK 是最小客户端：不会自动重连或维护完整角色 UI，调用方需处理关闭/重连、角色切换与消息生命周期。现有服务不替代 Keepwork 登录/云存档，也不替代 AI-work-company 的业务后端。

## 2026-10-24 实例目录与选择（本地实现，未部署）

GET `/api/instances?page=1&pageSize=20` 返回 `{page,pageSize,pages,total,instances:[{id,playerCount,capacity,status}]}`；页大小1–100，页码夹取到有效范围，按真实数字编号升序，不补造不存在的服务器。仅公开汇总信息，沿用入场来源策略，允许GET/OPTIONS，不开放管理CORS。默认400/500人为拥挤、500/500为已满；机器总容量耗尽也显示已满；待开启/正在迁移实例显示维护。人数为最近心跳快照，不预留容量。

POST `/api/join` 可附加正整数 `instanceId`，保持原Keepwork鉴权及绑定该实例的一次性票据。不存在、满员、维护或过期目标明确失败，不自动换服。客户端重新获取票据，收到匹配 `welcome.instanceId` 才显示连接成功；`migrate` 表示服务端后续迁移。手动切服先断旧连接，以免同账号10客户端限额阻止切换。

部署需允许反向代理公开 GET/OPTIONS `/api/instances`；管理路由继续隔离。本地测试覆盖分页/选择及原认证，尚未验收公网账号切服。
