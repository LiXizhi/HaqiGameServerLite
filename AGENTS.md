# HaqiGameServerLite 开发约定

- 这是 HaqiCombatSim、AI-work-company 和 AIChat 共用的独立服务器仓库，默认使用 main。
- 使用原生 JavaScript ES modules 和 Node 内置模块，保持无运行时第三方依赖。
- 不依赖任一消费项目的本地路径、资产、账号数据或构建产物。
- 浏览器客户端及其依赖不能引用 Node API；服务器文件读取留在服务器模块。
- 玩家和房间遵守 docs/integration.md 的共享命名空间约定；不得把命名空间宣称为鉴权。
- 用户可见文案使用中文，不加 emoji。环境变量中的口令不得写入日志、测试夹具或提交。
- 修改后运行 npm test；调整容量、转发或连接管理时运行 npm run test:load。
- 文档和迁移记录应准确区分已实现、已验证与尚未接入的业务页面。
- 默认保留本地修改，仅在用户要求提交或推送时执行对应操作。
