import { expect, test } from "vitest";
import { generateTargetSql } from "./sqlGeneration";

test("generates an insert statement from a single-table source query", () => {
  expect(generateTargetSql("insert", "SELECT customer_id AS ID, name, email FROM customers")).toBe(
    "INSERT INTO customers (ID, name, email)\nVALUES (:ID, :name, :email)",
  );
});

test("generates an update example that uses the first source column as the key", () => {
  expect(generateTargetSql("update", "SELECT customer_id AS ID, name, email FROM customers")).toBe(
    "-- 생성된 WHERE 절을 검토하고, 필요한 경우 대상 테이블의 기본 키로 대체하십시오\nUPDATE customers\nSET\n  name = :name,\n  email = :email\nWHERE ID = :ID",
  );
});
