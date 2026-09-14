import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

// Isolated UI test: no application server, credentials, or external services.
test("site check components configure alerts and render saved inventory on desktop and mobile", async () => {
    const records = {
        A: { status: "up", records: [{ address: "192.0.2.10", ttl: 300 }] },
        AAAA: { status: "down", records: [], error: "ENODATA" },
        MX: { status: "up", records: [{ priority: 10, exchange: "mail.example.com" }] },
        NS: { status: "up", records: ["ns1.example.com"] },
        TXT: {
            status: "up",
            records: [["v=spf1 include:example.com -all"], ["<script>window.injected=true</script>"]],
        },
        SOA: {
            status: "up",
            records: [
                {
                    nsname: "ns1.example.com",
                    hostmaster: "admin.example.com",
                    serial: 12,
                    retry: 600,
                    refresh: 3600,
                    expire: 86400,
                    minttl: 300,
                },
            ],
        },
        SPF: { status: "up", records: ["v=spf1 include:example.com -all"] },
        DMARC: { status: "up", records: ["v=DMARC1; p=none;"] },
        DKIM: { status: "up", records: [{ selector: "default", status: "up", raw: "v=DKIM1; p=" + "A".repeat(300) }] },
        SSL: {
            status: "up",
            daysRemaining: 47,
            subject: "CN=example.com",
            issuer: "Test CA",
            serial: "1234",
            validTo: "2030-03-01",
            pem: "-----BEGIN CERTIFICATE-----\nTEST FIXTURE\n-----END CERTIFICATE-----",
        },
        DOMAIN: {
            status: "unknown",
            domain: "example.com",
            registrar: "Example Registrar",
            raw: '{"objectClassName":"domain"}',
        },
    };
    const snapshot = { hostname: "www.example.com", checkedAt: "2030-01-01T12:00:00Z", checks: records };
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div>
    <script type="module">
    import { createApp } from 'vue';
    import { createI18n } from 'vue-i18n';
    import en from '/src/lang/en.json';
    import SiteChecks from '/src/components/SiteChecks.vue';
    import SiteCheckSettings from '/src/components/SiteCheckSettings.vue';
    import '/node_modules/bootstrap/dist/css/bootstrap.css';
    const snapshot = ${JSON.stringify(snapshot).replaceAll("<", "\\u003c")};
    createApp({
      components: { SiteChecks, SiteCheckSettings },
      data: () => ({ config: null, monitor: { id: 1 } }),
      methods: {
        date: value => value, datetime: value => value,
        getSocket() { return { timeout() { return this; }, emit(event, id, callback) { setTimeout(() => callback(null, { ok: true, result: snapshot }), 10); } }; }
      },
      template: '<main class="container py-4"><SiteCheckSettings v-model="config"/><output id="config">{{ JSON.stringify(config) }}</output><SiteChecks :monitor="monitor"/></main>'
    }).use(createI18n({ legacy: true, locale: 'en', messages: { en } })).mount('#app');
    </script></body></html>`;
    const server = await createServer({
        configFile: false,
        appType: "custom",
        resolve: { alias: { vue: "vue/dist/vue.esm-bundler.js" } },
        optimizeDeps: { noDiscovery: true, include: ["vue", "vue-i18n"] },
        plugins: [vue()],
        server: { host: "127.0.0.1", port: 0 },
    });
    server.middlewares.use((req, res, next) => {
        if (req.url === "/__site-check-test") {
            server.transformIndexHtml(req.url, html).then((result) => {
                res.setHeader("Content-Type", "text/html");
                res.end(result);
            });
        } else {
            next();
        }
    });
    let browser;
    try {
        await server.listen();
        const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
        browser = await chromium.launch({
            executablePath: process.env.SITE_CHECKS_CHROMIUM_PATH || undefined,
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--use-angle=swiftshader"],
        });
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
        page.setDefaultTimeout(15000);
        await page.route("**/*", (route) =>
            route
                .request()
                .url()
                .startsWith(origin + "/")
                ? route.continue()
                : route.abort()
        );
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(origin + "/__site-check-test");
        await page.getByRole("heading", { name: "Domain registration (RDAP)", exact: true }).waitFor();
        await page.getByLabel("Site checks", { exact: true }).check();
        await page.locator("#site-check-interval").fill("300");
        await page.locator("#site-check-selectors").fill("selector1, selector2");
        await page.locator("#site-required-DMARC").check();
        const config = JSON.parse(await page.locator("#config").textContent());
        assert.equal(config.interval, 300);
        assert.deepEqual(config.required, ["DMARC"]);
        assert.equal(config.selectors, "selector1, selector2");
        assert.equal(await page.locator("td", { hasText: "192.0.2.10" }).count(), 1);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await mkdir("private/site-check-ui", { recursive: true });
        await page.screenshot({ path: "private/site-check-ui/desktop.png", fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        // Hide the fixture-only serialized settings output when measuring layout.
        await page.locator("#config").evaluate((element) => (element.style.display = "none"));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.screenshot({ path: "private/site-check-ui/mobile.png", fullPage: true });
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        await server.close();
    }
});
