const { test } = require("node:test");
const assert = require("node:assert/strict");
const knex = require("knex");
const migration = require("../../db/knex_migrations/2026-09-14-0000-site-checks");

test("site check migration preserves existing monitors and cascades snapshots on deletion", async () => {
    const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
    try {
        await db.raw("PRAGMA foreign_keys = ON");
        await db.schema.createTable("monitor", (table) => {
            table.increments("id");
            table.string("name");
        });
        await db("monitor").insert({ id: 1, name: "Existing site" });
        await migration.up(db);
        assert.equal((await db("monitor").first()).name, "Existing site");
        assert.equal((await db("monitor").first()).site_checks_config, null);
        const state = { A: { failures: 2, delivered: { 1: "down" } } };
        await db("site_check").insert({
            monitor_id: 1,
            result: "{}",
            state: JSON.stringify(state),
            next_check: 1900000000000,
        });
        const snapshot = await db("site_check").first();
        assert.deepEqual(JSON.parse(snapshot.state), state);
        assert.equal(Number(snapshot.next_check), 1900000000000);
        await db("monitor").where({ id: 1 }).delete();
        assert.equal((await db("site_check")).length, 0);
        await migration.down(db);
        assert.equal(await db.schema.hasTable("site_check"), false);
        assert.equal(await db.schema.hasColumn("monitor", "site_checks_config"), false);
    } finally {
        await db.destroy();
    }
});
