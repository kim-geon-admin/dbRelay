function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatHistoryDateTime(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
