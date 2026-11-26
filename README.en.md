# DSH-MultipleConnect

Connect DeepSeek Harness to messaging services. Internal chats share the main conversation and receive replies in the originating chat. External chats collect messages in a persistent inbox. When enabled, notifications identify the source chat and its message count.

Supports DSH Web and Desktop 0.2.2-rc.1 through 0.2.2-rc.5, with continued support for 0.2.1-rc.2. Use the repository URL in the Desktop Plugins page or get the archive from the [GitHub Release](https://github.com/Lin928rain/DSH-MultipleConnect/releases/latest). Build locally with Node.js 22.19 or newer using `npm ci`, `npm run build`, and `npm pack`. On DSH Web, use `dsh plugin --profile web add ./dsh-multiple-connect-0.2.7.tgz` to install the archive. In **Settings → DSH-MultipleConnect → General settings**, **Create main conversation in default workspace** registers the host's default workspace folder if needed and creates the conversation. You can also choose an existing workspace.

The main conversation is created with full access and replaced when archived. Connections start in external mode with tool sending and notifications disabled. Agent-initiated messages require an explicit saved target and the connection owner’s permission. Both connection modes share the same inbox. Use `list_im_conversations` and `read_im_messages` for history, `read_im_resources` for native resources, and `open_im_attachment` for a specific download.

Each connection has defaults for connection mode, external notifications, and the message threshold. Open **Manage chats** to override these defaults for a group, direct chat, channel, or supported topic. New chats inherit defaults, and Telegram forum topics can inherit their group settings. Each chat has its own count.

Snowluma uses its OneBot v11 WebSocket server. Configure the URL, access token, and allowed QQ users and groups in the Snowluma settings. Each Snowluma connection can choose queue, steer, or interrupt, or inherit the global default. Steer and interrupt apply to active turns started by the same QQ chat. The integrated proactive scheduler supports single and recurring alarms, Cron, schedule files, quiet hours, and archived-main replacement for alarms that follow the current main conversation.

The main conversation automatically delivers an alarm's final reply when exactly one eligible internal direct chat exists. Use **General settings → Wake delivery settings** to pick a recipient or keep wake replies in DSH. Delivery outcomes appear in the alarm history. Use the authorized `send_im` tool to send to an explicit target such as an external chat or a group.

Set separate Host directories for the message database and attachment cache in **General settings → Message and attachment storage**. For OneBot, Feishu, official QQ bots, WeChat iLink and Telegram, original attachments are fetched on demand. The default cache quota is 5 GiB with 30 days of idle retention. The default download limit is 128 MiB per attachment.

[中文文档](README.md) · [dsh-im-humanize](https://github.com/john-walks-slow/dsh-im-humanize) · [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive)
