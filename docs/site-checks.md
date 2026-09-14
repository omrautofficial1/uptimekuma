# Site checks

Enable **Site checks** when adding or editing an HTTP(S), keyword, JSON query, or real-browser monitor. Existing monitors remain unchanged until enabled.

The details page shows:

- A/AAAA addresses and TTLs for the website hostname.
- MX, NS, TXT and SOA records for the registrable domain.
- SPF, DMARC and DKIM records for that domain. Enter the DKIM selectors supplied by your email provider; selectors cannot be discovered reliably from a domain alone.
- SSL certificate validity, issuer, subject, names, serial, fingerprint, dates and PEM.
- Domain registration data from RDAP: registrar, update/expiry dates and raw registry response. RDAP supplies the registration information corresponding to the WHOIS panel in the reference screenshots.

The check interval defaults to one hour and has a five-minute minimum. Checks run when the monitor's next uptime heartbeat finds them due. Paused monitors do not collect new results. The Refresh button fetches the latest saved results; it does not force network queries. DNS and registry checks run on the Kuma server, not in the user's browser. The collection uses the server's DNS resolver and direct TLS/RDAP connections; it does not inherit a monitor's HTTP proxy or custom TLS credentials.

## Webhook alerts

1. Under the monitor's **Notifications**, choose **Setup Notification**, select **Webhook**, enter the endpoint and save. Enable that notification on the monitor.
2. Enable **Site checks**, then select the record/check types that should trigger alerts. Leave optional records such as AAAA unchecked when the site does not use them.
3. Set the expiry warning window and the number of consecutive failed checks required. Defaults: 14 days and two checks.
4. Save the monitor.

Selected checks send a failure alert after the configured threshold and one recovery alert when healthy again. Delivery state is saved per notification destination to avoid repeats across checks or restarts. Failed delivery retries on the next scheduled check. Maintenance suppresses alerts. Changing the target or site-check configuration starts a fresh alert baseline.

For the default JSON webhook body, `heartbeat.siteCheck` includes the check `type`, `status`, records/details and error where available. `heartbeat.status` is `0` for failure and `1` for recovery. The top-level `monitor` and `msg` fields follow the existing Webhook format. Custom webhook templates can use `heartbeatJSON.siteCheck` through the existing template interface.

Site checks do not change the HTTP uptime heartbeat, uptime percentage, or public status page. Existing website-down notifications continue separately. Existing certificate/domain expiry notifications also remain available; avoid enabling both expiry alert mechanisms if you only want one alert for the same expiry.

## Interpretation

Missing records, DNS lookup failures, invalid TLS, and dates inside the configured expiry window fail the corresponding check. Unknown or withheld registry expiry data is displayed as **Unknown**, never as an expired domain. HTTP-only sites have unknown SSL status. Unsupported RDAP registries are also unknown.

Email checks validate presence and basic record structure, including duplicate SPF/DMARC records and missing or revoked DKIM keys. They do not test SMTP availability, message delivery, DKIM signatures, recursive SPF lookup limits, or complete policy correctness. The DMARC `none` policy is a valid record. DKIM TXT lookups follow DNS CNAME aliases, and every configured selector must have a nonempty key. Only A/AAAA TTLs are available through the resolver API used here; other TTLs are intentionally not invented.

## Validation

Run on the repository's required Node.js version (26.2.0 or newer):

```sh
node --import=tsx --test test/backend-test/test-site-checks.js test/backend-test/test-site-check-persistence.js test/backend-test/test-site-check-runner.js test/backend-test/test-cert-hostname-match.js
npm run build
node --test test/component-test/site-checks.mjs
CI=1 npx playwright test test/e2e/specs/site-checks.spec.js
```

The tests cover DNS/email parsing, expiry boundaries, unknown data, thresholds, duplicate suppression, recovery, delivery retries, an actual local HTTP webhook receiver, SQLite migration/rollback/cascade, saved runner state, due times, maintenance, paused monitors, socket ownership and stale-target protection. The browser test creates and edits an enabled monitor and checks the resulting details panel.

The isolated component test uses local fixtures and blocks external browser requests. Set `SITE_CHECKS_CHROMIUM_PATH` if using a locally installed Chromium. It checks desktop/mobile rendering, settings updates, refresh and escaping of DNS text.
