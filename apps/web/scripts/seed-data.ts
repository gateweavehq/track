// Sample data for `pnpm dev:seed`. The data itself lives in src/server/demo, where the public
// demo shares it; this keeps the script-side imports (the seed and the perf tests) in one place.
export * from "../src/server/demo/sample";

/** Every sample account shares this published password, which is why seeding only runs locally. */
export const PASSWORD = "track-demo-password";
