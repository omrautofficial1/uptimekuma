import { expect, test } from "@playwright/test";
import { login, restoreSqliteSnapshot, screenshot } from "../util-test";

test.describe("Site checks", () => {
    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot(page);
    });

    test("saves optional site checks and restores settings when editing", async ({ page }, testInfo) => {
        await page.goto("./add");
        await login(page);
        await page.getByTestId("monitor-type-select").selectOption("http");
        await page.getByTestId("friendly-name-input").fill("Site checks fixture");
        await page.getByTestId("url-input").fill("http://127.0.0.1:3001");
        await page.getByLabel("Domain Name Expiry Notification").uncheck();
        await page.getByLabel("Site checks", { exact: true }).check();
        await page.locator("#site-check-interval").fill("300");
        await page.locator("#site-check-selectors").fill("selector1, selector2");
        await page.locator("#site-required-MX").check();
        await page.locator("#site-required-DMARC").check();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page).toHaveURL(/\/dashboard\/\d+/);
        await expect(page.getByRole("heading", { name: "Site checks", exact: true })).toBeVisible();
        await expect
            .poll(
                async () => {
                    await page.getByRole("button", { name: "Refresh", exact: true }).click();
                    return page.getByRole("heading", { name: "Domain registration (RDAP)", exact: true }).count();
                },
                { timeout: 20000 }
            )
            .toBe(1);
        await screenshot(testInfo, page);
        await page.getByRole("link", { name: "Edit", exact: true }).click();
        await expect(page.locator("#site-check-interval")).toHaveValue("300");
        await expect(page.locator("#site-check-selectors")).toHaveValue("selector1, selector2");
        await expect(page.locator("#site-required-MX")).toBeChecked();
        await expect(page.locator("#site-required-AAAA")).not.toBeChecked();
        await page.getByLabel("Site checks", { exact: true }).uncheck();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page).toHaveURL(/\/dashboard\/\d+/);
        await expect(page.getByRole("heading", { name: "Site checks", exact: true })).toHaveCount(0);
    });
});
