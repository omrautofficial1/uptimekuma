<template>
    <section class="shadow-box big-padding mb-4" aria-live="polite">
        <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="mb-0">{{ $t("siteChecksTitle") }}</h2>
            <button class="btn btn-outline-primary" :disabled="loading" @click="load">{{ $t("Refresh") }}</button>
        </div>
        <p v-if="error" class="text-danger">{{ error }}</p>
        <p v-if="!result">{{ $t("siteChecksPending") }}</p>
        <template v-else>
            <p class="text-secondary">
                {{ result.hostname }} · {{ $t("siteChecksLastChecked") }}:
                <Datetime :value="result.checkedAt" />
            </p>
            <div class="row g-3">
                <div v-for="type in ['DOMAIN', 'SSL']" :key="type" class="col-md-6">
                    <div class="border rounded p-3 h-100">
                        <h3 class="fs-5">
                            {{ type === "SSL" ? $t("siteChecksCertificate") : $t("siteChecksRegistration") }}
                        </h3>
                        <span class="badge" :class="badge(result.checks[type].status)">
                            {{ $t(`siteChecks_${result.checks[type].status}`) }}
                        </span>
                        <p class="fs-3 my-2">
                            {{
                                result.checks[type].daysRemaining == null
                                    ? $t("Unknown")
                                    : $t("days", result.checks[type].daysRemaining)
                            }}
                        </p>
                        <p v-if="result.checks[type].error">{{ result.checks[type].error }}</p>
                        <dl
                            v-for="field in type === 'SSL'
                                ? [
                                      'subject',
                                      'issuer',
                                      'serial',
                                      'validFrom',
                                      'validTo',
                                      'subjectAltName',
                                      'fingerprint',
                                  ]
                                : ['domain', 'registrar', 'updated', 'expiry']"
                            :key="field"
                            class="mb-2"
                        >
                            <template v-if="result.checks[type][field]">
                                <dt>{{ $t(`siteChecks_${field}`) }}</dt>
                                <dd class="text-break">{{ result.checks[type][field] }}</dd>
                            </template>
                        </dl>
                        <details v-if="result.checks[type].raw || result.checks[type].pem">
                            <summary>{{ $t("siteChecksRaw") }}</summary>
                            <pre class="mt-2">{{ result.checks[type].raw || result.checks[type].pem }}</pre>
                        </details>
                    </div>
                </div>
                <div
                    v-for="type in recordTypes"
                    :key="type"
                    :class="['TXT', 'SOA', 'SPF', 'DMARC', 'DKIM'].includes(type) ? 'col-12' : 'col-md-6'"
                >
                    <div class="border rounded p-3 h-100">
                        <h3 class="fs-5">
                            {{ type }}
                            <span class="badge fs-6" :class="badge(result.checks[type].status)">
                                {{ $t(`siteChecks_${result.checks[type].status}`) }}
                            </span>
                        </h3>
                        <p v-if="result.checks[type].error" class="text-break">{{ result.checks[type].error }}</p>
                        <div v-if="rows(type).length" class="table-responsive">
                            <table class="table mb-0">
                                <thead>
                                    <tr>
                                        <th v-for="column in columns(type)" :key="column.key">
                                            {{ $t(column.label) }}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="(row, index) in rows(type)" :key="index">
                                        <td v-for="column in columns(type)" :key="column.key" class="text-break">
                                            {{ row[column.key] ?? "—" }}
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <p v-else>{{ $t("siteChecksNoRecords") }}</p>
                    </div>
                </div>
            </div>
            <p class="form-text mt-3">{{ $t("siteChecksScope") }}</p>
        </template>
    </section>
</template>

<script>
import Datetime from "./Datetime.vue";

export default {
    components: { Datetime },
    props: { monitor: { type: Object, required: true } },
    data() {
        return {
            result: null,
            loading: false,
            error: "",
            timer: null,
            disposed: false,
            recordTypes: ["A", "AAAA", "MX", "NS", "TXT", "SOA", "SPF", "DMARC", "DKIM"],
        };
    },
    mounted() {
        this.load();
        this.timer = setInterval(() => this.load(), 30000);
    },
    beforeUnmount() {
        this.disposed = true;
        clearInterval(this.timer);
    },
    methods: {
        load() {
            if (this.loading) {
                return;
            }
            this.loading = true;
            this.$root
                .getSocket()
                .timeout(10000)
                .emit("getSiteChecks", this.monitor.id, (error, response) => {
                    if (this.disposed) {
                        return;
                    }
                    this.loading = false;
                    this.error = error ? this.$t("siteChecksLoadError") : response.ok ? "" : response.msg;
                    if (!error && response.ok) {
                        this.result = response.result;
                    }
                });
        },
        badge(status) {
            return { up: "bg-success", down: "bg-danger", unknown: "bg-secondary" }[status];
        },
        columns(type) {
            const keys = {
                A: ["address", "ttl"],
                AAAA: ["address", "ttl"],
                MX: ["priority", "exchange"],
                NS: ["value"],
                TXT: ["value"],
                SOA: ["nsname", "hostmaster", "serial", "retry", "refresh", "expire", "minttl"],
                SPF: ["value"],
                DMARC: ["value"],
                DKIM: ["selector", "raw", "status"],
            };
            return keys[type].map((key) => ({ key, label: `siteChecks_${key}` }));
        },
        rows(type) {
            return (this.result.checks[type].records || []).map((record) =>
                typeof record === "string"
                    ? { value: record }
                    : Array.isArray(record)
                      ? { value: record.join("") }
                      : record
            );
        },
    },
};
</script>

<style scoped>
pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 24rem;
}
</style>
