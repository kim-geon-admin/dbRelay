const BIND_TYPE_TOKEN = /^bind-type-unsupported:([A-Za-z][A-Za-z0-9_$#]*):(large_integer|mixed|source_column|timestamp_timezone)$/u;

export function safeConnectorDiagnostic(code: string, message: string): string | undefined {
  if (code !== "BIND_TYPE_UNSUPPORTED") {
    return undefined;
  }

  const tokenMatch = BIND_TYPE_TOKEN.exec(message);
  if (tokenMatch !== null) {
    return bindDiagnostic(tokenMatch[1], tokenMatch[2]);
  }

  if (isPersistedBindDiagnostic(message)) {
    return message;
  }

  return "대상 바인드에 지원되지 않는 데이터 유형이 포함되어 있습니다.";
}

function bindDiagnostic(bindName: string, reason: string): string {
  switch (reason) {
    case "large_integer":
      return `바인드 :${bindName}에 큰 정수 값이 있어 현재 실행할 수 없습니다.`;
    case "mixed":
      return `바인드 :${bindName}에 서로 다른 데이터 유형이 섞여 있습니다.`;
    case "source_column":
      return `바인드 :${bindName}에 연결된 소스 컬럼 유형을 지원하지 않습니다.`;
    case "timestamp_timezone":
      return `바인드 :${bindName}에 시간대 정보가 포함된 TIMESTAMP 값이 있습니다.`;
  }
  return "대상 바인드에 지원되지 않는 데이터 유형이 포함되어 있습니다.";
}

function isPersistedBindDiagnostic(message: string): boolean {
  const bindName = "[A-Za-z][A-Za-z0-9_$#]*";
  return new RegExp(
    `^바인드 :${bindName}(에 큰 정수 값이 있어 현재 실행할 수 없습니다\\.|에 서로 다른 데이터 유형이 섞여 있습니다\\.|에 연결된 소스 컬럼 유형을 지원하지 않습니다\\.|에 시간대 정보가 포함된 TIMESTAMP 값이 있습니다\\.)$`,
    "u",
  ).test(message);
}
