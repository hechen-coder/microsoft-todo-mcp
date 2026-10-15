// 把用户/模型给出的“列表名”“任务标题”解析成 Graph id
import { graph, type ChecklistItem, type TodoList, type TodoTask } from "./graph.js";

const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export async function resolveList(nameOrId?: string): Promise<TodoList> {
  const lists = await graph.listLists();
  if (!nameOrId) {
    const def = lists.find((l) => l.wellknownListName === "defaultList");
    if (!def) throw new Error("未找到默认列表“任务”");
    return def;
  }
  const byId = lists.find((l) => l.id === nameOrId);
  if (byId) return byId;
  const q = norm(nameOrId);
  // “任务”/“Tasks” 都指默认列表
  if (q === "任务" || q === "tasks") {
    const def = lists.find((l) => l.wellknownListName === "defaultList");
    if (def) return def;
  }
  const exact = lists.filter((l) => norm(l.displayName) === q);
  if (exact.length === 1) return exact[0];
  const fuzzy = lists.filter((l) => norm(l.displayName).includes(q));
  if (fuzzy.length === 1) return fuzzy[0];
  const names = lists.map((l) => `“${l.displayName}”`).join("、");
  if (fuzzy.length > 1) throw new Error(`列表名“${nameOrId}”匹配到多个：${fuzzy.map((l) => l.displayName).join("、")}`);
  throw new Error(`未找到列表“${nameOrId}”。现有列表：${names}`);
}

export interface FoundTask {
  list: TodoList;
  task: TodoTask;
}

/** 在指定列表（或全部列表）中查找任务 */
export async function findTasks(opts: {
  query?: string;
  list?: string;
  status?: "open" | "completed" | "all";
}): Promise<FoundTask[]> {
  const lists = opts.list ? [await resolveList(opts.list)] : await graph.listLists();
  const q = opts.query ? norm(opts.query) : undefined;
  const results = await Promise.all(
    lists
      .filter((l) => l.wellknownListName !== "flaggedEmails")
      .map(async (list) => {
        const tasks = await graph.listTasks(list.id, opts.status ?? "open");
        return tasks
          .filter((t) => !q || norm(t.title).includes(q))
          .map((task) => ({ list, task }));
      }),
  );
  return results.flat();
}

/**
 * 定位任务中的某个子步骤：支持步骤 id、序号（从 1 开始，"2" / "第2步"）、或步骤文字（部分匹配）。
 */
export async function resolveStep(found: FoundTask, step: string): Promise<ChecklistItem> {
  const items = await graph.listChecklistItems(found.list.id, found.task.id);
  if (!items.length) throw new Error(`任务“${found.task.title}”没有子步骤`);

  const byId = items.find((i) => i.id === step);
  if (byId) return byId;

  const idx = /^(?:第\s*)?(\d+)\s*(?:步|项)?$/.exec(step.trim());
  if (idx) {
    const n = Number(idx[1]);
    if (n >= 1 && n <= items.length) return items[n - 1];
    throw new Error(`任务“${found.task.title}”只有 ${items.length} 个步骤，没有第 ${n} 步`);
  }

  const q = norm(step);
  const exact = items.filter((i) => norm(i.displayName) === q);
  const pick = exact.length ? exact : items.filter((i) => norm(i.displayName).includes(q));
  if (pick.length === 1) return pick[0];
  const all = items.map((i, n) => `${n + 1}. ${i.isChecked ? "☑" : "☐"} ${i.displayName}`).join("\n");
  throw new Error(
    pick.length
      ? `“${step}”匹配到多个步骤，请用序号指定：\n${all}`
      : `任务“${found.task.title}”中没有步骤“${step}”。现有步骤：\n${all}`,
  );
}

/**
 * 通过 taskId 或标题定位唯一任务。标题优先精确匹配，其次包含匹配；多个命中时报错并列出候选。
 */
export async function resolveTask(opts: {
  taskId?: string;
  title?: string;
  list?: string;
  status?: "open" | "completed" | "all";
}): Promise<FoundTask> {
  if (opts.taskId) {
    const lists = opts.list ? [await resolveList(opts.list)] : await graph.listLists();
    for (const list of lists) {
      try {
        return { list, task: await graph.getTask(list.id, opts.taskId) };
      } catch {
        // 不在这个列表，继续找
      }
    }
    throw new Error(`未找到 id 为 ${opts.taskId} 的任务`);
  }
  if (!opts.title) throw new Error("请提供 taskId 或 title");

  const candidates = await findTasks({ query: opts.title, list: opts.list, status: opts.status ?? "all" });
  const q = norm(opts.title);
  const exact = candidates.filter((c) => norm(c.task.title) === q);
  const pick = exact.length ? exact : candidates;
  if (pick.length === 1) return pick[0];
  if (pick.length === 0) {
    throw new Error(
      `未在云端找到标题包含“${opts.title}”的任务。若它只在本机“我的一天”里且未同步，请先让 To Do 应用完成同步。`,
    );
  }
  const lines = pick
    .slice(0, 10)
    .map((c) => `- [${c.list.displayName}] ${c.task.title}（${c.task.status}） id=${c.task.id}`)
    .join("\n");
  throw new Error(`“${opts.title}”匹配到 ${pick.length} 个任务，请用 taskId 或更完整的标题指定：\n${lines}`);
}
