# 通用私有账号房间与消息中继

本接口供任意应用使用。服务器只负责认证、账号与应用命名空间隔离、在线成员、定向中继及资源限制，不理解聊天、会话、模型、审批或任何应用命令。

## 入场与隔离

`POST /api/join` 使用 Keepwork Bearer token，JSON 为 `{username, project, roleId, roomType:"account"}`。`project` 为应用命名空间，允许1–23个ASCII字母、数字、下划线或连字符，无需服务端注册；roleId保持原1–64字符规则。roomId可省略、为 `account` 或为自己的规范ID。无需提供游戏坐标。应用命名空间不是秘密或应用身份认证；所有权始终来自验证后的Keepwork账号。

服务器以 `[project, verifiedUsername]` 派生 `account:private:<hash>`，签发含 roomType、project、ownerUsername、visibility和roomId的短期一次性票据。返回 `visibility:"private"`、`ownerUsername`、`roomType:"account"`、`capabilities:["account.relay.v1"]` 与原分配字段。hello使用返回的playerId、instanceId、roomId和ticket。不能伪造owner、改为public、使用其他账号或其他应用的规范房间ID；重连须重新鉴权。

账号房间不进入游戏空间模拟、公开成员/房间报表、空间迁移。换房被拒绝；换应用或账号须重新入场。无鉴权模式不能进入 `account` / `account:*`。普通haqi/awc游戏入场、头像、移动与角色接管行为保持不变；账号房间即使使用haqi命名空间也不参与游戏角色接管。每账号跨项目最多10条连接。

## 成员与中继

welcome含self、私有room元数据及通用能力。`clientMetadata`接收name/device（各80字符）与clientId（1–80个字母、数字、下划线或连字符）。`privateMembers`仅向同账号同应用的在线连接发送成员。`ping`返回pong。管理员提供正确X-Admin-Token才能查看私有房间owner及人数，匿名视图不显示。

发送 `{type:"account.relay.v1", requestId, to, payload}`。requestId为最多100字符的通用关联ID；payload为任意JSON。服务器只校验封装与目标归属，重新构造 `{type, requestId, from, to, payload}`，from取自认证连接，丢弃调用者声明的身份及其他封装字段。payload中的channel、kind、业务版本和命令完全不解释。服务器拒绝时返回reject及requestId；成功送入套接字不代表应用已执行，应用自行定义确认、幂等、重试和版本协商。

限制保持为每连接40条应用消息/秒（超额关闭）、15KiB中继封装、16KiB底层消息、约1MiB慢接收者发送积压关闭、30秒空闲超时。无离线队列或聊天内容持久化。最后一个客户端退出即清除房间。

## 范围与兼容

当前同一网关进程生成的多个world实例共享认证registry，支持跨端口定向中继；独立进程/主机之间不共享registry，不能当作跨主机集群使用。

AIChat自身用project=aichat，并将 `{channel:"aichat.remote.v1",kind,payload}` 放入通用payload。服务器无AIChat协议分支或通道常量。旧AIChat客户端不会收到旧能力声明，必须更新前端后才能使用；不降级到公共房间。游戏协议不变。

`npm test`覆盖任意应用、不认识的payload版本、账号/应用隔离、所有权伪造、真实HTTP/WebSocket跨实例转发和游戏回归。发布状态及回滚见 [deployment.md](deployment.md)。
