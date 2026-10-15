# microsoft-todo-mcp-cn

[![npm](https://img.shields.io/npm/v/microsoft-todo-mcp-cn.svg)](https://www.npmjs.com/package/microsoft-todo-mcp-cn) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

让 Claude 等 MCP 客户端操作你的 **Microsoft To Do**：新增今天的任务、勾选/取消勾选、子步骤管理、修改、搜索，以及读取 **“我的一天”**。

- ✅ **支持“我的一天”**：Graph API 不提供此数据，本项目以**只读**方式读取本机 To Do 应用的缓存库获得（Windows）
- ✅ **个人账号免注册**：默认使用微软官方公共应用登录，不用去 Azure 门户注册应用（个人账号注册会报 `AADSTS16000`）
- ✅ **按标题操作**：“把 VLLM 源码阅读标记完成”即可，无需先查 id；列表名直接写“任务”“杂货”
- ✅ **中文输出、自然日期**：today / 明天 / `HH:mm` 提醒
- ✅ **可靠性**：超时 + 重试、防重复创建、只读/禁删模式

## 快速开始

需要 Node.js ≥ 20（读取“我的一天”需要 ≥ 22.5）。

**1. 登录微软账号（只需一次）**

```bash
npx -y microsoft-todo-mcp-cn login
```

终端会显示网址和验证码：在浏览器打开网址、输入验证码、用 To Do 的账号登录，授权页面显示 “Microsoft Graph Command Line Tools” 申请访问任务，点“接受”。之后令牌会自动续期。

**2. 接入 Claude Code**

Windows：

```bash
claude mcp add todo --scope user -- cmd /c npx -y microsoft-todo-mcp-cn
```

macOS / Linux：

```bash
claude mcp add todo --scope user -- npx -y microsoft-todo-mcp-cn
```

重启 Claude Code 会话后即可使用。

**Claude Desktop**（`claude_desktop_config.json`，Windows 下 `command` 用 `cmd`、`args` 前加 `"/c", "npx"`）：

```json
{
  "mcpServers": {
    "todo": {
      "command": "npx",
      "args": ["-y", "microsoft-todo-mcp-cn"]
    }
  }
}
```

> 也可以跳过第 1 步，让 Claude 调用 `login` 工具，它会把网址和验证码告诉你。

示例对话：“今天加两个任务：写周报、给导师发邮件”“把 VLLM 源码阅读标记完成”“我的一天还有什么没做？”“把写周报的第 2 步勾掉”

## 工具列表

| 工具 | 作用 |
|---|---|
| `auth_status` / `login` | 查看登录状态 / 设备码登录 |
| `list_lists` / `create_list` | 列出 / 新建列表 |
| `list_tasks` | 列出某列表的任务（默认“任务”列表，默认只看未完成） |
| `search_tasks` | 跨列表按关键字搜索 |
| `get_my_day` | “我的一天”（读本机缓存，仅 Windows） |
| `get_today_tasks` | 今天截止或已逾期的未完成任务 |
| `add_task` | 新建任务（截止日期、重要、备注、提醒） |
| `add_today_task` | 批量新建今天截止的任务 |
| `add_step` / `list_steps` | 添加 / 查看子步骤 |
| `update_step` | 勾选、取消勾选或改写子步骤（可用序号“第2步”、文字或 id 指定） |
| `delete_step` | 删除子步骤 |
| `complete_task` / `uncomplete_task` | 勾选 / 取消勾选（按标题模糊匹配或 id） |
| `update_task` | 改标题、截止日期、重要性、备注、提醒 |
| `delete_task` | 永久删除任务 |

> “新增今天的任务” = 截止日期设为今天（出现在“计划内”，并作为“我的一天”的建议）。微软 API 不支持直接把任务加入“我的一天”。

## 原理

```
你说："把 VLLM 源码阅读标记完成"
        │
Claude（AI）──判断要调用 complete_task 工具──┐
                                            │ MCP 协议（stdin/stdout）
                                            ▼
             本机 microsoft-todo-mcp-cn（本 MCP 服务）
             │                            │
   写操作/查询 │ HTTPS + 访问令牌           │ 只读
             ▼                            ▼
  微软云端 Graph API              本机 To Do 缓存库 todosqlite.db
  graph.microsoft.com             （仅用于读取“我的一天”）
             │
             │ To Do 应用自动同步
             ▼
     本机 Microsoft To Do 应用（几秒后显示变化）
```

- **MCP**：让 AI 调用外部工具的标准协议。客户端启动本服务，本服务声明自己提供哪些工具及参数；你用自然语言下指令，由 Claude 决定调用哪个工具。
- **为什么改云端而不改本机应用**：本机 To Do 应用没有对外接口，它的数据只是云端的同步缓存。直接改数据库可能与同步冲突甚至损坏数据，所以写操作都改云端，再由应用同步回来。因此 **To Do 应用必须能正常同步**，修改才会在应用里显示。
- **为什么“我的一天”读本地**：Graph API 不提供“我的一天”，只能只读本机缓存库 `tasks.committed_date` 字段。

### 为什么要登录微软账号（OAuth 设备码授权）

1. `login` 向微软申请一个设备码；
2. 你在浏览器打开微软官网、输入验证码、登录并点击“接受”，授权“读写任务”；
3. 微软把**访问令牌**发给本程序，之后每次调用 API 都带上它；
4. 令牌缓存在 `%APPDATA%\todo-mcp\msal-cache.json`（macOS/Linux：`~/.config/todo-mcp/`），过期后自动续期。

程序全程拿不到你的密码，只拿到权限有限（任务读写 + 基本资料）的令牌。

> ⚠ `msal-cache.json` 相当于你 To Do 的钥匙，不要分享或上传。退出登录：`npx microsoft-todo-mcp-cn logout`；彻底撤销：到 <https://account.live.com/consent/Manage> 移除 “Microsoft Graph Command Line Tools”。

## 常见问题

### To Do 应用一直同步失败（左上角橙色圆点）

如果系统代理指向本机（如 Clash 的 `127.0.0.1:7890`），Microsoft Store 应用默认被 Windows“环回隔离”禁止连接 127.0.0.1。用管理员终端执行后重启 To Do：

```bash
CheckNetIsolation LoopbackExempt -a -n="Microsoft.Todos_8wekyb3d8bbwe"
```

### 想用自己的 Azure 应用 / 工作学校账号

注册应用（账户类型含个人帐户、开启“允许公共客户端流”、添加委托权限 `Tasks.ReadWrite`、`User.Read`），然后：

```bash
npx -y microsoft-todo-mcp-cn login <你的ClientID>
```

工作/学校账号还需设置环境变量 `TODO_TENANT=organizations`。

## 环境变量（可选）

| 变量 | 说明 |
|---|---|
| `TODO_CLIENT_ID` | 自定义 Azure 应用 Client ID |
| `TODO_TENANT` | 默认 `consumers`（个人账号）；工作/学校账号用 `organizations` 或 `common` |
| `TODO_TIMEZONE` | 截止/提醒时间使用的时区，默认取系统时区 |
| `TODO_LOCAL_DB` | 手动指定 `todosqlite.db` 路径 |
| `TODO_READONLY` | 设为 `1` 时只注册只读工具，AI 无法修改任何数据 |
| `TODO_NO_DELETE` | 设为 `1` 时不注册 `delete_task` / `delete_step` |
| `TODO_TIMEOUT_MS` | 单次 Graph 请求超时，默认 15000 |
| `TODO_DEDUP_SECONDS` | 防重复创建的时间窗口，默认 60 秒 |

例如只读接入：

```bash
claude mcp add todo-ro -e TODO_READONLY=1 -- cmd /c npx -y microsoft-todo-mcp-cn
```

## 可靠性设计

- **重试与超时**：每个请求 15 秒超时；遇到 429/503/504 按 `Retry-After`（或指数退避）最多重试 3 次；GET/PATCH/DELETE 在超时或断网时也会重试。**POST（新建）在超时/断网时不自动重试**，因为请求可能已生效，重试会建出重复任务。
- **防重复创建**：`add_task`、`add_today_task`、`add_step`、`create_list` 在 60 秒内收到参数完全相同的请求时，直接返回上次结果（服务重启后失效）。
- **风险分级**：每个工具带 MCP `annotations`（`readOnlyHint` / `destructiveHint`），客户端可据此决定是否需要确认。

## 本地开发

```bash
git clone https://github.com/hechen-coder/microsoft-todo-mcp.git
cd microsoft-todo-mcp
npm install
npm run build
npm run login
claude mcp add todo-dev -- node /绝对路径/microsoft-todo-mcp/dist/cli.js
```

## 致谢与对比

同类项目：[fabienbutz/microsoft-todo-mcp](https://github.com/fabienbutz/microsoft-todo-mcp)、[jordanburke/microsoft-todo-mcp-server](https://github.com/jordanburke/microsoft-todo-mcp-server)。本项目的差异在于“我的一天”读取、按标题操作和中文场景支持。

## License

[MIT](LICENSE)
