// 本地日期工具。Graph 的 dueDateTime 是 {dateTime, timeZone}，这里统一用本机时区。

export const TIME_ZONE =
  process.env.TODO_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** 本机时区下的日期 YYYY-MM-DD，offsetDays 可用于“明天”等 */
export function localDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  // sv-SE 格式恰好是 YYYY-MM-DD
  return d.toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });
}

export function today(): string {
  return localDate(0);
}

/** 解析用户输入的日期：today/今天、tomorrow/明天、YYYY-MM-DD */
export function parseDate(input: string): string {
  const s = input.trim().toLowerCase();
  if (s === "today" || s === "今天") return localDate(0);
  if (s === "tomorrow" || s === "明天") return localDate(1);
  if (s === "后天") return localDate(2);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`无法识别的日期 "${input}"，请使用 YYYY-MM-DD / today / tomorrow`);
}

export function toGraphDate(date: string) {
  return { dateTime: `${date}T00:00:00`, timeZone: TIME_ZONE };
}

/** 解析提醒时间：YYYY-MM-DD HH:mm 或 HH:mm（默认今天） */
export function toGraphDateTime(input: string) {
  const s = input.trim().replace("T", " ");
  let m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})$/.exec(s);
  if (m) return { dateTime: `${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:00`, timeZone: TIME_ZONE };
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return { dateTime: `${today()}T${m[1].padStart(2, "0")}:${m[2]}:00`, timeZone: TIME_ZONE };
  throw new Error(`无法识别的时间 "${input}"，请使用 "YYYY-MM-DD HH:mm" 或 "HH:mm"`);
}
