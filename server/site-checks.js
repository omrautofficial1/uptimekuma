const { Resolver } = require("node:dns").promises;
const tls = require("node:tls");
const { isIP } = require("node:net");
const { X509Certificate } = require("node:crypto");
const { parse } = require("tldts");

const TYPES = ["A", "AAAA", "MX", "NS", "TXT", "SOA", "SPF", "DMARC", "DKIM", "SSL", "DOMAIN"];
const SITE_TYPES = ["http", "keyword", "json-query", "real-browser"];

/**
 * Validate and bound user-supplied check settings before persistence.
 * @param {object|string|null} value Settings or stored JSON
 * @throws {Error} Settings are invalid or outside supported limits
 * @returns {object} Normalized settings
 */
function normalizeConfig(value) {
    const config = typeof value === "string" ? JSON.parse(value) : value || {};
    const interval = Number(config.interval ?? 3600);
    const expiryDays = Number(config.expiryDays ?? 14);
    const retries = Number(config.retries ?? 2);
    const selectors = [
        ...new Set(
            String(config.selectors || "default")
                .split(/[,\s]+/)
                .filter(Boolean)
        ),
    ];
    if (
        !Number.isInteger(interval) ||
        interval < 300 ||
        interval > 604800 ||
        !Number.isInteger(expiryDays) ||
        expiryDays < 0 ||
        expiryDays > 365 ||
        !Number.isInteger(retries) ||
        retries < 1 ||
        retries > 10 ||
        selectors.length < 1 ||
        selectors.length > 10 ||
        selectors.some((s) => !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(s) || s.length > 100) ||
        !Array.isArray(config.required ?? []) ||
        (config.required || []).some((t) => !TYPES.includes(t))
    ) {
        throw new Error("Invalid site checks configuration");
    }
    return {
        enabled: config.enabled === true,
        interval,
        expiryDays,
        retries,
        selectors: selectors.join(", "),
        required: [...new Set(config.required || [])],
    };
}

/**
 * Resolve a record set, keeping absence and transport errors visible.
 * @param {Resolver} resolver DNS resolver
 * @param {string} name Query name
 * @param {string} type Record type
 * @returns {Promise<object>} Records and check status
 */
async function dnsRecords(resolver, name, type) {
    try {
        let records;
        if (type === "A" || type === "AAAA") {
            records = await resolver[type === "A" ? "resolve4" : "resolve6"](name, { ttl: true });
        } else {
            records = await resolver.resolve(name, type);
        }
        if (!Array.isArray(records)) {
            records = [records];
        }
        return { status: records.length ? "up" : "down", records };
    } catch (error) {
        return { status: "down", records: [], error: error.code || error.message };
    }
}

/**
 * Join TXT chunks and reject missing or duplicate email policy records.
 * @param {object} result TXT query result
 * @param {string} prefix Policy prefix
 * @param {Function} validate Basic record validator
 * @returns {object} Policy records and status
 */
function emailRecord(result, prefix, validate) {
    if (result.error) {
        return { ...result };
    }
    const records = result.records
        .map((parts) => parts.join(""))
        .filter((s) => s.toLowerCase().startsWith(prefix.toLowerCase()));
    return { records, status: records.length === 1 && validate(records[0]) ? "up" : "down" };
}

/**
 * Inspect the presented certificate while retaining chain and hostname failures.
 * @param {URL} url HTTPS endpoint
 * @returns {Promise<object>} Certificate metadata and validation status
 */
function certificate(url) {
    return new Promise((resolve) => {
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const socket = tls.connect({
            host: hostname,
            port: Number(url.port) || 443,
            servername: isIP(hostname) ? undefined : hostname,
            rejectUnauthorized: false,
        });
        let finished = false;
        const finish = (result) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                socket.destroy();
                resolve(result);
            }
        };
        const timer = setTimeout(() => finish({ status: "down", error: "TLS connection timed out" }), 10000);
        socket.once("error", (error) => finish({ status: "down", error: error.message }));
        socket.once("secureConnect", () => {
            try {
                const peer = socket.getPeerCertificate();
                const cert = new X509Certificate(peer.raw);
                const mismatch = tls.checkServerIdentity(hostname, peer);
                finish({
                    status: socket.authorized && !mismatch ? "up" : "down",
                    error: mismatch?.message || (socket.authorized ? null : String(socket.authorizationError)),
                    subject: cert.subject,
                    issuer: cert.issuer,
                    serial: cert.serialNumber,
                    validFrom: cert.validFrom,
                    validTo: cert.validTo,
                    fingerprint: cert.fingerprint256,
                    subjectAltName: cert.subjectAltName,
                    pem: cert.toString(),
                });
            } catch (error) {
                finish({ status: "down", error: error.message });
            }
        });
    });
}

/**
 * Retrieve registration data from an IANA-listed registry endpoint.
 * @param {string} domain Registrable domain
 * @param {Function} fetcher HTTP transport
 * @returns {Promise<object>} Registration metadata; unavailable data is unknown
 */
async function registration(domain, fetcher = fetch) {
    const bootstrap = require("../extra/rdap-dns.json");
    const service = bootstrap.services.find(([tlds]) => tlds.includes(domain.split(".").pop()));
    if (!service) {
        return { status: "unknown", error: "Registry does not offer RDAP registration data" };
    }
    try {
        const response = await fetcher(`${service[1][0]}domain/${domain}`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
            throw new Error(`Registry returned HTTP ${response.status}`);
        }
        const data = await response.json();
        const expiry = data.events?.find((event) => event.eventAction === "expiration")?.eventDate;
        const updated = data.events?.find((event) => event.eventAction === "last changed")?.eventDate;
        const registrar = data.entities?.find((entity) => entity.roles?.includes("registrar"));
        const name = registrar?.vcardArray?.[1]?.find((field) => field[0] === "fn")?.[3];
        return {
            status: expiry && Number.isFinite(Date.parse(expiry)) ? "up" : "unknown",
            domain,
            expiry,
            updated,
            registrar: name,
            raw: JSON.stringify(data, null, 2),
        };
    } catch (error) {
        return { status: "unknown", domain, error: error.message };
    }
}

/**
 * Collect a site's inventory independently of its HTTP uptime result.
 * @param {string} urlString Monitor URL
 * @param {object} config Validated settings
 * @param {object} dependencies Optional transports and clock for deterministic tests
 * @returns {Promise<object>} Timestamped site snapshot
 */
async function collect(urlString, config, dependencies = {}) {
    const url = new URL(urlString);
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Site checks require an HTTP or HTTPS URL");
    }
    const resolver = dependencies.resolver || new Resolver({ timeout: 5000, tries: 2 });
    const domain = parse(url.hostname).domain;
    const emailDomain = domain || url.hostname;
    const checks = {};
    await Promise.all(
        ["A", "AAAA", "MX", "NS", "TXT", "SOA"].map(async (type) => {
            checks[type] = await dnsRecords(resolver, ["A", "AAAA"].includes(type) ? url.hostname : emailDomain, type);
        })
    );
    checks.SPF = emailRecord(checks.TXT, "v=spf1", (s) => /^v=spf1(?:\s|$)/i.test(s));
    const dmarc = await dnsRecords(resolver, `_dmarc.${emailDomain}`, "TXT");
    checks.DMARC = emailRecord(dmarc, "v=DMARC1;", (s) => /;\s*p\s*=\s*(none|quarantine|reject)\s*(;|$)/i.test(s));
    checks.DKIM = { status: "up", records: [] };
    const dkimRecords = await Promise.all(
        config.selectors
            .split(/[,\s]+/)
            .filter(Boolean)
            .map(async (selector) => {
                const result = await dnsRecords(resolver, `${selector}._domainkey.${emailDomain}`, "TXT");
                // DKIM version is optional; an empty p= explicitly revokes a key.
                const records = result.records.map((parts) => parts.join(""));
                const valid =
                    records.length === 1 && /(?:^|;)\s*p\s*=\s*[A-Za-z0-9+/][A-Za-z0-9+/=\s]*(?:;|$)/.test(records[0]);
                return { selector, raw: records.join("\n"), status: valid ? "up" : "down", error: result.error };
            })
    );
    checks.DKIM.records = dkimRecords;
    checks.DKIM.status = dkimRecords.every((record) => record.status === "up") ? "up" : "down";
    if (!checks.DKIM.records.length) {
        checks.DKIM.status = "unknown";
    }
    checks.SSL =
        url.protocol === "https:"
            ? await (dependencies.certificate || certificate)(url)
            : { status: "unknown", error: "HTTPS is not configured" };
    checks.DOMAIN = domain
        ? await (dependencies.registration || registration)(domain)
        : { status: "unknown", error: "No registrable domain" };
    for (const [type, field] of [
        ["SSL", "validTo"],
        ["DOMAIN", "expiry"],
    ]) {
        const date = Date.parse(checks[type][field]);
        if (Number.isFinite(date)) {
            checks[type].daysRemaining = Math.ceil((date - (dependencies.now ?? Date.now())) / 86400000);
            if (date <= (dependencies.now ?? Date.now()) + config.expiryDays * 86400000) {
                checks[type].status = "down";
                checks[type].error = `Expires within ${config.expiryDays} days`;
            }
        }
    }
    return { checkedAt: new Date().toISOString(), hostname: url.hostname, domain: emailDomain, checks };
}

// A destination advances only after successful delivery, so failed webhooks retry.
/**
 * Deliver per-check transitions with consecutive-failure thresholds.
 * @param {object} snapshot Current checks
 * @param {object} previous Persisted counters and delivery states
 * @param {object} config Validated settings
 * @param {object[]} destinations Configured notification destinations
 * @param {Function} send Notification delivery function
 * @returns {Promise<object>} Updated per-destination state
 */
async function notifyTransitions(snapshot, previous, config, destinations, send) {
    const state = {};
    for (const type of config.required) {
        const status = snapshot.checks[type]?.status || "unknown";
        const old = previous[type] || { failures: 0, delivered: {} };
        const current = { failures: status === "down" ? old.failures + 1 : 0, delivered: { ...old.delivered } };
        state[type] = current;
        if (status === "unknown" || (status === "down" && current.failures < config.retries)) {
            continue;
        }
        for (const destination of destinations) {
            const last = current.delivered[destination.id];
            if (last === status || (!last && status === "up")) {
                continue;
            }
            try {
                await send(destination, type, status, snapshot.checks[type]);
                current.delivered[destination.id] = status;
            } catch {
                // Keep the last delivered state and retry on the next scheduled check.
            }
        }
    }
    return state;
}

module.exports = {
    TYPES,
    SITE_TYPES,
    normalizeConfig,
    collect,
    dnsRecords,
    emailRecord,
    certificate,
    registration,
    notifyTransitions,
};
