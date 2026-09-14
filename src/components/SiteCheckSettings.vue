<template>
    <div class="my-4">
        <div class="form-check">
            <input
                id="site-checks-enabled"
                class="form-check-input"
                type="checkbox"
                :checked="config.enabled"
                @change="update('enabled', $event.target.checked)"
            />
            <label for="site-checks-enabled" class="form-check-label">{{ $t("siteChecksTitle") }}</label>
        </div>
        <div v-if="config.enabled" class="mt-3">
            <p class="form-text">{{ $t("siteChecksHelp") }}</p>
            <label for="site-check-interval" class="form-label">{{ $t("siteChecksInterval") }}</label>
            <input
                id="site-check-interval"
                class="form-control mb-3"
                type="number"
                min="300"
                max="604800"
                required
                :value="config.interval"
                @input="update('interval', Number($event.target.value))"
            />
            <label for="site-check-expiry" class="form-label">{{ $t("siteChecksExpiry") }}</label>
            <input
                id="site-check-expiry"
                class="form-control mb-3"
                type="number"
                min="0"
                max="365"
                required
                :value="config.expiryDays"
                @input="update('expiryDays', Number($event.target.value))"
            />
            <label for="site-check-retries" class="form-label">{{ $t("siteChecksRetries") }}</label>
            <input
                id="site-check-retries"
                class="form-control mb-3"
                type="number"
                min="1"
                max="10"
                required
                :value="config.retries"
                @input="update('retries', Number($event.target.value))"
            />
            <label for="site-check-selectors" class="form-label">{{ $t("siteChecksSelectors") }}</label>
            <input
                id="site-check-selectors"
                class="form-control mb-3"
                :value="config.selectors"
                maxlength="1020"
                @input="update('selectors', $event.target.value)"
            />
            <fieldset>
                <legend class="fs-6">{{ $t("siteChecksRequired") }}</legend>
                <div v-for="type in types" :key="type" class="form-check form-check-inline">
                    <input
                        :id="`site-required-${type}`"
                        type="checkbox"
                        class="form-check-input"
                        :checked="config.required.includes(type)"
                        @change="toggle(type, $event.target.checked)"
                    />
                    <label :for="`site-required-${type}`" class="form-check-label">{{ type }}</label>
                </div>
            </fieldset>
            <p class="form-text">{{ $t("siteChecksNotifications") }}</p>
        </div>
    </div>
</template>

<script>
export default {
    props: { modelValue: { type: Object, default: null } },
    emits: ["update:modelValue"],
    data() {
        return { types: ["A", "AAAA", "MX", "NS", "TXT", "SOA", "SPF", "DMARC", "DKIM", "SSL", "DOMAIN"] };
    },
    computed: {
        config() {
            return {
                enabled: false,
                interval: 3600,
                expiryDays: 14,
                retries: 2,
                selectors: "default",
                required: [],
                ...this.modelValue,
            };
        },
    },
    methods: {
        update(key, value) {
            this.$emit("update:modelValue", { ...this.config, [key]: value });
        },
        toggle(type, enabled) {
            this.update(
                "required",
                enabled ? [...this.config.required, type] : this.config.required.filter((item) => item !== type)
            );
        },
    },
};
</script>
