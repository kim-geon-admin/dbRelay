const Database = require("better-sqlite3");

const db = new Database("C:\\Users\\kg\\AppData\\Roaming\\db-relay\\db-relay.sqlite", { timeout: 5000 });
const sourceId = "1254066f-3670-423e-8731-e23c2c1217c9";
const targetId = "local2-target-profile";
const failures = [
  ["pk-user", "PK 위배", "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID, DISPLAY_NAME, EMAIL, USER_STATUS, REGISTERED_AT) VALUES (1001, :LOGIN_ID, :DISPLAY_NAME, :EMAIL, :USER_STATUS, :REGISTERED_AT)"],
  ["unique-login", "LOGIN_ID UNIQUE 위배", "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID, DISPLAY_NAME, EMAIL, USER_STATUS, REGISTERED_AT) VALUES (:USER_ID, 'han.seojun', :DISPLAY_NAME, :EMAIL, :USER_STATUS, :REGISTERED_AT)"],
  ["unique-email", "EMAIL UNIQUE 위배", "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID, DISPLAY_NAME, EMAIL, USER_STATUS, REGISTERED_AT) VALUES (:USER_ID, :LOGIN_ID, :DISPLAY_NAME, 'han.seojun@example.test', :USER_STATUS, :REGISTERED_AT)"],
  ["missing-column", "없는 컬럼", "UPDATE TGT_USERS SET NO_SUCH_COLUMN = :DISPLAY_NAME WHERE USER_ID = :USER_ID"],
  ["wrong-table", "없는 테이블", "UPDATE TGT_USERS_MISSING SET DISPLAY_NAME = :DISPLAY_NAME WHERE USER_ID = :USER_ID"],
  ["wrong-address-column", "주소 컬럼 오류", "UPDATE TGT_USER_ADDRESSES SET UNKNOWN_CITY = :CITY WHERE ADDRESS_ID = :ADDRESS_ID"],
  ["fk-address", "주소 FK 위배", "UPDATE TGT_USER_ADDRESSES SET USER_ID = 999999 WHERE ADDRESS_ID = :ADDRESS_ID"],
  ["not-null-user", "NOT NULL 위배", "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID, DISPLAY_NAME, EMAIL, USER_STATUS, REGISTERED_AT) VALUES (:USER_ID, :LOGIN_ID, NULL, :EMAIL, :USER_STATUS, :REGISTERED_AT)"],
  ["check-status", "CHECK 위배", "UPDATE TGT_USERS SET USER_STATUS = 'BROKEN' WHERE USER_ID = :USER_ID"],
  ["invalid-number", "숫자 변환 오류", "UPDATE TGT_USERS SET USER_ID = TO_NUMBER(:LOGIN_ID) WHERE USER_ID = :USER_ID"],
  ["too-many-values", "값 개수 초과", "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID) VALUES (:USER_ID, :LOGIN_ID, :EMAIL)"],
  ["not-enough-values", "값 부족", "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID, DISPLAY_NAME) VALUES (:USER_ID, :LOGIN_ID)"],
  ["invalid-insert-syntax", "INSERT 구문 오류", "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID) VALUES (:USER_ID, :LOGIN_ID"],
  ["missing-where", "WHERE 누락 위험", "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME"],
  ["wrong-export-table", "내보내기 테이블 오류", "UPDATE TGT_USER_CONTACT_EXPORT_MISSING SET CITY = :CITY WHERE CONTACT_EXPORT_ID = :CONTACT_EXPORT_ID"],
  ["pk-address", "주소 PK 위배", "INSERT INTO TGT_USER_ADDRESSES (ADDRESS_ID, USER_ID, ADDRESS_TYPE, POSTAL_CODE, CITY, ADDRESS_LINE1, IS_PRIMARY, CREATED_AT) VALUES (2001, :USER_ID, :ADDRESS_TYPE, :POSTAL_CODE, :CITY, :ADDRESS_LINE1, :IS_PRIMARY, :CREATED_AT)"],
  ["pk-export", "내보내기 PK 위배", "INSERT INTO TGT_USER_CONTACT_EXPORT (CONTACT_EXPORT_ID, USER_ID, ADDRESS_ID, LOGIN_ID, EMAIL, ADDRESS_TYPE, CITY, POSTAL_CODE) VALUES (3001, :USER_ID, :ADDRESS_ID, :LOGIN_ID, :EMAIL, :ADDRESS_TYPE, :CITY, :POSTAL_CODE)"],
  ["fk-export-address", "내보내기 FK 위배", "UPDATE TGT_USER_CONTACT_EXPORT SET ADDRESS_ID = 999999 WHERE CONTACT_EXPORT_ID = :CONTACT_EXPORT_ID"],
  ["duplicate-pk-update", "UPDATE PK 충돌", "UPDATE TGT_USERS SET USER_ID = 1002 WHERE USER_ID = :USER_ID"],
  ["duplicate-login-update", "UPDATE LOGIN_ID 충돌", "UPDATE TGT_USERS SET LOGIN_ID = 'han.seojun' WHERE USER_ID = :USER_ID"],
  ["duplicate-email-update", "UPDATE EMAIL 충돌", "UPDATE TGT_USERS SET EMAIL = 'han.seojun@example.test' WHERE USER_ID = :USER_ID"],
  ["invalid-timestamp", "TIMESTAMP 변환 오류", "UPDATE TGT_USERS SET REGISTERED_AT = TO_TIMESTAMP(:LOGIN_ID, 'YYYY-MM-DD') WHERE USER_ID = :USER_ID"],
  ["value-too-large", "문자열 길이 초과", "UPDATE TGT_USERS SET DISPLAY_NAME = RPAD(:DISPLAY_NAME, 5000, 'X') WHERE USER_ID = :USER_ID"],
  ["column-count-mismatch", "컬럼 수 불일치", "INSERT INTO TGT_USER_ADDRESSES (ADDRESS_ID, USER_ID, CITY) VALUES (:ADDRESS_ID, :USER_ID, :CITY, :POSTAL_CODE)"],
  ["wrong-address-table", "주소 테이블 오류", "INSERT INTO TGT_USER_ADDRESS_MISSING (ADDRESS_ID, USER_ID) VALUES (:ADDRESS_ID, :USER_ID)"],
  ["invalid-set-column", "SET 컬럼 오류", "UPDATE TGT_USER_CONTACT_EXPORT SET BAD_FIELD = :CITY WHERE CONTACT_EXPORT_ID = :CONTACT_EXPORT_ID"],
  ["invalid-parenthesis", "괄호 구문 오류", "UPDATE TGT_USERS SET DISPLAY_NAME = (:DISPLAY_NAME WHERE USER_ID = :USER_ID"],
  ["missing-bind", "바인드 누락", "UPDATE TGT_USERS SET DISPLAY_NAME = :MISSING_BIND WHERE USER_ID = :USER_ID"],
  ["invalid-date-function", "날짜 함수 오류", "UPDATE TGT_USERS SET REGISTERED_AT = TO_DATE(:EMAIL, 'YYYY-MM-DD') WHERE USER_ID = :USER_ID"],
  ["invalid-insert-column", "INSERT 컬럼 오류", "INSERT INTO TGT_USER_CONTACT_EXPORT (CONTACT_EXPORT_ID, BAD_FIELD) VALUES (:CONTACT_EXPORT_ID, :EMAIL)"],
  ["not-null-email", "사용자 EMAIL 미입력", "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID, DISPLAY_NAME, EMAIL, USER_STATUS, REGISTERED_AT) VALUES (:USER_ID, :LOGIN_ID, :DISPLAY_NAME, NULL, :USER_STATUS, :REGISTERED_AT)"],
  ["not-null-city", "주소 CITY 미입력", "INSERT INTO TGT_USER_ADDRESSES (ADDRESS_ID, USER_ID, ADDRESS_TYPE, POSTAL_CODE, CITY, ADDRESS_LINE1, IS_PRIMARY, CREATED_AT) VALUES (:ADDRESS_ID, :USER_ID, :ADDRESS_TYPE, :POSTAL_CODE, NULL, :ADDRESS_LINE1, :IS_PRIMARY, :CREATED_AT)"],
  ["not-null-export-login", "내보내기 LOGIN_ID 미입력", "INSERT INTO TGT_USER_CONTACT_EXPORT (CONTACT_EXPORT_ID, USER_ID, ADDRESS_ID, LOGIN_ID, EMAIL, ADDRESS_TYPE, CITY, POSTAL_CODE) VALUES (:CONTACT_EXPORT_ID, :USER_ID, :ADDRESS_ID, NULL, :EMAIL, :ADDRESS_TYPE, :CITY, :POSTAL_CODE)"],
];
function sourceSql(index) {
  return `SELECT u.USER_ID AS USER_ID, u.LOGIN_ID AS LOGIN_ID, u.DISPLAY_NAME AS DISPLAY_NAME, u.EMAIL AS EMAIL, u.USER_STATUS AS USER_STATUS, u.REGISTERED_AT AS REGISTERED_AT, a.ADDRESS_ID AS ADDRESS_ID, a.ADDRESS_TYPE AS ADDRESS_TYPE, a.POSTAL_CODE AS POSTAL_CODE, a.CITY AS CITY, a.ADDRESS_LINE1 AS ADDRESS_LINE1, a.IS_PRIMARY AS IS_PRIMARY, a.CREATED_AT AS CREATED_AT, e.CONTACT_EXPORT_ID AS CONTACT_EXPORT_ID FROM SRC_USERS u JOIN SRC_USER_ADDRESSES a ON a.USER_ID = u.USER_ID JOIN SRC_USER_CONTACT_EXPORT e ON e.USER_ID = u.USER_ID AND e.ADDRESS_ID = a.ADDRESS_ID WHERE u.USER_ID BETWEEN 1001 AND 1030 AND MOD(u.USER_ID, 30) = ${index % 2}`;
}
try {
  db.transaction(() => {
    const save = db.prepare("INSERT INTO flows (id, name, source_connection_id, target_connection_id, transaction_policy, version) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET name = excluded.name, source_connection_id = excluded.source_connection_id, target_connection_id = excluded.target_connection_id, transaction_policy = excluded.transaction_policy, version = flows.version + 1");
    const clear = db.prepare("DELETE FROM query_steps WHERE flow_id = ?");
    const add = db.prepare("INSERT INTO query_steps (flow_id, position, id, select_sql, upsert_sql) VALUES (?, ?, ?, ?, ?)");
    failures.forEach(([code, label, badSql], index) => {
      const id = `local2-dml-error-${String(index + 1).padStart(2, "0")}`;
      const policy = index < 15 ? "all_or_nothing" : "commit_successes";
      const safe = "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE USER_ID = :USER_ID";
      save.run(id, `로컬2 오류 ${String(index + 1).padStart(2, "0")}: ${label}`, sourceId, targetId, policy);
      clear.run(id);
      add.run(id, 0, "precheck", sourceSql(index), safe);
      add.run(id, 1, code, sourceSql(index), badSql);
      add.run(id, 2, "after-error", sourceSql(index), safe);
    });
  })();
  const flowCount = db.prepare("SELECT COUNT(*) AS count FROM flows WHERE id LIKE 'local2-dml-error-%'").get().count;
  const stepCount = db.prepare("SELECT COUNT(*) AS count FROM query_steps WHERE flow_id LIKE 'local2-dml-error-%'").get().count;
  const policies = db.prepare("SELECT transaction_policy, COUNT(*) AS count FROM flows WHERE id LIKE 'local2-dml-error-%' GROUP BY transaction_policy ORDER BY transaction_policy").all();
  if (flowCount !== 33 || stepCount !== 99) throw new Error("storage verification failed");
  console.log(JSON.stringify({ flowCount, stepCount, policies }));
} finally { db.close(); }
