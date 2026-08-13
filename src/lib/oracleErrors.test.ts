import { expect, it } from "vitest";
import { formatConnectorError } from "./oracleErrors";

it("localizes an unlisted Oracle code by its documented error range", () => {
  expect(formatConnectorError("ORA-39999", "unsafe driver detail"))
    .toBe("ORA-39999 · Oracle 기능 실행 오류: Oracle 기능 실행 중 오류가 발생했습니다. 오류 코드를 확인하세요.");
});
