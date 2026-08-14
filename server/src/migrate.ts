import { readFile } from "node:fs/promises";

import pg from "pg";

import { getConfig } from "./config.js";

const { Client } = pg;
const config = getConfig();
const client = new Client({ connectionString: config.DATABASE_URL });

try {
  const sql = await readFile(
    new URL("../../db/migrations/001_initial.sql", import.meta.url),
    "utf8",
  );
  await client.connect();
  await client.query(sql);
  console.log("Database migration complete");
} finally {
  await client.end();
}
