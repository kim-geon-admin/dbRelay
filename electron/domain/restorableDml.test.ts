import { describe, expect, it } from "vitest";

import { parseRestorableDml } from "./restorableDml";

describe("parseRestorableDml", () => {
  it("recognizes a USER_ID update and its assigned columns", () => {
    expect(parseRestorableDml(
      "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME, EMAIL = :EMAIL WHERE USER_ID = :USER_ID",
    )).toMatchObject({
      kind: "update", table: "TGT_USERS",
      keyTerms: [{ column: "USER_ID", bindName: "USER_ID" }],
      assignedColumns: ["DISPLAY_NAME", "EMAIL"],
    });
  });

  it("recognizes a non-USER_ID key joined by AND terms", () => {
    expect(parseRestorableDml(
      "UPDATE ACCOUNTS SET DISPLAY_NAME = :DISPLAY_NAME WHERE LOGIN_ID = :LOGIN_ID AND TENANT_ID = :TENANT_ID",
    )).toMatchObject({
      kind: "update", table: "ACCOUNTS", assignedColumns: ["DISPLAY_NAME"],
      keyTerms: [
        { column: "LOGIN_ID", bindName: "LOGIN_ID" },
        { column: "TENANT_ID", bindName: "TENANT_ID" },
      ],
    });
  });

  it("recognizes a USER_ID update when Oracle comments surround its clauses", () => {
    expect(parseRestorableDml(`
      -- apply the profile name
      UPDATE TGT_USERS
      SET DISPLAY_NAME = :DISPLAY_NAME /* target value */
      WHERE USER_ID = :USER_ID -- selected account
    `)).toMatchObject({
      kind: "update", table: "TGT_USERS",
      keyTerms: [{ column: "USER_ID", bindName: "USER_ID" }],
      assignedColumns: ["DISPLAY_NAME"],
    });
  });

  it("recognizes a direct insert", () => {
    expect(parseRestorableDml(
      "INSERT INTO TGT_USERS (USER_ID, DISPLAY_NAME) VALUES (:USER_ID, :DISPLAY_NAME)",
    )).toMatchObject({
      kind: "insert", table: "TGT_USERS",
      keyTerms: [],
      assignedColumns: ["USER_ID", "DISPLAY_NAME"],
    });
  });

  it("maps update assignments and key predicates to their target columns", () => {
    expect(parseRestorableDml(
      "UPDATE TGT_USERS SET LOGIN_ID = :LOGIN_ID WHERE USER_ID = :USER_ID",
    )?.bindColumns).toEqual([
      { column: "LOGIN_ID", bindName: "LOGIN_ID" },
      { column: "USER_ID", bindName: "USER_ID" },
    ]);
  });

  it("maps insert value binds and generated merge projection binds", () => {
    const merge = "MERGE INTO TGT_USERS target USING (SELECT :USER_ID USER_ID, :LOGIN_ID LOGIN_ID FROM dual) source ON (target.USER_ID = source.USER_ID) WHEN MATCHED THEN UPDATE SET target.LOGIN_ID = source.LOGIN_ID WHEN NOT MATCHED THEN INSERT (USER_ID, LOGIN_ID) VALUES (source.USER_ID, source.LOGIN_ID)";

    expect(parseRestorableDml(
      "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID) VALUES (:USER_ID, :LOGIN_ID)",
    )?.bindColumns).toEqual([
      { column: "USER_ID", bindName: "USER_ID" },
      { column: "LOGIN_ID", bindName: "LOGIN_ID" },
    ]);
    expect(parseRestorableDml(merge)?.bindColumns).toEqual([
      { column: "USER_ID", bindName: "USER_ID" },
      { column: "LOGIN_ID", bindName: "LOGIN_ID" },
    ]);
  });

  it("recognizes the generated USER_ID merge", () => {
    expect(parseRestorableDml(
      "MERGE INTO TGT_USERS target USING (SELECT :USER_ID USER_ID, :DISPLAY_NAME DISPLAY_NAME FROM dual) source ON (target.USER_ID = source.USER_ID) WHEN MATCHED THEN UPDATE SET target.DISPLAY_NAME = source.DISPLAY_NAME WHEN NOT MATCHED THEN INSERT (USER_ID, DISPLAY_NAME) VALUES (source.USER_ID, source.DISPLAY_NAME)",
    )).toMatchObject({
      kind: "upsert", table: "TGT_USERS",
      keyTerms: [{ column: "USER_ID", bindName: "USER_ID" }],
      assignedColumns: ["DISPLAY_NAME", "USER_ID"],
    });
  });

  it("recognizes a different equality key as restorable", () => {
    expect(parseRestorableDml("UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE EMAIL = :EMAIL"))
      .toMatchObject({ keyTerms: [{ column: "EMAIL", bindName: "EMAIL" }] });
  });

  it("extracts all AND keys and their source binds from a generated merge", () => {
    expect(parseRestorableDml(
      "MERGE INTO ACCOUNTS target USING (SELECT :LOGIN_BIND LOGIN_ID, :TENANT_BIND TENANT_ID, :NAME_BIND DISPLAY_NAME FROM dual) source ON (target.LOGIN_ID = source.LOGIN_ID AND target.TENANT_ID = source.TENANT_ID) WHEN MATCHED THEN UPDATE SET target.DISPLAY_NAME = source.DISPLAY_NAME WHEN NOT MATCHED THEN INSERT (LOGIN_ID, TENANT_ID, DISPLAY_NAME) VALUES (source.LOGIN_ID, source.TENANT_ID, source.DISPLAY_NAME)",
    )).toMatchObject({
      kind: "upsert", table: "ACCOUNTS",
      keyTerms: [
        { column: "LOGIN_ID", bindName: "LOGIN_BIND" },
        { column: "TENANT_ID", bindName: "TENANT_BIND" },
      ],
      assignedColumns: ["DISPLAY_NAME", "LOGIN_ID", "TENANT_ID"],
    });
  });

  it("recognizes Korean quoted identifiers with a Korean bind", () => {
    expect(parseRestorableDml(
      'UPDATE "사용자" SET "표시 이름" = :표시이름 WHERE "사용자 ID" = :사용자ID',
    )).toMatchObject({
      kind: "update", table: '"사용자"',
      keyTerms: [{ column: '"사용자 ID"', bindName: "사용자ID" }],
      assignedColumns: ['"표시 이름"'],
    });
  });
});
