import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAccount, loginWithDeviceCode } from "./auth.js";
import { graph, type TaskPatch, type TodoTask } from "./graph.js";
import { getMyDay } from "./localdb.js";
import { resolveList, resolveTask, resolveStep, findTasks } from "./resolve.js";
import { parseDate, toGraphDate, toGraphDateTime, today } from "./date.js";
import { dedupe } from "./idempotency.js";

const server = new McpServer({ name: "microsoft-todo", version: "0.2.0" });

// ---------- 工具注册：风险分级 + 只读/禁删开关 ----------

/** read=只读；write=新增/修改；destructive=删除（不可恢复） */
type Risk = "read" | "write" | "destructive";

const flag = (name: string) => /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
const READONLY = flag("TODO_READONLY"); // 只注册只读工具
const NO_DELETE = flag("TODO_NO_DELETE"); // 不注册删除类工具
const skipped: string[] = [];

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * 注册工具：按开关决定是否注册，自动附加 MCP annotations，
 * 并把返回文本/异常统一包装成 ToolResult（异常不会让服务崩溃）。
 */
function register<S extends z.ZodRawShape>(
  name: string,
  risk: Risk,
  description: string,
  inputSchema: S,
  fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<string>,
) {
  if ((READONLY && risk !== "read") || (NO_DELETE && risk === "destructive")) {
    skipped.push(name);
    return;
  }
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: risk === "read",
        destructiveHint: risk === "destructive",
        openWorldHint: true,
      },
    },
    (async (args: z.objectOutputType<S, z.ZodTypeAny>): Promise<ToolResult> => {
      try {
        return { content: [{ type: "text", text: await fn(args) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `错误：${(e as Error).message}` }], isError: true };
      }
    }) as never,
  );
}

// ---------- 格式化 ----------

const STATUS_CN: Record<string, string> = {
  notStarted: "未完成",
  inProgress: "进行中",
  completed: "已完成",
  waitingOnOthers: "等待他人",
  deferred: "已推迟",
};

function fmtTask(t: TodoTask, listName?: string): string {
  const parts = [`${t.status === "completed" ? "☑" : "☐"} ${t.title}`];
  if (listName) parts.push(`列表:${listName}`);
  if (t.dueDateTime) parts.push(`截止:${t.dueDateTime.dateTime.slice(0, 10)}`);
  if (t.importance === "high") parts.push("★重要");
  if (t.isReminderOn && t.reminderDateTime) parts.push(`提醒:${t.reminderDateTime.dateTime.slice(0, 16).replace("T", " ")}`);
  parts.push(`id=${t.id}`);
  return parts.join(" | ");
}

const listArg = z.string().optional().describe("列表名或列表 id，默认是“任务”列表");
const statusArg = z.enum(["open", "completed", "all"]).optional().describe("open=未完成(默认)、completed=已完成、all=全部");
const findArgs = {
  title: z.string().optional().describe("任务标题（支持部分匹配）"),
  taskId: z.string().optional().describe("任务 id（优先于 title）"),
  list: z.string().optional().describe("限定在某个列表中查找"),
};
const stepArg = z.string().describe("步骤：序号（如 2 或“第2步”）、步骤文字（支持部分匹配）或步骤 id");

// ---------- 账号 ----------

register("auth_status", "read", "查看 Microsoft To Do 的登录状态和当前账号", {}, async () => {
  const account = await getAccount();
  if (!account) return "未登录。请调用 login 工具。";
  return `已登录：${account.username}`;
});

register(
  "login",
  "read",
  "用设备码方式登录 Microsoft 账号。返回一个网址和验证码，需要把它们原样告诉用户，让用户在浏览器中完成登录；登录完成后再调用其他工具。",
  {},
  () =>
    new Promise<string>((resolve, reject) => {
      loginWithDeviceCode((msg) => resolve(`${msg}\n\n（用户在浏览器完成登录后，可调用 auth_status 确认）`))
        .then((acc) => console.error(`[todo-mcp] 登录成功：${acc.username}`))
        .catch((e) => {
          console.error(`[todo-mcp] 登录失败：${e.message}`);
          reject(e); // 若已 resolve（验证码已返回），这里不会影响结果
        });
    }),
);

// ---------- 列表 ----------

register("list_lists", "read", "列出所有 To Do 列表", {}, async () => {
  const lists = await graph.listLists();
  return lists
    .map((l) => `- ${l.displayName}${l.wellknownListName === "defaultList" ? "（默认）" : ""} id=${l.id}`)
    .join("\n");
});

register("create_list", "write", "新建一个 To Do 列表", { name: z.string().describe("列表名称") }, (args) =>
  dedupe("create_list", args, async () => {
    const l = await graph.createList(args.name);
    return `已创建列表“${l.displayName}” id=${l.id}`;
  }),
);

// ---------- 查询 ----------

register("list_tasks", "read", "列出某个列表中的任务", { list: listArg, status: statusArg }, async ({ list, status }) => {
  const l = await resolveList(list);
  const tasks = await graph.listTasks(l.id, status ?? "open");
  if (!tasks.length) return `列表“${l.displayName}”中没有${status === "completed" ? "已完成" : status === "all" ? "" : "未完成"}任务`;
  return `列表“${l.displayName}”共 ${tasks.length} 项：\n` + tasks.map((t) => fmtTask(t)).join("\n");
});

register(
  "search_tasks",
  "read",
  "按关键字在所有列表（或指定列表）中搜索任务",
  { query: z.string().describe("标题关键字"), list: z.string().optional(), status: statusArg },
  async ({ query, list, status }) => {
    const found = await findTasks({ query, list, status: status ?? "all" });
    if (!found.length) return `没有找到包含“${query}”的任务`;
    return found.map((f) => fmtTask(f.task, f.list.displayName)).join("\n");
  },
);

register(
  "get_my_day",
  "read",
  "读取 To Do 桌面应用中“我的一天”的任务（从本机缓存只读读取，Graph API 不提供此数据）。" +
    "标注“未同步”的任务只存在于本机，暂时无法通过其他工具修改。",
  { date: z.string().optional().describe("日期 YYYY-MM-DD，默认今天") },
  async ({ date }) => {
    const d = date ? parseDate(date) : today();
    const tasks = await getMyDay(d);
    if (!tasks.length) return `${d} 的“我的一天”为空`;
    const lines = tasks.map((t) => {
      const parts = [`${t.status === "Completed" ? "☑" : "☐"} ${t.title}`];
      if (t.list) parts.push(`列表:${t.list === "Tasks" ? "任务" : t.list}`);
      if (t.importance) parts.push("★重要");
      parts.push(t.onlineId ? `id=${t.onlineId}` : "⚠未同步到云端");
      return parts.join(" | ");
    });
    const unsynced = tasks.filter((t) => !t.onlineId).length;
    let text = `${d} 我的一天（共 ${tasks.length} 项）：\n${lines.join("\n")}`;
    if (unsynced) {
      text += `\n\n注意：有 ${unsynced} 项尚未同步到微软云端（To Do 应用同步可能异常），在同步前无法通过 complete_task 等工具修改它们。`;
    }
    return text;
  },
);

register("get_today_tasks", "read", "列出所有列表中截止日期为今天（或已逾期）的未完成任务", {}, async () => {
  const d = today();
  const found = await findTasks({ status: "open" });
  const due = found.filter((f) => f.task.dueDateTime && f.task.dueDateTime.dateTime.slice(0, 10) <= d);
  if (!due.length) return `没有截止于今天（${d}）或已逾期的未完成任务`;
  return due
    .map((f) => {
      const overdue = f.task.dueDateTime!.dateTime.slice(0, 10) < d ? " ⚠逾期" : "";
      return fmtTask(f.task, f.list.displayName) + overdue;
    })
    .join("\n");
});

// ---------- 新增 ----------

const taskFields = {
  due: z.string().optional().describe("截止日期：YYYY-MM-DD / today / tomorrow"),
  important: z.boolean().optional().describe("是否标记为重要（星标）"),
  note: z.string().optional().describe("备注内容"),
  reminder: z.string().optional().describe("提醒时间：'YYYY-MM-DD HH:mm' 或 'HH:mm'（今天）"),
};

function buildPatch(a: { due?: string; important?: boolean; note?: string; reminder?: string }): TaskPatch {
  const p: TaskPatch = {};
  if (a.due) p.dueDateTime = toGraphDate(parseDate(a.due));
  if (a.important !== undefined) p.importance = a.important ? "high" : "normal";
  if (a.note !== undefined) p.body = { content: a.note, contentType: "text" };
  if (a.reminder) {
    p.reminderDateTime = toGraphDateTime(a.reminder);
    p.isReminderOn = true;
  }
  return p;
}

register(
  "add_task",
  "write",
  "新建一个任务",
  { title: z.string().describe("任务标题"), list: listArg, ...taskFields },
  (args) =>
    dedupe("add_task", args, async () => {
      const { title, list, ...rest } = args;
      const l = await resolveList(list);
      const t = await graph.createTask(l.id, { title, ...buildPatch(rest) });
      return `已在“${l.displayName}”创建：\n${fmtTask(t)}`;
    }),
);

register(
  "add_today_task",
  "write",
  "快捷新增“今天的任务”：截止日期设为今天，会出现在“计划内”，并作为“我的一天”的建议。可一次添加多个。" +
    "（Graph API 无法直接加入“我的一天”列表）",
  {
    titles: z.array(z.string()).min(1).describe("一个或多个任务标题"),
    list: listArg,
    important: taskFields.important,
    reminder: taskFields.reminder,
  },
  (args) =>
    dedupe("add_today_task", { ...args, date: today() }, async () => {
      const { titles, list, important, reminder } = args;
      const l = await resolveList(list);
      const patch = buildPatch({ due: "today", important, reminder });
      const created: string[] = [];
      for (const title of titles) {
        const t = await graph.createTask(l.id, { title, ...patch });
        created.push(fmtTask(t));
      }
      return `已在“${l.displayName}”添加 ${created.length} 个今天截止的任务：\n${created.join("\n")}`;
    }),
);

// ---------- 子步骤 ----------

register(
  "add_step",
  "write",
  "给任务添加一个子步骤（checklist）",
  { ...findArgs, step: z.string().describe("步骤内容") },
  (args) =>
    dedupe("add_step", args, async () => {
      const { step, ...find } = args;
      const { list, task } = await resolveTask(find);
      await graph.addChecklistItem(list.id, task.id, step);
      return `已给“${task.title}”添加步骤：${step}`;
    }),
);

register("list_steps", "read", "查看任务的所有子步骤及其勾选状态", findArgs, async (find) => {
  const { list, task } = await resolveTask(find);
  const items = await graph.listChecklistItems(list.id, task.id);
  if (!items.length) return `任务“${task.title}”没有子步骤`;
  const done = items.filter((i) => i.isChecked).length;
  return (
    `任务“${task.title}”的步骤（已完成 ${done}/${items.length}）：\n` +
    items.map((i, n) => `${n + 1}. ${i.isChecked ? "☑" : "☐"} ${i.displayName} id=${i.id}`).join("\n")
  );
});

register(
  "update_step",
  "write",
  "勾选/取消勾选子步骤，或修改步骤文字。checked=true 勾选，false 取消勾选",
  {
    ...findArgs,
    step: stepArg,
    checked: z.boolean().optional().describe("true=勾选，false=取消勾选"),
    new_text: z.string().optional().describe("新的步骤文字"),
  },
  async ({ step, checked, new_text, ...find }) => {
    if (checked === undefined && !new_text) return "没有需要修改的字段（请提供 checked 或 new_text）";
    const found = await resolveTask(find);
    const item = await resolveStep(found, step);
    const patch: { isChecked?: boolean; displayName?: string } = {};
    if (checked !== undefined) patch.isChecked = checked;
    if (new_text) patch.displayName = new_text;
    const u = await graph.updateChecklistItem(found.list.id, found.task.id, item.id, patch);
    return `已更新“${found.task.title}”的步骤：${u.isChecked ? "☑" : "☐"} ${u.displayName}`;
  },
);

register(
  "delete_step",
  "destructive",
  "删除任务的某个子步骤（不可恢复）。只有在用户明确要求删除时才调用。",
  { ...findArgs, step: stepArg },
  async ({ step, ...find }) => {
    const found = await resolveTask(find);
    const item = await resolveStep(found, step);
    await graph.deleteChecklistItem(found.list.id, found.task.id, item.id);
    return `已删除“${found.task.title}”的步骤：${item.displayName}`;
  },
);

// ---------- 修改任务 ----------

register("complete_task", "write", "把任务标记为已完成（勾选）", findArgs, async (find) => {
  const { list, task } = await resolveTask({ ...find, status: find.taskId ? undefined : "open" });
  if (task.status === "completed") return `“${task.title}”本来就是已完成状态`;
  await graph.updateTask(list.id, task.id, { status: "completed" });
  return `☑ 已完成：${task.title}（${list.displayName}）`;
});

register("uncomplete_task", "write", "取消任务的完成状态（取消勾选）", findArgs, async (find) => {
  const { list, task } = await resolveTask({ ...find, status: find.taskId ? undefined : "completed" });
  if (task.status !== "completed") return `“${task.title}”当前是${STATUS_CN[task.status] ?? task.status}状态，无需取消`;
  await graph.updateTask(list.id, task.id, { status: "notStarted" });
  return `☐ 已取消完成：${task.title}（${list.displayName}）`;
});

register(
  "update_task",
  "write",
  "修改任务：标题、截止日期、重要性、备注、提醒。clear_due=true 可清除截止日期",
  {
    ...findArgs,
    new_title: z.string().optional().describe("新标题"),
    clear_due: z.boolean().optional().describe("清除截止日期"),
    ...taskFields,
  },
  async ({ title, taskId, list, new_title, clear_due, ...rest }) => {
    const found = await resolveTask({ title, taskId, list });
    const patch = buildPatch(rest);
    if (new_title) patch.title = new_title;
    if (clear_due) patch.dueDateTime = null;
    if (!Object.keys(patch).length) return "没有需要修改的字段";
    const t = await graph.updateTask(found.list.id, found.task.id, patch);
    return `已更新：\n${fmtTask(t, found.list.displayName)}`;
  },
);

register(
  "delete_task",
  "destructive",
  "永久删除任务（不可恢复）。只有在用户明确要求删除时才调用。",
  findArgs,
  async (find) => {
    const { list, task } = await resolveTask(find);
    await graph.deleteTask(list.id, task.id);
    return `已删除：${task.title}（${list.displayName}）`;
  },
);

await server.connect(new StdioServerTransport());
const mode = READONLY ? "只读模式" : NO_DELETE ? "禁止删除模式" : "完整模式";
console.error(
  `[todo-mcp] Microsoft To Do MCP server 已启动（${mode}）` + (skipped.length ? `，未注册：${skipped.join(", ")}` : ""),
);
