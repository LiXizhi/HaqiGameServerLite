# 三个项目共享服务器

HaqiCombatSim、AI-work-company 和 AIChat 使用同一部署的网关及世界服。各项目配置网关 URL，无需相互引用源码，也无需各自启动一份服务器。当前迁移没有将三个项目的正式 UI 接上线。

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

网关当前不提供跨域 CORS 策略。浏览器接入时由项目部署的同源反向代理转发网关 HTTP 请求；世界服 WebSocket URL 必须对浏览器可达，HTTPS 页面使用 WSS。生产代理地址、认证和证书由部署配置提供，不在源码中猜测。

当前 SDK 是最小客户端：不会自动重连或维护完整角色 UI，调用方需处理关闭/重连、角色切换与消息生命周期。现有服务不替代 Keepwork 登录/云存档，也不替代 AI-work-company 的业务后端。
