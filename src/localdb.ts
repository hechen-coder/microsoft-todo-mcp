// 只读访问 To Do 桌面应用的本地 SQLite 缓存，用于获取 Graph 不提供的“我的一天”。
// 只以 readOnly 打开，绝不写入。
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const ROOT = path.join(
  process.env.LOCALAPPDATA || "",
  "Packages",
  "Microsoft.Todos_8wekyb3d8bbwe",
  "LocalState",
  "AccountsRoot",
);

export function findLocalDb(): string {
  if (process.env.TODO_LOCAL_DB) return process.env.TODO_LOCAL_DB;
  if (!fs.existsSync(ROOT)) throw new Error(`未找到 To Do 本地数据目录：${ROOT}`);
  const dbs = fs
    .readdirSync(ROOT)
    .map((d) => path.join(ROOT, d, "todosqlite.db"))
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!dbs.length) throw new Error(`在 ${ROOT} 下未找到 todosqlite.db`);
  return dbs[0]; // 多账号时取最近更新的
}

async function openDb(): Promise<DatabaseSyncType> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error("当前 Node 不支持 node:sqlite：请用 Node ≥22.13，或以 `node --experimental-sqlite` 启动。");
  }
  return new sqlite.DatabaseSync(findLocalDb(), { readOnly: true });
}

export interface LocalTask {
  title: string;
  status: string;
  importance: number;
  dueDate: string | null;
  list: string | null;
  onlineId: string | null;
}

export async function getMyDay(date: string): Promise<LocalTask[]> {
  const db = await openDb();
  try {
    const rows = db
      .prepare(
        `SELECT t.subject AS title, t.status, t.importance, t.due_date AS dueDate,
                f.name AS list, t.online_id AS onlineId
         FROM tasks t LEFT JOIN task_folders f ON t.task_folder_local_id = f.local_id
         WHERE t.committed_date = ? AND t.deleted = 0 AND t.delete_after_sync = 0
         ORDER BY t.committed_order DESC`,
      )
      .all(date);
    return rows as unknown as LocalTask[];
  } finally {
    db.close();
  }
}
