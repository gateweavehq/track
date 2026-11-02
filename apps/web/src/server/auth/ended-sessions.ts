/**
 * Collects the sessions that end during one auth request, by user, and reports them once the
 * request is over, so revoking ten sessions costs one report per user, not ten.
 *
 * Better Auth runs its session delete hook once per session, one after another, inside the
 * request. Each hook only notes the session here. The request's after hook flushes the batch,
 * and the report runs in the background, so the response does not wait for it. A batch that no
 * after hook flushes (a direct call outside any endpoint, or one that threw) goes out on a timer.
 */
export class EndedSessions {
	readonly #report: (userId: string, sessionIds: string[]) => Promise<void>;
	readonly #runInBackground: (work: Promise<unknown>) => void;
	readonly #batches = new WeakMap<object, Batch>();

	constructor(
		report: (userId: string, sessionIds: string[]) => Promise<void>,
		runInBackground: (work: Promise<unknown>) => void = () => {},
	) {
		this.#report = report;
		this.#runInBackground = runInBackground;
	}

	/** Notes a session that ended during the request `request` stands for (`null`: none). */
	add(request: object | null, userId: string, sessionId: string): void {
		const key = request ?? {};
		let batch = this.#batches.get(key);
		if (!batch) {
			batch = new Batch(this.#report);
			this.#batches.set(key, batch);
			const pending = batch;
			const timer = setTimeout(() => {
				this.#batches.delete(key);
				pending.send();
			}, UNFLUSHED_BATCH_MS);
			pending.onSend = () => clearTimeout(timer);
			this.#runInBackground(pending.sent);
		}
		batch.add(userId, sessionId);
	}

	/** Reports what ended during the request, now that it is over. */
	flush(request: object): void {
		const batch = this.#batches.get(request);
		if (!batch) return;
		this.#batches.delete(request);
		batch.send();
	}
}

/** How long a batch no request flushed waits before it goes out by itself. */
const UNFLUSHED_BATCH_MS = 1_000;

class Batch {
	readonly #report: (userId: string, sessionIds: string[]) => Promise<void>;
	readonly #users = new Map<string, Set<string>>();
	#resolve: () => void = () => {};
	#done = false;
	onSend: () => void = () => {};
	/** Settles once the batch has been reported. Kept alive with `waitUntil` meanwhile. */
	readonly sent = new Promise<void>((resolve) => {
		this.#resolve = resolve;
	});

	constructor(report: (userId: string, sessionIds: string[]) => Promise<void>) {
		this.#report = report;
	}

	add(userId: string, sessionId: string): void {
		const sessions = this.#users.get(userId) ?? new Set();
		sessions.add(sessionId);
		this.#users.set(userId, sessions);
	}

	send(): void {
		if (this.#done) return;
		this.#done = true;
		this.onSend();
		const reports = [...this.#users].map(([userId, sessions]) =>
			this.#report(userId, [...sessions]),
		);
		void Promise.allSettled(reports).then(() => this.#resolve());
	}
}
