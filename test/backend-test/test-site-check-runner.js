const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const { R } = require("redbean-node");
const checks = require("../../server/site-checks");
const { Notification } = require("../../server/notification");
const Monitor = require("../../server/model/monitor");
const knex = require("knex");
const migration = require("../../db/knex_migrations/2026-09-14-0000-site-checks");
const { generalSocketHandler } = require("../../server/socket-handlers/general-socket-handler");

test("runner persists delivery state, respects due times and maintenance, and protects cached results", async () => {
    const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
    let status = "down";
    let calls = 0;
    let maintained = false;
    const sent = [];
    mock.method(checks, "collect", async () => {
        calls++;
        return { checkedAt: new Date().toISOString(), hostname: "example.com", checks: { A: { status } } };
    });
    mock.method(Monitor, "isUnderMaintenance", async () => maintained);
    mock.method(Monitor, "getNotificationList", async () => [{ id: 1, config: "{}" }]);
    mock.method(Monitor, "preparePreloadData", async () => ({}));
    mock.method(Monitor.prototype, "toJSON", function () {
        return { id: this.id, name: this.name };
    });
    mock.method(Notification, "send", async (...args) => sent.push(args));
    const { runSiteChecks } = require("../../server/site-check-runner");
    try {
        await db.schema.createTable("monitor", (table) => {
            table.increments("id");
            table.string("user_id");
            table.string("url");
            table.string("type");
            table.string("name");
            table.boolean("active");
        });
        await migration.up(db);
        R.setup(db);
        R.freeze(true);
        R.modelList.monitor = Monitor;
        const config = checks.normalizeConfig({ enabled: true, required: ["A"], retries: 1 });
        await db("monitor").insert({
            id: 1,
            user_id: "owner",
            name: "Site",
            type: "http",
            active: 1,
            url: "https://example.com",
            site_checks_config: JSON.stringify(config),
        });
        const monitor = await R.findOne("monitor", "id = ?", [1]);
        await runSiteChecks(monitor);
        assert.equal(sent.length, 1);
        assert.equal(sent[0][3].siteCheck.type, "A");
        assert.equal((await db("site_check").first()).monitor_id, 1);
        await runSiteChecks(monitor);
        assert.equal(calls, 1, "cached snapshot avoids network checks before due time");
        await db("site_check").update({ next_check: 0 });
        await runSiteChecks(await R.findOne("monitor", "id = ?", [1]));
        assert.equal(sent.length, 1, "reloaded monitor preserves duplicate suppression");
        maintained = true;
        status = "up";
        await db("site_check").update({ next_check: 0 });
        await runSiteChecks(monitor);
        assert.equal(sent.length, 1, "maintenance suppresses recovery delivery");
        maintained = false;
        await db("site_check").update({ next_check: 0 });
        await runSiteChecks(monitor);
        assert.equal(sent.length, 2);
        assert.equal(sent[1][3].status, 1);

        const handlers = {};
        const socket = { session: {}, userID: "other-user", on: (event, handler) => (handlers[event] = handler) };
        generalSocketHandler(socket, {});
        let response;
        await handlers.getSiteChecks(1, (value) => (response = value));
        assert.equal(response.ok, false, "other users cannot read a monitor's inventory");
        socket.userID = "owner";
        await handlers.getSiteChecks(1, (value) => (response = value));
        assert.equal(response.result.checks.A.status, "up");
        socket.session = null;
        await handlers.getSiteChecks(1, (value) => (response = value));
        assert.equal(response.ok, false, "unauthenticated sockets cannot read results");
        socket.session = {};
        await db("monitor").update({ url: "https://changed.example.com" });
        await handlers.getSiteChecks(1, (value) => (response = value));
        assert.equal(response.result, null, "old target data is not presented as current");

        await db("monitor").update({ active: 0 });
        await db("site_check").update({ next_check: 0 });
        await runSiteChecks(await R.findOne("monitor", "id = ?", [1]));
        assert.equal(sent.length, 2, "paused monitors do not notify");
    } finally {
        mock.restoreAll();
        await db.destroy();
        require("../../server/settings").Settings.stopCacheCleaner();
    }
});
