export type OracleErrorInfo = {
  name: string;
  description: string;
};

export const ORACLE_ERROR_CATALOG: Readonly<Record<string, OracleErrorInfo>> = {
  "ORA-00001": { name: "고유 제약 조건 위반", description: "동일한 값이 이미 존재합니다. 중복 키 또는 고유 인덱스를 확인하세요." },
  "ORA-00942": { name: "테이블 또는 뷰가 존재하지 않음", description: "객체 이름, 스키마, 그리고 조회 권한을 확인하세요." },
  "ORA-01017": { name: "사용자 이름 또는 비밀번호가 올바르지 않음", description: "접속 계정 정보와 계정 상태를 확인하세요." },
  "ORA-01031": { name: "권한 부족", description: "실행 계정에 필요한 객체 권한이 있는지 확인하세요." },
  "ORA-01400": { name: "NULL 값을 삽입할 수 없음", description: "필수 컬럼에 값이 매핑되었는지 확인하세요." },
  "ORA-02291": { name: "상위 키를 찾을 수 없음", description: "참조 대상의 상위 데이터가 먼저 존재하는지 확인하세요." },
  "ORA-02292": { name: "하위 레코드가 존재함", description: "참조 중인 하위 데이터를 먼저 처리하세요." },
  "ORA-03113": { name: "통신 채널 연결 종료", description: "데이터베이스 연결이 끊겼습니다. 네트워크와 데이터베이스 상태를 확인하세요." },
  "ORA-12154": { name: "접속 식별자를 해석할 수 없음", description: "호스트, 포트, 서비스 이름 설정을 확인하세요." },
  "ORA-12514": { name: "리스너가 요청한 서비스를 알 수 없음", description: "서비스 이름과 리스너 등록 상태를 확인하세요." },
  "ORA-12541": { name: "리스너가 없음", description: "호스트, 포트, 그리고 Oracle 리스너 실행 상태를 확인하세요." },
  "ORA-28000": { name: "계정 잠김", description: "Oracle 관리자에게 계정 잠금 해제를 요청하세요." },
  "ORA-20000": { name: "애플리케이션 오류", description: "데이터베이스의 애플리케이션 오류 로그를 확인하세요." },
};

const ORACLE_ERROR_RANGES: ReadonlyArray<{ from: number; to: number; info: OracleErrorInfo }> = [
  { from: 0, to: 899, info: { name: "Oracle 인스턴스 오류", description: "Oracle 인스턴스와 시스템 상태를 확인하세요." } },
  { from: 900, to: 1499, info: { name: "SQL 구문 또는 실행 오류", description: "SQL 구문, 객체 이름, 권한, 그리고 입력 값을 확인하세요." } },
  { from: 1500, to: 2098, info: { name: "데이터베이스 저장소 또는 트랜잭션 오류", description: "트랜잭션 상태와 데이터베이스 저장소 상태를 확인하세요." } },
  { from: 2100, to: 4999, info: { name: "Oracle SQL 실행 오류", description: "SQL 실행 조건과 데이터베이스 객체 상태를 확인하세요." } },
  { from: 5000, to: 9999, info: { name: "Oracle 시스템 오류", description: "데이터베이스 시스템 로그와 운영 상태를 확인하세요." } },
  { from: 10000, to: 19999, info: { name: "SQL 실행 오류", description: "SQL 실행 조건과 접속 상태를 확인하세요." } },
  { from: 20000, to: 32799, info: { name: "애플리케이션 또는 SQL 실행 오류", description: "애플리케이션 처리와 SQL 실행 조건을 확인하세요." } },
  { from: 32800, to: 59999, info: { name: "Oracle 기능 실행 오류", description: "Oracle 기능 실행 중 오류가 발생했습니다. 오류 코드를 확인하세요." } },
  { from: 60000, to: 99999, info: { name: "Oracle 데이터베이스 오류", description: "Oracle 데이터베이스 오류입니다. 오류 코드를 확인하세요." } },
];

export function formatConnectorError(code: string, message: string): string {
  const known = ORACLE_ERROR_CATALOG[code];
  if (known !== undefined) {
    return `${code} · ${known.name}: ${known.description}`;
  }
  const errorNumber = oracleErrorNumber(code);
  if (errorNumber !== undefined) {
    const range = ORACLE_ERROR_RANGES.find(({ from, to }) => errorNumber >= from && errorNumber <= to);
    if (range !== undefined) {
      return `${code} · ${range.info.name}: ${range.info.description}`;
    }
  }
  return `${code}: ${message}`;
}

function oracleErrorNumber(code: string): number | undefined {
  const match = /^ORA-(\d{5})$/u.exec(code);
  return match === null ? undefined : Number(match[1]);
}
