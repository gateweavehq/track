export function bucketCreateArgs(bucket: { bucket_name: string; jurisdiction?: string }): string[];
export function bucketCreateOutcome(stderr: string): "exists" | "r2-off" | "no-access" | "failed";
