# DSH-MultipleConnect

把多个消息平台接入 DeepSeek Harness。内连消息共享一个主对话，外连消息进入持久化收件箱。项目基于 [dsh-im-humanize](https://github.com/john-walks-slow/dsh-im-humanize)，并内置 [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive)。

## 构建与安装

支持 DSH Web 和桌面端 `0.2.2-rc.1` 至 `0.2.2-rc.5`，并保留对 `0.2.1-rc.2` 的兼容。桌面端可在插件页用本仓库地址安装，也可从 [GitHub Release](https://github.com/Lin928rain/DSH-MultipleConnect/releases/latest) 下载安装包。

本地构建需要 Node.js 22.19 或更新版本。Web 版可使用以下命令安装。

```powershell
npm ci
npm run build
npm pack
dsh plugin --profile web add ./dsh-multiple-connect-0.2.4.tgz
```

重新启动 DSH 后，在「设置 → DSH-MultipleConnect → 通用设置」打开主对话、配置连接模式。若曾安装旧 IM 插件，先在同一 profile 中停用旧插件，避免两个宿主连接同一个机器人。原渠道沿用已有配置及凭据存储，新的连接模式与发送授权独立保存，默认全部外连、禁用工具发送和自动推送。已有 DSH 会话仍可以从原工作区访问。

## 主对话与连接

- 插件首次启动后在 DSH 默认工作区创建主对话，初始化为完全访问权限。若 DSH 尚未注册默认工作区，在「通用设置 → 主对话与连接模式」点击「使用默认工作区创建主对话」，插件会在宿主的文档目录下注册 `deepseek-harness/default-workspace` 并创建会话。也可手动选择一个已注册工作区。设置页可打开或归档尚无聊天记录的主对话。
- 归档后自动创建新主对话。旧会话恢复后继续作为普通会话。
- 内连沿用各渠道的访问规则。获准消息进入主对话，直接回复只回到本轮的来源聊天。内连聊天共享同一份上下文。
- 内连和外连共用消息库，保存正文、引用、可用的转发结构和附件引用。外连打开自动推送后，每累积设置的条数向主对话发一次仅含连接名称和数量的提醒。第一个阈值周期从开启后的新消息开始。
- `list_im_conversations` 列出连接及聊天，`read_im_messages` 分页读取两种模式的历史。两者的 `before` 使用上一页的末尾游标。`read_im_resources` 展开引用、转发或查询平台资源，`open_im_attachment` 按需下载一项附件。
- `send_im` 需要 `botId`、`targetId` 和 `text`。宿主在投递前检查目标连接的「允许 Agent 工具发送」。主对话在内连回合中的原路回复使用独立权限路径。
- 保留 `message_break`、支持渠道的流式输出和输入中状态。移除了模拟阅读停顿、模拟分段等待和闹钟随机抖动。

## Snowluma

在 Snowluma 为一个 QQ 账号启用 OneBot v11 正向 WebSocket，支持消息段数组和 CQ 码。打开插件的「Snowluma」渠道页，填写 WebSocket URL、Access Token、允许接收消息的 QQ 私聊账号和群号。两种模式均保存白名单群实际收到的消息，内连群聊仍通过 `@机器人` 触发回复。可查询嵌套转发、群文件、相册及平台可见历史。其他 OneBot 实现的扩展能力取决于服务端接口。可以在「投递目标」选择收件人或手动添加 QQ 目标。

支持忙时消息处理的机器人默认使用「注入纠偏」，符合条件的补充消息由 Agent 在当前回合的下一步读取。已保存的全局设置和机器人覆盖继续生效。Snowluma 内连目前固定排队。

## 消息与附件存储

在「通用设置 → 消息与附件存储」可以分别选择消息库和附件缓存的目录，也可以手动输入运行 DSH 的机器上的绝对路径。保存设置时开始迁移，可选择迁移成功后清理旧副本。消息历史默认永久保留，附件缓存默认 5 GiB、闲置 30 天清理，单个附件默认最多下载 128 MiB。超过单文件上限的已知大小附件可以在设置中单次放行，总缓存上限仍然生效。

OneBot、飞书、QQ 官方机器人、微信 iLink 和 Telegram 收到附件时只保存引用，可用的平台缩略图按预算缓存。需要原件时调用 `open_im_attachment`。缓存清理后仍可查原消息和附件信息，重新下载取决于平台权限和链接有效期。飞书合并转发中的附件只保留可读元数据。旧版未保存的平台资源 ID 无法从本地记录恢复。

## 主动唤醒

在 DSH「主动唤醒」设置中管理一次性闹钟、周期闹钟、Cron、文件时间表、免打扰和历史。主对话中创建且省略目标的原地唤醒闹钟跟随当前主对话。闹钟在目标会话发起回合，发送 IM 消息使用 `send_im`。AI Office 保留原有的独立任务协议。

## 开发

```powershell
npm run build
node --test test/multiple-connect.test.mjs
node scripts/verify-package.mjs
```

主对话指针、连接设置、消息库和提醒队列默认保存在 `$DSH_HOME/multiple-connect/connections.sqlite`。闹钟数据保存在默认根目录下的 `proactive` 目录。旧渠道配置继续使用原存储位置。上游授权见 [LICENSE](LICENSE) 和 [dsh-proactive LICENSE](vendor/proactive/LICENSE)。
