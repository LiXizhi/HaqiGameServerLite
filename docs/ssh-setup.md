# 游戏服 SSH：每台电脑的首次配置

用户约定（2026-10-24）：在不同电脑操作此服务器前，先建立相同的 SSH 连接别名并验证密钥登录。已有配置先复用，不重复询问已经可用的登录方式。每台电脑使用独立密钥，不复制其他电脑的私钥。

## 连接资料

| 项目 | 值 |
| --- | --- |
| 别名 | `haqi-us1` |
| 地址 | `43.130.151.173` |
| 域名 | `us1.gameserver.keepwork.com` |
| 用户 / 端口 | `root` / `22` |
| 客户端配置 | 当前用户 `~/.ssh/config` |
| 专用密钥 | 当前用户 `~/.ssh/haqi_us1_ed25519` |
| 服务器授权文件 | `/root/.ssh/authorized_keys` |
| 已核验服务器 ED25519 指纹 | `SHA256:pGAkbSYVQ/PIjunTE3U+HP0vnmpsYB5e4Sk4CIllkRs` |

Windows 的 `~` 是当前用户目录，不能假定其他电脑也使用 Administrator。服务器迁移或重装后需重新核验主机指纹，不能自动忽略变化。

## 每次开始先检查

1. 阅读本页和现有 SSH 配置，先运行 `ssh -o BatchMode=yes -o ConnectTimeout=10 haqi-us1 "id -un"`。返回 `root` 即可继续工作，无需再次索要密码。
2. 若别名缺失，检查当前电脑已有密钥和可用的服务器登录方式；将下方配置合并到现有 config，保留其他主机条目。不要覆盖已有密钥文件。
3. 新电脑尚无专用密钥时，用 `ssh-keygen -t ed25519 -f ~/.ssh/haqi_us1_ed25519` 创建独立密钥；有口令的密钥使用系统 ssh-agent 解锁，最终以 BatchMode 验证结果为准。需要无人值守且不使用 agent 时，可在交互提示中将密钥口令留空，并限制私钥文件权限。
4. 通过已授权且实际可用的登录渠道，把该电脑的 `.pub` 公钥去重追加到服务器 authorized_keys，保留全部既有公钥。服务器 `.ssh` 权限为700、authorized_keys为600。没有首次登录渠道时明确说明缺少该渠道，不能假定旧电脑密钥在新电脑可用。
5. Linux/macOS 私钥权限为600；Windows 去掉私钥继承权限，仅保留当前用户和 SYSTEM 的访问权。私钥始终留在对应电脑，不写入仓库、文档或共享目录。
6. 保持首次登录会话开启，另开连接完成 BatchMode 验证；成功后再退出首次会话。记录配置位置、别名及验证结果，不记录密码、私钥内容或会话凭据。

统一配置如下；合并时避免重复或被更早的通配 Host 条目覆盖：

```sshconfig
Host haqi-us1 us1.gameserver.keepwork.com 43.130.151.173
    HostName 43.130.151.173
    User root
    IdentityFile ~/.ssh/haqi_us1_ed25519
    IdentitiesOnly yes
```

配置完成后使用 `ssh haqi-us1`、`scp <文件> haqi-us1:<目标>`。不要在命令行参数、脚本或日志中保存登录密码，不通过关闭主机密钥校验解决连接问题。

## 当前已配置电脑

2026-10-25，当前 macOS 电脑已创建独立 `~/.ssh/haqi_us1_ed25519`，配置 `haqi-us1` 并核验上述服务器指纹。经用户授权的交互登录追加该电脑公钥后，BatchMode 返回 root。私钥仅留本机，未复制其他电脑密钥；密码未写入文件、命令行或仓库。

2026-10-24，Windows Administrator 账户已配置并验证 BatchMode 密钥登录。config 和专用密钥位于 `C:/Users/Administrator/.ssh/`；私钥 ACL 仅 Administrator/SYSTEM。此状态只适用于这台电脑；换电脑按上述流程建立同名别名和独立密钥。

服务发布路径、配置备份及线上验证记录见 [部署文档](deployment.md)。连接配置本身不代表服务已部署。
