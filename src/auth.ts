import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  PublicClientApplication,
  type AccountInfo,
  type ICachePlugin,
  type TokenCacheContext,
} from "@azure/msal-node";

export const SCOPES = ["Tasks.ReadWrite", "User.Read"];
// 个人微软账号（outlook/hotmail/qq 邮箱注册的 MSA）用 consumers；工作/学校账号可改为 common/organizations
const AUTHORITY = `https://login.microsoftonline.com/${process.env.TODO_TENANT || "consumers"}`;

export const CONFIG_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), ".config"),
  "todo-mcp",
);
const CACHE_FILE = path.join(CONFIG_DIR, "msal-cache.json");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function readConfig(): { clientId?: string } {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveClientId(clientId: string) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), clientId }, null, 2));
}

// 微软官方公共客户端 “Microsoft Graph Command Line Tools”（Graph PowerShell 使用的应用），
// 支持个人账号 + 设备码 + 动态申请 Graph 权限。个人账号现在无法在 Entra 门户注册应用，因此默认用它。
const DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

export function getClientId(): string {
  return process.env.TODO_CLIENT_ID || readConfig().clientId || DEFAULT_CLIENT_ID;
}

const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext) {
    if (fs.existsSync(CACHE_FILE)) ctx.tokenCache.deserialize(fs.readFileSync(CACHE_FILE, "utf8"));
  },
  async afterCacheAccess(ctx: TokenCacheContext) {
    if (ctx.cacheHasChanged) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, ctx.tokenCache.serialize());
    }
  },
};

let pca: PublicClientApplication | undefined;
function getPca(): PublicClientApplication {
  pca ??= new PublicClientApplication({
    auth: { clientId: getClientId(), authority: AUTHORITY },
    cache: { cachePlugin },
  });
  return pca;
}

export async function getAccount(): Promise<AccountInfo | undefined> {
  const accounts = await getPca().getTokenCache().getAllAccounts();
  return accounts[0];
}

export class AuthRequiredError extends Error {}

export async function getToken(): Promise<string> {
  const account = await getAccount();
  if (!account) {
    throw new AuthRequiredError("尚未登录 Microsoft 账号：请调用 login 工具，或在项目目录运行 `npm run login`。");
  }
  try {
    const res = await getPca().acquireTokenSilent({ account, scopes: SCOPES });
    return res.accessToken;
  } catch (e) {
    throw new AuthRequiredError(
      `登录已失效（${(e as Error).message}）：请调用 login 工具，或运行 \`npm run login\` 重新登录。`,
    );
  }
}

/**
 * 设备码登录。onCode 在拿到验证码时被调用（用于提示用户），返回的 Promise 在用户完成登录后 resolve。
 */
export async function loginWithDeviceCode(onCode: (message: string) => void): Promise<AccountInfo> {
  return new Promise((resolve, reject) => {
    getPca()
      .acquireTokenByDeviceCode({
        scopes: SCOPES,
        deviceCodeCallback: (r) => {
          // Client ID 无效或未开启“允许公共客户端流”时，MSAL 会回调一个空对象
          if (!r?.userCode) {
            reject(
              new Error(
                "获取设备码失败：请确认 Client ID 正确、应用支持个人 Microsoft 帐户，并已开启“允许公共客户端流”。",
              ),
            );
            return;
          }
          onCode(r.message);
        },
      })
      .then((res) => (res?.account ? resolve(res.account) : reject(new Error("登录失败：未返回账号信息"))))
      .catch(reject);
  });
}

export async function logout() {
  const account = await getAccount();
  if (account) await getPca().getTokenCache().removeAccount(account);
}
