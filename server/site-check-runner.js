const { R } = require("redbean-node");
const { Notification } = require("./notification");
const { log } = require("../src/util");
const { collect, normalizeConfig, notifyTransitions, SITE_TYPES } = require("./site-checks");
const running = new Set();

/**
 * Run due checks with bounded concurrency and persistent notification state.
 * @param {Monitor} monitor Active monitor instance
 * @returns {Promise<void>} Resolves after storing the snapshot, or when not due
 */
async function runSiteChecks(monitor) {
    const config = normalizeConfig(monitor.site_checks_config);
    if (
        !monitor.active ||
        !config.enabled ||
        !SITE_TYPES.includes(monitor.type) ||
        running.has(monitor.id) ||
        running.size >= 4
    ) {
        return;
    }
    running.add(monitor.id);
    try {
        const target = JSON.stringify([monitor.url, config]);
        let row = await R.findOne("site_check", "monitor_id = ?", [monitor.id]);
        if (row?.target === target && Number(row.next_check) > Date.now()) {
            return;
        }
        const snapshot = await collect(monitor.url, config);
        // Do not send alerts for monitors paused, deleted, or edited during collection.
        const current = await R.findOne("monitor", "id = ?", [monitor.id]);
        if (
            !current?.active ||
            !SITE_TYPES.includes(current.type) ||
            current.url !== monitor.url ||
            JSON.stringify(normalizeConfig(current.site_checks_config)) !== JSON.stringify(config)
        ) {
            return;
        }
        const Monitor = require("./model/monitor");
        const maintained = await Monitor.isUnderMaintenance(monitor.id);
        const previous = row?.target === target ? JSON.parse(row.state || "{}") : {};
        const destinations = maintained ? [] : await Monitor.getNotificationList(current);
        const preload = await Monitor.preparePreloadData([
            { id: current.id, active: current.active, name: current.name },
        ]);
        const state = maintained
            ? previous
            : await notifyTransitions(
                  snapshot,
                  previous,
                  config,
                  destinations,
                  async (destination, type, status, check) => {
                      const msg = `[${current.name}] [${type} ${status === "down" ? "Down" : "Recovered"}] ${check.error || snapshot.hostname}`;
                      try {
                          await Notification.send(JSON.parse(destination.config), msg, current.toJSON(preload, false), {
                              monitorID: current.id,
                              status: status === "down" ? 0 : 1,
                              time: snapshot.checkedAt,
                              msg,
                              siteCheck: { type, ...check },
                          });
                      } catch (error) {
                          log.error("site-checks", `Notification ${destination.id} failed: ${error.message}`);
                          throw error;
                      }
                  }
              );
        if (!row) {
            row = R.dispense("site_check");
            row.monitor_id = monitor.id;
        }
        row.target = target;
        row.result = JSON.stringify(snapshot);
        row.state = JSON.stringify(state);
        row.next_check = Date.now() + config.interval * 1000;
        await R.store(row);
    } finally {
        running.delete(monitor.id);
    }
}

module.exports = { runSiteChecks };
