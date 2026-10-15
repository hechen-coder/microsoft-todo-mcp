#!/usr/bin/env node
// 命令行入口：
//   microsoft-todo-mcp-cn            启动 MCP 服务（stdio）
//   microsoft-todo-mcp-cn login      设备码登录（可选参数：clientId、--force）
//   microsoft-todo-mcp-cn logout     删除本机登录缓存
import { spawn } from "node:child_process";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "login") {
  const { runLogin } = await import("./login.js");
  await runLogin(rest);
} else if (cmd === "logout") {
  const { logout } = await import("./auth.js");
  await logout();
  console.log("已退出登录（本机令牌缓存已清除）");
} else if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(`用法：
  microsoft-todo-mcp-cn            启动 MCP 服务（由 Claude 等客户端调用）
  microsoft-todo-mcp-cn login      登录微软账号（首次使用前运行一次）
  microsoft-todo-mcp-cn logout     退出登录`);
} else if (!(await sqliteAvailable()) && canEnableSqliteFlag()) {
  // Node 22.5 ~ 22.12 需要 --experimental-sqlite 才能读取“我的一天”，自动带上该参数重启自身
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
} else {
  // 更老的 Node 没有 node:sqlite：服务照常运行，只有 get_my_day 不可用
  await import("./index.js");
}

async function sqliteAvailable(): Promise<boolean> {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function canEnableSqliteFlag(): boolean {
  return (
    process.allowedNodeEnvironmentFlags.has("--experimental-sqlite") &&
    !process.execArgv.includes("--experimental-sqlite")
  );
}
