# 外部 Agent 接入

阅读和编辑在岁月史书中生效；聊天、模型选择在 Codex 或你使用的 Agent 中完成。应用内 AI 伴读窗口已移除。

## Codex

1. 启动岁月史书并在浏览器打开材料藏书。
2. 在支持本机 STDIO MCP 的客户端添加服务，名称 `chronicle-library`。命令、参数、环境变量可从阅读页顶部「Agent 接口」复制；也可先运行 `node scripts/export-library-integration.mjs`，将本机生成的 `codex.toml` 配置合并到你使用的 Codex 配置文件，避免重复同名表。仓库提供 [codex.toml.example](codex.toml.example) 展示格式。
3. 保存并重新连接 MCP。此文件只提供配置，尚未自动安装到你的 Codex 设置。
4. 在 Codex 中直接说：

> 使用 chronicle-library。先读取 library_agent_guide，再读取我正在看的书和选区。给选中的这段加下划线，批注写“需要复习”，回读核对保存，然后跳到下一页，确认页面已执行。

连接方式及配置位置见 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=app)。只有一个在线阅读窗口时 Agent 可直接选用；多窗口时可以从「Agent 接口」复制带具体会话 ID 的指令。

## 豆包普通网页／桌面客户端

本项目提供标准 MCP，但普通豆包客户端是否允许添加自定义 MCP，需要该客户端实际开放入口。当前未核实到官方通用入口，**尚未接通普通豆包客户端**；不能仅靠把说明粘贴给聊天模型实现工具调用。方舟 API 或 AgentKit 支持工具，不等于豆包普通聊天界面支持。

如果你的客户端提供本机 STDIO MCP 配置，可使用脚本生成的 `mcp.json`，格式见 [mcp.json.example](mcp.json.example)；如果只有云端 URL 入口，无法直接访问本机 `127.0.0.1`。本次未发布公网服务。以后换用支持本机工具调用的豆包 Agent，仍可复用当前接口，不必改阅读格式。

## 交付接口与使用说明

- [Agent 使用规范](AGENT_GUIDE.md)：发现窗口、读取当前页与选区、分页检索、原图、批注符号、移动缩放、原文校对、撤销、版本冲突与失败恢复。
- [OpenAPI 3.1 文件](openapi.json)：46 项外部工具；在线版 `GET /api/library/openapi.json`。
- `GET /api/library/schema`：模型 Function Tools、封闭参数 schema 和服务说明。
- `GET /api/library/connection`：本机 Node 和 MCP 脚本实际路径。
- `GET /api/library/agent-guide`：Agent 可读规范。
- `POST /api/library`：原有兼容入口，HTTP 参数 `{version:"1",operation,requestId,arguments}`。
- `POST /api/library/tools/{工具名}`：直接接受对应工具的 schema 参数；适合 OpenAPI 执行器。
- STDIO 入口 `scripts/library-mcp.mjs`：工具、初始化 instructions、指南 resource、`library-assist` prompt；小于等于 8 MiB 的 PNG/JPEG/WebP 原页可直接返回 MCP 图片内容。

HTTP 写调用需要本机执行器从 `/api/session` 取得令牌，放在 `X-Chronicle-Token`。令牌不交给模型、不写进可分享配置。MCP 桥自动处理。

实际配置文件含本机绝对路径，已由 Git 忽略，不随仓库分享。克隆项目、移动项目或更换 Node 后，在项目目录运行 `node scripts/export-library-integration.mjs` 生成；默认端口为 4317，可通过 `CHRONICLE_URL` 指定本机其他端口。生成配置不会改动客户端设置。示例里的路径是占位符，不能直接使用。

## 结果确认

阅读命令返回 `pending` 后，Agent 需核对同一 `command` 的 `commandStatus=applied`；失败会带 `commandError`。批注使用事务回执和原文回读确认，重复请求使用相同 `requestId`；更新使用实际 `expectedRevision`。浏览器刷新会产生新阅读会话，Agent 应重新发现，不复用过期 ID。

验证使用独立测试书库，完成了外部 MCP 进程发现工具、读取上下文、翻页确认、精确下划线、批注创建/修改/回读、原页图片返回及浏览器刷新恢复。没有向用户藏书写入测试笔记。普通豆包客户端未做连接成功声明。
