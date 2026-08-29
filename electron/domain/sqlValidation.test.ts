import { describe, expect, it } from "vitest";
import { validateSourceStatement, validateTargetStatement } from "./sqlValidation";

describe("SQL lexical validation", () => {
  it("accepts read-only source queries and Oracle write targets", () => {
    expect(() => validateSourceStatement("SELECT id FROM customer")).not.toThrow();
    expect(() => validateSourceStatement(
      "/* report */ WITH c AS (SELECT id FROM customer) SELECT id FROM c",
    )).not.toThrow();
    expect(() => validateTargetStatement(
      "oracle",
      "MERGE INTO customer target USING dual ON (1 = 1) "
        + "WHEN MATCHED THEN UPDATE SET target.id = 1",
    )).not.toThrow();
    expect(() => validateTargetStatement(
      "oracle",
      "INSERT INTO customer (id, email) VALUES (:ID, :EMAIL)",
    )).not.toThrow();
    expect(() => validateTargetStatement(
      "oracle",
      "UPDATE customer SET email = :EMAIL WHERE id = :ID",
    )).not.toThrow();
  });

  it("rejects unsafe statement forms before they reach a connector", () => {
    expect(() => validateSourceStatement("DELETE FROM customer"))
      .toThrow("source SQL must begin with SELECT or WITH");
    expect(() => validateSourceStatement("SELECT id FROM customer; DELETE FROM customer"))
      .toThrow("multiple SQL statements are not supported");
    expect(() => validateTargetStatement("oracle", "TRUNCATE TABLE customer"))
      .toThrow("Oracle target SQL must begin with INSERT, UPDATE, or MERGE");
    expect(() => validateTargetStatement("oracle", "BEGIN DELETE FROM customer; END;"))
      .toThrow("multiple SQL statements are not supported");
  });

  it("rejects prohibited operations even when the first keyword is allowed", () => {
    expect(() => validateSourceStatement("SELECT id FROM customer FOR UPDATE"))
      .toThrow("source SQL must be read-only");
    expect(() => validateTargetStatement("oracle", "UPDATE customer SET id = 1 COMMIT"))
      .toThrow("SQL contains a prohibited administrative, transaction, or PL/SQL statement");
    expect(() => validateSourceStatement("SELECT id FROM customer SET TRANSACTION READ ONLY"))
      .toThrow("SQL contains a prohibited administrative, transaction, or PL/SQL statement");
  });

  it("ignores prohibited keywords and semicolons inside literals and comments", () => {
    expect(() => validateSourceStatement(
      "SELECT 'DELETE; COMMIT' AS note FROM customer -- ROLLBACK\n",
    )).not.toThrow();
    expect(() => validateTargetStatement(
      "oracle",
      "UPDATE customer SET note = 'DROP; DELETE', id = :ID /* COMMIT */",
    )).not.toThrow();
  });

  it("allows only a trailing semicolon after one statement", () => {
    expect(() => validateSourceStatement("SELECT id FROM customer;  \n\t"))
      .not.toThrow();
  });

  it("rejects numeric binds outside literals and comments", () => {
    expect(() => validateTargetStatement(
      "oracle",
      "MERGE INTO customer USING dual ON (id = :1)",
    )).toThrow("numeric bind placeholders are not supported");
    expect(() => validateTargetStatement(
      "oracle",
      "UPDATE customer SET note = ':1' /* :2 */ WHERE id = :ID",
    )).not.toThrow();
  });

  it("rejects unterminated quoted literals and block comments", () => {
    expect(() => validateSourceStatement("SELECT 'unfinished FROM customer"))
      .toThrow("SQL contains an unterminated quoted literal");
    expect(() => validateSourceStatement("SELECT id FROM customer /* unfinished"))
      .toThrow("SQL contains an unterminated block comment");
  });
});
