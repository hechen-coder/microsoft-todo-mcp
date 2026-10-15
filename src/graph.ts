import { getToken } from "./auth.js";
import { TIME_ZONE } from "./date.js";

const BASE = "https://graph.microsoft.com/v1.0";

export interface TodoList {
  id: string;
  displayName: string;
  wellknownListName?: "none" | "defaultList" | "flaggedEmails" | "unknownFutureValue";
  isShared?: boolean;
}

export interface DateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}

export interface TodoTask {
  id: string;
  title: string;
  status: "notStarted" | "inProgress" | "completed" | "waitingOnOthers" | "deferred";
  importance: "low" | "normal" | "high";
  body?: { content: string; contentType: string };
  dueDateTime?: DateTimeTimeZone;
  reminderDateTime?: DateTimeTimeZone;
  isReminderOn?: boolean;
  completedDateTime?: DateTimeTimeZone;
  createdDateTime?: string;
}

export interface ChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
}

export interface TaskPatch {
  title?: string;
  status?: TodoTask["status"];
  importance?: TodoTask["importance"];
  body?: { content: string; contentType: "text" | "html" };
  dueDateTime?: DateTimeTimeZone | null;
  reminderDateTime?: DateTimeTimeZone | null;
  isReminderOn?: boolean;
}

export class GraphError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = Number(process.env.TODO_TIMEOUT_MS) || 15_000;
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;
// 这些状态码表示请求未被处理，任何方法（包括 POST）重试都是安全的
const RETRYABLE_STATUS = new Set([429, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 指数退避 + 抖动：约 0.5s、1s、2s */
const backoffMs = (attempt: number) => 500 * 2 ** attempt + Math.random() * 250;

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const token = await getToken();
  // POST 在超时/断网时可能已经在服务端生效，自动重试会建出重复任务，所以只重试幂等方法
  const retryOnTransportError = method !== "POST";

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url.startsWith("http") ? url : BASE + url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          // 让返回的 dueDateTime 等使用本机时区，方便直接取日期
          Prefer: `outlook.timezone="${TIME_ZONE}"`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      if (retryOnTransportError && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const reason = timedOut ? `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）` : `网络错误：${(e as Error).message}`;
      const hint = method === "POST" ? "；写入可能已生效，请先查询确认再决定是否重试" : "";
      throw new GraphError(0, `Graph ${method} ${reason}${hint}。请检查网络/代理。`);
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "", 10);
      await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : backoffMs(attempt));
      continue;
    }
    break;
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {}
    if (res.status === 401) msg += "（授权失效，请调用 login 工具重新登录）";
    throw new GraphError(res.status, `Graph ${method} ${res.status}: ${msg}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

async function getAll<T>(url: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const page: { value: T[]; "@odata.nextLink"?: string } = await request("GET", next);
    out.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return out;
}

const enc = encodeURIComponent;

export const graph = {
  me: () => request<{ displayName: string; userPrincipalName?: string; mail?: string }>("GET", "/me"),

  listLists: () => getAll<TodoList>("/me/todo/lists"),

  createList: (displayName: string) => request<TodoList>("POST", "/me/todo/lists", { displayName }),

  listTasks: (listId: string, status: "open" | "completed" | "all" = "open") => {
    const filter =
      status === "open"
        ? `?$filter=${enc("status ne 'completed'")}`
        : status === "completed"
          ? `?$filter=${enc("status eq 'completed'")}`
          : "";
    return getAll<TodoTask>(`/me/todo/lists/${enc(listId)}/tasks${filter}`);
  },

  getTask: (listId: string, taskId: string) =>
    request<TodoTask>("GET", `/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}`),

  createTask: (listId: string, task: TaskPatch & { title: string }) =>
    request<TodoTask>("POST", `/me/todo/lists/${enc(listId)}/tasks`, task),

  updateTask: (listId: string, taskId: string, patch: TaskPatch) =>
    request<TodoTask>("PATCH", `/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}`, patch),

  deleteTask: (listId: string, taskId: string) =>
    request<void>("DELETE", `/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}`),

  listChecklistItems: (listId: string, taskId: string) =>
    getAll<ChecklistItem>(`/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}/checklistItems`),

  addChecklistItem: (listId: string, taskId: string, displayName: string) =>
    request<ChecklistItem>("POST", `/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}/checklistItems`, {
      displayName,
    }),

  updateChecklistItem: (
    listId: string,
    taskId: string,
    itemId: string,
    patch: { displayName?: string; isChecked?: boolean },
  ) =>
    request<ChecklistItem>(
      "PATCH",
      `/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}/checklistItems/${enc(itemId)}`,
      patch,
    ),

  deleteChecklistItem: (listId: string, taskId: string, itemId: string) =>
    request<void>("DELETE", `/me/todo/lists/${enc(listId)}/tasks/${enc(taskId)}/checklistItems/${enc(itemId)}`),
};
