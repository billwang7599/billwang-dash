import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
    test: {
        poolOptions: {
            workers: {
                wrangler: { configPath: "./wrangler.jsonc" },
                // The AI binding is remote-only. Tests pass a fake model to runAgent
                // rather than spending neurons or needing `wrangler login` in CI.
                remoteBindings: false,
                miniflare: {
                    bindings: {
                        // Blank so getUser() takes the DEV_USER path. Verifying a real
                        // Access JWT in tests would mean either reaching the live JWKS
                        // endpoint or minting our own keys; the verification itself is
                        // covered directly in test/auth.test.ts instead.
                        ACCESS_TEAM_DOMAIN: "",
                        ACCESS_AUD: "",
                        DEV_USER: "test-user@example.com",
                        ADMIN_EMAILS: "test-user@example.com",
                        ADMIN_GROUPS: "",
                    },
                },
            },
        },
    },
});
