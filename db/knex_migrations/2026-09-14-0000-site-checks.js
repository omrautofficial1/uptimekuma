exports.up = async function (knex) {
    await knex.schema.alterTable("monitor", (table) => {
        table.text("site_checks_config");
    });
    await knex.schema.createTable("site_check", (table) => {
        table.increments("id");
        table
            .integer("monitor_id")
            .unsigned()
            .notNullable()
            .unique()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE");
        table.text("result", "longtext");
        table.text("state", "longtext");
        table.text("target");
        table.bigInteger("next_check").defaultTo(0);
    });
};
exports.down = async function (knex) {
    await knex.schema.dropTable("site_check");
    await knex.schema.alterTable("monitor", (table) => table.dropColumn("site_checks_config"));
};
