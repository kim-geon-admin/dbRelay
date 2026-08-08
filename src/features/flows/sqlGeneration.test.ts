import { expect, test } from "vitest";
import { generateTargetSql } from "./sqlGeneration";

test("generates an insert statement from a single-table source query", () => {
  expect(generateTargetSql("insert", "SELECT customer_id AS ID, name, email FROM customers")).toBe(
    "INSERT INTO customers (ID, name, email)\nVALUES (:ID, :name, :email)",
  );
});

test("generates an update example that uses the first source column as the key", () => {
  expect(generateTargetSql("update", "SELECT customer_id AS ID, name, email FROM customers")).toBe(
    "-- Review the WHERE clause and use the target table primary key.\nUPDATE customers\nSET\n  name = :name,\n  email = :email\nWHERE ID = :ID",
  );
});
