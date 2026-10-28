import type { RejectReason } from "@gateweave/track-protocol";

/** A write the workspace refuses. Thrown inside a transaction, it rolls the whole write back. */
export class MutationRejected extends Error {
	constructor(
		readonly reason: RejectReason,
		message: string,
	) {
		super(message);
		this.name = "MutationRejected";
	}
}
