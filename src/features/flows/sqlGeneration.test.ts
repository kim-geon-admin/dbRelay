import { expect, test } from "vitest";
import { generateTargetSql, targetOperationForSql } from "./sqlGeneration";

test("recognizes Oracle MERGE as the upsert operation", () => {
  expect(targetOperationForSql("MERGE INTO customers target")).toBe("upsert");
});

test("generates an insert statement from a single-table source query", () => {
  expect(generateTargetSql("insert", "SELECT customer_id AS ID, name, email FROM customers")).toBe(
    "INSERT INTO customers (customer_id, name, email)\nVALUES (:ID, :name, :email)",
  );
});

test("generates an update example that uses the first source column as the key", () => {
  expect(generateTargetSql("update", "SELECT customer_id AS ID, name, email FROM customers")).toBe(
    "-- [가이드] Source SQL의 첫 번째 컬럼(customer_id)을 WHERE 조건으로 사용합니다. 실제 키 조건에 맞게 수정하세요.\nUPDATE customers\nSET\n  name = :name,\n  email = :email\nWHERE customer_id = :ID",
  );
});

test("generates Korean named binds for quoted Korean source identifiers", () => {
  expect(generateTargetSql("insert", "SELECT \"사용자ID\", \"표시명\" FROM \"사용자\"")).toBe(
    "INSERT INTO \"사용자\" (\"사용자ID\", \"표시명\")\nVALUES (:사용자ID, :표시명)",
  );
});

test("generates Korean named binds for quoted and unquoted Korean aliases", () => {
  expect(generateTargetSql("insert", "SELECT USER_ID AS \"사용자ID\", DISPLAY_NAME AS 사용자명 FROM USERS")).toBe(
    "INSERT INTO USERS (USER_ID, DISPLAY_NAME)\nVALUES (:사용자ID, :사용자명)",
  );
});

test("uses the source column on the left and its alias only for generated binds", () => {
  const source = "SELECT login_id AS 사용자ID, display_name 사용자명 FROM USERS";

  expect(generateTargetSql("insert", source)).toBe(
    "INSERT INTO USERS (login_id, display_name)\nVALUES (:사용자ID, :사용자명)",
  );
  expect(generateTargetSql("update", source)).toContain(
    "UPDATE USERS\nSET\n  display_name = :사용자명\nWHERE login_id = :사용자ID",
  );
  expect(generateTargetSql("upsert", source)).toContain(
    "USING (SELECT :사용자ID login_id, :사용자명 display_name FROM dual) source\nON (target.login_id = source.login_id)",
  );
});


test("generates an upsert guide from the first SELECT column without primary-key metadata", () => {
  expect(generateTargetSql("upsert", "SELECT customer_id AS ID, name FROM customers")).toBe(
    "-- [가이드] Source SQL의 첫 번째 컬럼(customer_id)을 대상 행 검색 ON 조건으로 사용합니다.\n-- [가이드] :ID, :name 값은 Source SQL의 SELECT 컬럼 값으로 자동 바인딩됩니다.\n-- [가이드] ON 조건은 대상 테이블의 실제 PK/UK 조건에 맞게 반드시 검토·수정하세요.\n-- [가이드] WHEN MATCHED THEN: 기존 행을 UPDATE합니다.\n-- [가이드] WHEN NOT MATCHED THEN: 새 행을 INSERT합니다.\nMERGE INTO customers target\nUSING (SELECT :ID customer_id, :name name FROM dual) source\nON (target.customer_id = source.customer_id)\nWHEN MATCHED THEN UPDATE SET\n  target.name = source.name\nWHEN NOT MATCHED THEN INSERT (customer_id, name)\nVALUES (source.customer_id, source.name)",
  );
});
