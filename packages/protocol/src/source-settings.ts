import { z } from "zod";
import { sourceSettingsSchema } from "./sources";

const id = z.string().min(1).max(64);
const existing = z.object({ id });
const input = sourceSettingsSchema.omit({ linkOrigins: true });

export const sourceAction = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("create"), input: sourceSettingsSchema }),
	existing.extend({ kind: z.literal("update"), input }).strict(),
	existing.extend({ kind: z.literal("pause"), paused: z.boolean() }).strict(),
	existing.extend({ kind: z.literal("assign"), assigneeId: id.nullable() }).strict(),
	existing.extend({ kind: z.literal("delete") }).strict(),
	existing.extend({ kind: z.literal("makeKey") }).strict(),
	existing.extend({ kind: z.literal("revokeKey"), keyId: id }).strict(),
]);
export type SourceAction = z.input<typeof sourceAction>;
