import { expect, test } from "vitest";
import { generateTargetSql, targetOperationForSql, targetSqlGenerationFor } from "./sqlGeneration";

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

test("generates INSERT columns from a single-table SELECT * preview", () => {
  expect(targetSqlGenerationFor("insert", "SELECT * FROM SRC_USERS", ["USER_ID", "CREATED_ON", "CREATED_AT"])).toEqual({
    sql: "INSERT INTO SRC_USERS (USER_ID, CREATED_ON, CREATED_AT)\nVALUES (:USER_ID, :CREATED_ON, :CREATED_AT)",
  });
});

test("generates INSERT columns from a filtered, aliased, or qualified SELECT *", () => {
  // Would fail if the wildcard parser required the table name to end the
  // statement, which drops the common WHERE-filtered source query.
  expect(targetSqlGenerationFor("insert", "SELECT * FROM TGT_USERS \nWHERE user_id=1002", ["USER_ID", "LOGIN_ID"])).toEqual({
    sql: "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID)\nVALUES (:USER_ID, :LOGIN_ID)",
  });
  expect(targetSqlGenerationFor("insert", "select * from scott.tgt_users u where u.user_id = 1002 order by user_id;", ["USER_ID"])).toEqual({
    sql: "INSERT INTO scott.tgt_users (USER_ID)\nVALUES (:USER_ID)",
  });
});

test("refuses SELECT * generation when the source reads more than one table", () => {
  // Would fail if a trailing clause check accepted joins, comma joins, or a
  // union, which would name the wrong INSERT target.
  const reason = "단일 테이블의 단순 SELECT 컬럼 목록에서만 Target SQL을 생성할 수 있습니다.";
  for (const sourceSql of [
    "SELECT * FROM TGT_USERS, TGT_ROLES",
    "SELECT * FROM TGT_USERS u JOIN TGT_ROLES r ON u.role_id = r.id",
    "SELECT * FROM TGT_USERS UNION SELECT * FROM TGT_ROLES",
    "SELECT * FROM (SELECT user_id FROM TGT_USERS)",
  ]) {
    expect(targetSqlGenerationFor("insert", sourceSql, ["USER_ID"])).toEqual({ sql: "", reason });
  }
});

test("explains why SELECT * INSERT generation is unavailable", () => {
  expect(targetSqlGenerationFor("insert", "SELECT * FROM SRC_USERS", ["USER_ID", "user_id"])).toEqual({
    sql: "",
    reason: "미리보기 컬럼에 중복된 이름이 있어 Target SQL을 생성할 수 없습니다.",
  });
  expect(targetSqlGenerationFor("upsert", "SELECT * FROM SRC_USERS", ["USER_ID"])).toEqual({
    sql: "",
    reason: "SELECT * 자동 생성은 INSERT 작업에서만 지원됩니다.",
  });
  expect(targetSqlGenerationFor("insert", "SELECT USER_ID AS ID, NAME AS id FROM SRC_USERS")).toEqual({
    sql: "",
    reason: "Source SQL의 SELECT 컬럼 별칭이 중복되어 Target SQL을 생성할 수 없습니다.",
  });
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
