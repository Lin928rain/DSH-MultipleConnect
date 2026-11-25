# DSH-MultipleConnect

把多个消息平台接入 DeepSeek Harness。内连消息共享一个主对话，外连消息进入持久化收件箱。项目基于 [dsh-im-humanize](https://github.com/john-walks-slow/dsh-im-humanize)，并内置 [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive)。

## 构建与安装

适用版本为 DSH Web `0.2.1-rc.2`，构建需要 Node.js 22.19 或更新版本。

```powershell
npm ci
npm run build
npm pack
dsh plugin --profile web add ./dsh-multiple-connect-0.1.0.tgz
```

重新启动对应的 DSH Web profile 后，在「设置 → DSH-MultipleConnect → 通用设置」打开主对话、配置连接模式。若曾安装旧 IM 插件，先在同一 profile 中停用旧插件，避免两个宿主连接同一个机器人。原渠道沿用已有配置及凭据存储，新的连接模式与发送授权独立保存，默认全部外连、禁用工具发送和自动推送。已有 DSH 会话仍可以从原工作区访问。

## 主对话与连接

- 插件首次启动后在 DSH 默认工作区创建主对话，初始化为完全访问权限。没有默认工作区的旧安装可在设置中选择一个已注册工作区。设置页也能打开或归档一个尚无聊天记录的主对话。
- 归档后自动创建新主对话。旧会话恢复后继续作为普通会话。
- 内连沿用各渠道的访问规则。获准消息进入主对话，直接回复只回到本轮的来源聊天。内连聊天共享同一份上下文。
- 外连持久化连接实际收到的消息、发送者、时间和附件元数据。打开自动推送后，每累积设置的条数向主对话发一次仅含连接名称和数量的提醒。第一个阈值周期从开启后的新消息开始。
- `list_im_conversations` 列出连接、已保存的投递目标或外连聊天，`read_im_messages` 分页读取历史。两者的 `before` 使用上一页的末尾游标。
- `send_im` 需要 `botId`、`targetId` 和 `text`。宿主在投递前检查目标连接的「允许 Agent 工具发送」。主对话在内连回合中的原路回复使用独立权限路径。
- 保留 `message_break`、支持渠道的流式输出和输入中状态。移除了模拟阅读停顿、模拟分段等待和闹钟随机抖动。

## Snowluma

在 Snowluma 为一个 QQ 账号启用 OneBot v11 正向 WebSocket，建议使用消息段数组格式。打开插件的「Snowluma」渠道页，填写 WebSocket URL、Access Token、允许接收消息的 QQ 私聊账号和群号。内连群聊通过 `@机器人` 触发回复，外连保存白名单群实际收到的消息。可以在「投递目标」从允许的账号和群中选择收件人，或者手动添加一个 QQ 目标。

## 主动唤醒

在 DSH「主动唤醒」设置中管理一次性闹钟、周期闹钟、Cron、文件时间表、免打扰和历史。主对话中创建且省略目标的原地唤醒闹钟跟随当前主对话。闹钟在目标会话发起回合，发送 IM 消息使用 `send_im`。AI Office 保留原有的独立任务协议。

## 开发

```powershell
npm run build
node --test test/multiple-connect.test.mjs
node scripts/verify-package.mjs
```

主对话指针、连接设置、外连收件箱和提醒队列保存在 `$DSH_HOME/multiple-connect/connections.sqlite`。闹钟数据保存在其相邻的 `proactive` 目录。旧渠道配置继续使用原存储位置。上游授权见 [LICENSE](LICENSE) 和 [dsh-proactive LICENSE](vendor/proactive/LICENSE)。
