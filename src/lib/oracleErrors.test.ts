import { expect, it } from "vitest";
import { formatConnectorError } from "./oracleErrors";

it("localizes an unlisted Oracle code by its documented error range", () => {
  expect(formatConnectorError("ORA-39999", "unsafe driver detail"))
    .toBe("ORA-39999 · Oracle 기능 실행 오류: Oracle 기능 실행 중 오류가 발생했습니다. 오류 코드를 확인하세요.");
});

it("localizes a common parenthesis error without using the driver message", () => {
  const formatted = formatConnectorError("ORA-00907", "unsafe driver detail");

  expect(formatted).toContain("ORA-00907");
  expect(formatted).toContain("\uC624\uB978\uCABD \uAD04\uD638\uAC00 \uB204\uB77D\uB418\uC5C8\uC2B5\uB2C8\uB2E4");
  expect(formatted).not.toContain("unsafe driver detail");
});

it.each([
  ["ORA-01045", "CREATE SESSION 권한 없음"],
  ["ORA-01950", "테이블스페이스 할당량 부족"],
  ["ORA-00904", "유효하지 않은 식별자입니다 (존재하지 않는 컬럼명 등)"],
  ["ORA-00933", "SQL 명령이 올바르게 종료되지 않았습니다"],
  ["ORA-02290", "체크 제약 조건 위반"],
  ["ORA-01722", "잘못된 숫자"],
  ["ORA-01861", "리터럴이 형식 문자열과 일치하지 않음"],
])("localizes common Oracle error %s", (code, name) => {
  expect(formatConnectorError(code, "unsafe driver detail")).toContain(`${code} · ${name}`);
});

it.each([
  ["ORA-00900", "유효하지 않은 SQL 문입니다"],
  ["ORA-00901", "유효하지 않은 CREATE 명령입니다"],
  ["ORA-00902", "유효하지 않은 데이터 유형입니다"],
  ["ORA-00903", "유효하지 않은 테이블 이름입니다"],
  ["ORA-00904", "유효하지 않은 식별자입니다 (존재하지 않는 컬럼명 등)"],
  ["ORA-00905", "키워드가 누락되었습니다"],
  ["ORA-00906", "왼쪽 괄호가 누락되었습니다"],
  ["ORA-00907", "오른쪽 괄호가 누락되었습니다"],
  ["ORA-00908", "NULL 키워드가 누락되었습니다"],
  ["ORA-00909", "인자(argument)의 개수가 잘못되었습니다"],
  ["ORA-00910", "해당 데이터 유형에 비해 길이가 너무 깁니다"],
  ["ORA-00911", "유효하지 않은 문자입니다"],
  ["ORA-00913", "값이 너무 많습니다"],
  ["ORA-00914", "EXPRESSION 키워드가 누락되었습니다"],
  ["ORA-00917", "콤마(,)가 누락되었습니다"],
  ["ORA-00918", "컬럼이 모호하게 정의되었습니다 (중복 컬럼명)"],
  ["ORA-00920", "유효하지 않은 관계 연산자입니다"],
  ["ORA-00921", "SQL 명령이 예기치 않게 끝났습니다"],
  ["ORA-00922", "옵션이 누락되었거나 유효하지 않습니다"],
  ["ORA-00923", "예상되는 위치에 FROM 키워드가 없습니다"],
  ["ORA-00924", "BY 키워드가 누락되었습니다"],
  ["ORA-00925", "INTO 키워드가 누락되었습니다"],
  ["ORA-00926", "VALUES 키워드가 누락되었습니다"],
  ["ORA-00928", "SELECT 키워드가 누락되었습니다"],
  ["ORA-00931", "식별자가 누락되었습니다"],
  ["ORA-00932", "데이터 유형이 일치하지 않습니다"],
  ["ORA-00933", "SQL 명령이 올바르게 종료되지 않았습니다"],
  ["ORA-00934", "이 위치에서는 그룹 함수를 사용할 수 없습니다"],
  ["ORA-00936", "표현식(expression)이 누락되었습니다"],
  ["ORA-00937", "단일 그룹 함수가 아닙니다"],
  ["ORA-00938", "함수에 대한 인자가 부족합니다"],
  ["ORA-00939", "함수에 대한 인자가 너무 많습니다"],
  ["ORA-00941", "유효하지 않은 스키마 이름입니다"],
  ["ORA-00944", "유효하지 않은 컬럼 이름입니다"],
  ["ORA-00970", "WITH 키워드가 누락되었습니다"],
  ["ORA-00971", "SET 키워드가 누락되었습니다"],
  ["ORA-00972", "식별자(테이블/컬럼명 등)가 너무 깁니다 (30바이트/128바이트 초과)"],
  ["ORA-00979", "GROUP BY 표현식이 아닙니다"],
  ["ORA-00983", "NULL을 삽입할 수 없습니다"],
  ["ORA-00984", "이 위치에서는 컬럼을 사용할 수 없습니다"],
  ["ORA-00987", "사용자명이 누락되었거나 유효하지 않습니다"],
])("uses the requested Korean explanation for %s", (code, description) => {
  const formatted = formatConnectorError(code, "unsafe driver detail");

  expect(formatted).toContain(description);
  expect(formatted).not.toContain("unsafe driver detail");
});
