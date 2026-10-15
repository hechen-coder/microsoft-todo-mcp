// 进程内防重复创建：模型经常因超时/误判而重复调用 add_task，Graph 没有幂等键，
// 这里在 TTL 内对“工具名 + 参数”相同的创建请求直接返回上次结果。服务重启后失效（有意为之）。

const TTL_MS = (Number(process.env.TODO_DEDUP_SECONDS) || 60) * 1000;

interface Entry {
  result: Promise<string>;
  expiresAt: number;
}

const store = new Map<string, Entry>();

/** 对象键排序后序列化，参数顺序不同也得到同一个 key */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export async function dedupe(tool: string, args: unknown, run: () => Promise<string>): Promise<string> {
  const now = Date.now();
  for (const [k, e] of store) if (e.expiresAt <= now) store.delete(k);

  const key = `${tool} ${stableStringify(args)}`;
  const hit = store.get(key);
  if (hit) {
    const text = await hit.result;
    return `${text}\n\n（${Math.round(TTL_MS / 1000)} 秒内收到相同的创建请求，已返回上次结果，没有重复创建。）`;
  }

  // 存 Promise 而不是结果，这样并发的两次相同调用也只会真正执行一次
  const result = run();
  store.set(key, { result, expiresAt: now + TTL_MS });
  try {
    return await result;
  } catch (e) {
    store.delete(key); // 失败的请求不缓存，允许重试
    throw e;
  }
}
