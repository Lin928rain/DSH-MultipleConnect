# DSH-MultipleConnect

Connect DeepSeek Harness to messaging services. Internal connections share the main conversation and reply to the originating chat. External connections collect messages in a persistent inbox. The main conversation receives count-only notifications when an external connection reaches its configured threshold.

Supports DSH Web and Desktop 0.2.2-rc.1 through 0.2.2-rc.5, with continued support for 0.2.1-rc.2. Use the repository URL in the Desktop Plugins page or get the archive from the [GitHub Release](https://github.com/Lin928rain/DSH-MultipleConnect/releases/latest). Build locally with Node.js 22.19 or newer using `npm ci`, `npm run build`, and `npm pack`. On DSH Web, use `dsh plugin --profile web add ./dsh-multiple-connect-0.2.4.tgz` to install the archive. In **Settings → DSH-MultipleConnect → General settings**, **Create main conversation in default workspace** registers the host's default workspace folder if needed and creates the conversation. You can also choose an existing workspace.

The main conversation is created with full access and replaced when archived. Connections start in external mode with tool sending and notifications disabled. Agent-initiated messages require an explicit saved target and the connection owner’s permission. Both connection modes share the same inbox. Use `list_im_conversations` and `read_im_messages` for history, `read_im_resources` for native resources, and `open_im_attachment` for a specific download.

Snowluma uses its OneBot v11 WebSocket server. Configure the URL, access token, and allowed QQ users and groups in the Snowluma settings. The integrated proactive scheduler supports single and recurring alarms, Cron, schedule files, quiet hours, and archived-main replacement for alarms that follow the current main conversation.

Set separate Host directories for the message database and attachment cache in **General settings → Message and attachment storage**. For OneBot, Feishu, official QQ bots, WeChat iLink and Telegram, original attachments are fetched on demand. The default cache quota is 5 GiB with 30 days of idle retention. The default download limit is 128 MiB per attachment.

[中文文档](README.md) · [dsh-im-humanize](https://github.com/john-walks-slow/dsh-im-humanize) · [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive)
