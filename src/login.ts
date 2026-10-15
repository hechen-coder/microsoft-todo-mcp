// 命令行登录：microsoft-todo-mcp-cn login [clientId] [--force]
import { getAccount, loginWithDeviceCode, saveClientId } from "./auth.js";

export async function runLogin(args: string[]) {
  const force = args.includes("--force");
  const clientId = args.find((a) => !a.startsWith("--"));
  if (clientId) {
    saveClientId(clientId);
    console.log(`已保存 Client ID: ${clientId}`);
  }

  const existing = await getAccount();
  if (existing && !force) {
    console.log(`已登录：${existing.username}（如需切换账号，加 --force 重新登录）`);
    return;
  }

  const account = await loginWithDeviceCode((msg) => console.log(`\n${msg}\n`));
  console.log(`登录成功：${account.username}`);
}
