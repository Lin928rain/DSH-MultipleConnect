# DSH-MultipleConnect

Connect DeepSeek Harness to messaging services. Internal connections share the main conversation and reply to the originating chat. External connections collect messages in a persistent inbox. The main conversation receives count-only notifications when an external connection reaches its configured threshold.

Build with Node.js 22.19 or newer using `npm ci`, `npm run build`, and `npm pack`. Install the resulting archive with `dsh plugin --profile web add ./dsh-multiple-connect-0.1.0.tgz` on DSH Web 0.2.1-rc.2. Open **Settings → DSH-MultipleConnect → General settings** to open the main conversation and configure connections.

The main conversation is created with full access and replaced when archived. Connections start in external mode with tool sending and notifications disabled. Agent-initiated messages require an explicit saved target and the connection owner’s permission. The inbox is available through `list_im_conversations` and `read_im_messages`.

Snowluma uses its OneBot v11 WebSocket server. Configure the URL, access token, and allowed QQ users and groups in the Snowluma settings. The integrated proactive scheduler supports single and recurring alarms, Cron, schedule files, quiet hours, and archived-main replacement for alarms that follow the current main conversation.

[中文文档](README.md) · [dsh-im-humanize](https://github.com/john-walks-slow/dsh-im-humanize) · [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive)
