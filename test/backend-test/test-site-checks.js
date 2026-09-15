const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeConfig, collect, notifyTransitions, registration } = require("../../server/site-checks");
const http = require("node:http");

const config = normalizeConfig({
    enabled: true,
    required: ["A", "DKIM", "SSL", "DOMAIN"],
    selectors: "selector1, selector2",
});

/**
 * Create a deterministic DNS transport.
 * @param {object} overrides Transport overrides
 * @returns {object} DNS fixture
 */
function resolverFixture(overrides = {}) {
    return {
        resolve4: async () => [{ address: "192.0.2.1", ttl: 300 }],
        resolve6: async () => {
            throw Object.assign(new Error("Missing"), { code: "ENODATA" });
        },
        resolve: async (name, type) => {
            if (type === "TXT") {
                if (name.startsWith("_dmarc.")) {
                    return [["v=DMARC1; p=reject;"]];
                }
                if (name.includes("._domainkey.")) {
                    return [["v=DKIM1; k=rsa; ", "p=YWJjZA==;"]];
                }
                return [["v=spf1 ", "-all"]];
            }
            if (type === "SOA") {
                return { nsname: "ns.example.com", serial: 42, minttl: 600 };
            }
            return [type === "MX" ? { priority: 10, exchange: "mail.example.com" } : "ns.example.com"];
        },
        ...overrides,
    };
}

/**
 * Create deterministic collection dependencies.
 * @param {object} overrides Dependency overrides
 * @returns {object} Collection dependencies
 */
function dependencies(overrides = {}) {
    return {
        resolver: resolverFixture(),
        certificate: async () => ({ status: "up", validTo: "2030-02-01T00:00:00Z", pem: "certificate" }),
        registration: async (domain) => ({ status: "up", domain, expiry: "2030-03-01T00:00:00Z" }),
        now: Date.parse("2030-01-01T00:00:00Z"),
        ...overrides,
    };
}

test("configuration rejects unbounded intervals, invalid selectors and unknown check types", () => {
    for (const invalid of [
        { interval: 1 },
        { interval: Infinity },
        { retries: 0 },
        { expiryDays: -1 },
        { required: ["BOGUS"] },
        { selectors: "a/../../b" },
    ]) {
        assert.throws(() => normalizeConfig(invalid));
    }
    assert.equal(normalizeConfig().enabled, false);
    assert.deepEqual(normalizeConfig({ required: ["A", "A"] }).required, ["A"]);
});

test("collects screenshot record types and uses registrable domain for email records", async () => {
    const result = await collect("https://www.example.co.uk/path", config, dependencies());
    assert.equal(result.domain, "example.co.uk");
    assert.equal(result.checks.A.records[0].ttl, 300);
    assert.equal(result.checks.AAAA.status, "down");
    assert.equal(result.checks.SOA.records[0].serial, 42);
    assert.equal(result.checks.SPF.records[0], "v=spf1 -all");
    assert.equal(result.checks.DMARC.status, "up");
    assert.equal(result.checks.DKIM.records.length, 2);
    assert.equal(result.checks.DKIM.status, "up");
    assert.equal(result.checks.SSL.daysRemaining, 31);
    assert.equal(result.checks.DOMAIN.status, "up");
});

test("expiry threshold, certificate errors, unknown registry data and HTTP are distinct", async () => {
    const result = await collect(
        "https://example.com",
        config,
        dependencies({
            certificate: async () => ({ status: "down", error: "Hostname mismatch", validTo: "2030-02-01T00:00:00Z" }),
            registration: async () => ({ status: "up", expiry: "2030-01-10T00:00:00Z" }),
        })
    );
    assert.equal(result.checks.SSL.status, "down");
    assert.match(result.checks.SSL.error, /Hostname/);
    assert.equal(result.checks.DOMAIN.status, "down");
    const plain = await collect(
        "http://example.com",
        config,
        dependencies({ registration: async () => ({ status: "unknown" }) })
    );
    assert.equal(plain.checks.SSL.status, "unknown");
    assert.equal(plain.checks.DOMAIN.status, "unknown");
    await assert.rejects(collect("ftp://example.com", config, dependencies()));
});

test("rejects duplicate SPF, malformed DMARC and revoked DKIM keys", async () => {
    const resolver = resolverFixture({
        resolve: async (name, type) => {
            if (type !== "TXT") {
                return [];
            }
            if (name.includes("_domainkey")) {
                return [["v=DKIM1; p=;"]];
            }
            if (name.startsWith("_dmarc")) {
                return [["v=DMARC1; p=invalid;"]];
            }
            return [["v=spf1 -all"], ["v=spf1 ~all"]];
        },
    });
    const result = await collect("https://example.com", config, dependencies({ resolver }));
    for (const type of ["SPF", "DMARC", "DKIM"]) {
        assert.equal(result.checks[type].status, "down");
    }
});

test("unsupported or failing RDAP and withheld expiration are unknown", async () => {
    assert.equal((await registration("example.invalid")).status, "unknown");
    assert.equal((await registration("example.com", async () => ({ ok: false, status: 429 }))).status, "unknown");
    assert.equal(
        (await registration("example.com", async () => ({ ok: true, json: async () => ({ events: [] }) }))).status,
        "unknown"
    );
});

test("alerts only selected checks after retries, suppresses duplicates and sends recovery", async () => {
    const sent = [];
    const send = async (...args) => sent.push(args);
    const destinations = [{ id: 1 }];
    const snapshot = { checks: { A: { status: "down" }, AAAA: { status: "down" }, DOMAIN: { status: "unknown" } } };
    let state = await notifyTransitions(snapshot, {}, config, destinations, send);
    assert.equal(sent.length, 0);
    state = await notifyTransitions(snapshot, state, config, destinations, send);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1], "A");
    state = await notifyTransitions(snapshot, JSON.parse(JSON.stringify(state)), config, destinations, send);
    assert.equal(sent.length, 1, "persisted state suppresses duplicates after restart");
    snapshot.checks.A.status = "up";
    await notifyTransitions(snapshot, state, config, destinations, send);
    assert.equal(sent.length, 2);
    assert.equal(sent[1][2], "up");
});

test("failed destinations retry independently and unknown does not generate recovery", async () => {
    const snapshot = { checks: { A: { status: "down" } } };
    const attempts = [];
    const send = async (destination) => {
        attempts.push(destination.id);
        if (destination.id === 2) {
            throw new Error("Unavailable");
        }
    };
    const options = normalizeConfig({ required: ["A"], retries: 1 });
    let state = await notifyTransitions(snapshot, {}, options, [{ id: 1 }, { id: 2 }], send);
    state = await notifyTransitions(snapshot, state, options, [{ id: 1 }, { id: 2 }], send);
    assert.deepEqual(attempts, [1, 2, 2]);
    snapshot.checks.A.status = "unknown";
    state = await notifyTransitions(snapshot, state, options, [{ id: 1 }], send);
    assert.equal(attempts.length, 3);
    snapshot.checks.A.status = "up";
    await notifyTransitions(snapshot, state, options, [{ id: 1 }], send);
    assert.equal(attempts.length, 4);
});

test("webhook provider sends structured site check failure and recovery to HTTP receiver", async (t) => {
    const Webhook = require("../../server/notification-providers/webhook");
    const received = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (data) => (body += data));
        req.on("end", () => {
            received.push(JSON.parse(body));
            res.end("ok");
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const options = normalizeConfig({ required: ["A"], retries: 1 });
    const snapshot = { checks: { A: { status: "down", error: "ENOTFOUND" } } };
    const send = async (destination, type, status, check) =>
        new Webhook().send(
            { webhookURL: `http://127.0.0.1:${server.address().port}`, webhookContentType: "json" },
            `${type} ${status}`,
            { id: 7, name: "Test site" },
            { status: status === "down" ? 0 : 1, siteCheck: { type, ...check } }
        );
    const state = await notifyTransitions(snapshot, {}, options, [{ id: 1 }], send);
    snapshot.checks.A = { status: "up", records: [{ address: "192.0.2.1" }] };
    await notifyTransitions(snapshot, state, options, [{ id: 1 }], send);
    assert.equal(received.length, 2);
    assert.equal(received[0].heartbeat.siteCheck.error, "ENOTFOUND");
    assert.equal(received[1].heartbeat.status, 1);
    assert.equal(received[1].monitor.id, 7);
});

test("TLS inspection retains certificate metadata when chain validation fails", async (t) => {
    const fs = require("node:fs");
    const path = require("node:path");
    const tls = require("node:tls");
    const { certificate } = require("../../server/site-checks");
    const fixture = path.join(__dirname, "../manual-test-radius-tls/certs");
    const server = tls.createServer({
        key: fs.readFileSync(path.join(fixture, "redis.key")),
        cert: fs.readFileSync(path.join(fixture, "redis.crt")),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await certificate(new URL(`https://127.0.0.1:${server.address().port}`));
    assert.equal(result.status, "down");
    assert.ok(result.error);
    assert.match(result.subject, /localhost/);
    assert.match(result.pem, /BEGIN CERTIFICATE/);
    assert.ok(result.serial);
    assert.ok(result.fingerprint);
});
