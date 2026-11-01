import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import { LabelDot } from "#/components/issues/labels";
import { MemberAvatar } from "#/components/members/member-avatar";
import { axisTop, useWidth } from "#/lib/chart";
import { formatShortDay } from "#/lib/dates";
import type { InsightCount, InsightSearch, Insights } from "#/lib/insights";
import { formatDays, INSIGHT_RANGES, type InsightWeek, UNASSIGNED } from "#/lib/insights";
import { useActiveMembers, useLabels, useLabelsById, useMembersById } from "#/lib/queries";
import { cn } from "#/lib/utils";

/**
 * Insights into a set of issues, a team's or a project's: what was opened and closed week by
 * week, how long work took, and where the open issues are now. `breakdown` is the first way of
 * counting open issues, which depends on the set: by status for a team, by team for a project.
 */
export function InsightsPage({
	trail,
	insights,
	search,
	onSearchChange,
	breakdown,
}: {
	/** The link back to what the insights are of, in the header. */
	trail: ReactNode;
	insights: Insights;
	search: InsightSearch;
	onSearchChange: (patch: Partial<InsightSearch>) => void;
	breakdown: ReactNode;
}) {
	const members = useMembersById();
	const labels = useLabelsById();
	const { cycleTime } = insights;
	const weeks = search.weeks ?? 12;

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				{trail}
				<span className="text-sm text-muted-foreground">/</span>
				<h1 className="text-sm font-medium">Insights</h1>
			</header>
			<div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
				<fieldset className="flex flex-wrap items-center gap-2">
					<legend className="sr-only">What to count</legend>
					<span className="text-sm text-muted-foreground" aria-hidden>
						Last
					</span>
					<div className="inline-flex rounded-md border p-0.5">
						{INSIGHT_RANGES.map((range) => (
							<button
								key={range}
								type="button"
								aria-pressed={range === weeks}
								onClick={() => onSearchChange({ weeks: range })}
								className={cn(
									"rounded px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
									range === weeks && "bg-muted font-medium text-foreground",
								)}
							>
								{range} weeks
							</button>
						))}
					</div>
					<InsightFilters search={search} onSearchChange={onSearchChange} />
				</fieldset>

				<dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<Stat label="Open now" value={insights.open} />
					<Stat label="Created" value={insights.created} />
					<Stat label="Closed" value={insights.closed} />
					<Stat
						label="Median cycle time"
						value={cycleTime.medianDays === null ? "–" : formatDays(cycleTime.medianDays)}
						note={
							cycleTime.issues === 0
								? "No issue went from started to done"
								: `Started to done, ${cycleTime.issues} ${cycleTime.issues === 1 ? "issue" : "issues"}`
						}
					/>
				</dl>

				<section className="rounded-lg border p-4">
					<WeeklyChart weeks={insights.weeks} />
				</section>

				<div className="grid gap-4 lg:grid-cols-3">
					{breakdown}
					<Breakdown
						title="Open by assignee"
						rows={insights.byAssignee}
						rowKey={(id) => id ?? "none"}
						label={(id) => {
							const member = id === null ? undefined : members.get(id);
							return (
								<>
									<MemberAvatar member={member} />
									<span className="truncate">
										{id === null ? "No assignee" : (member?.name ?? "Someone who left")}
									</span>
								</>
							);
						}}
					/>
					<Breakdown
						title="Open by label"
						rows={insights.byLabel}
						rowKey={(id) => id}
						empty="No open issue has a label."
						label={(id) => {
							const label = labels.get(id);
							return (
								<>
									{label && <LabelDot color={label.color} />}
									<span className="truncate">{label?.name ?? "Deleted label"}</span>
								</>
							);
						}}
					/>
				</div>
			</div>
		</div>
	);
}

const SELECT_CLASS =
	"h-8 max-w-48 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Only the issues with a label, or assigned to someone (or no one). */
function InsightFilters({
	search,
	onSearchChange,
}: {
	search: InsightSearch;
	onSearchChange: (patch: Partial<InsightSearch>) => void;
}) {
	const labels = useLabels();
	const members = useActiveMembers();
	const filtered = search.label !== undefined || search.assignee !== undefined;
	return (
		<>
			<select
				aria-label="Label"
				value={search.label ?? ""}
				onChange={(event) => onSearchChange({ label: event.target.value || undefined })}
				className={SELECT_CLASS}
			>
				<option value="">Any label</option>
				{labels.map((label) => (
					<option key={label.id} value={label.id}>
						{label.name}
					</option>
				))}
			</select>
			<select
				aria-label="Assignee"
				value={search.assignee ?? ""}
				onChange={(event) => onSearchChange({ assignee: event.target.value || undefined })}
				className={SELECT_CLASS}
			>
				<option value="">Anyone</option>
				<option value={UNASSIGNED}>No assignee</option>
				{members.map((member) => (
					<option key={member.id} value={member.id}>
						{member.name}
					</option>
				))}
			</select>
			{filtered && (
				<button
					type="button"
					onClick={() => onSearchChange({ label: undefined, assignee: undefined })}
					className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Clear filters
				</button>
			)}
		</>
	);
}

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
	return (
		<div className="rounded-lg border p-3">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
			{note && <dd className="mt-0.5 text-xs text-muted-foreground">{note}</dd>}
		</div>
	);
}

/** Open issues counted one way, as bars against the largest count. */
export function Breakdown<T>({
	title,
	rows,
	rowKey,
	label,
	empty = "No open issues.",
}: {
	title: string;
	rows: InsightCount<T>[];
	rowKey: (key: T) => string;
	label: (key: T) => ReactNode;
	empty?: string;
}) {
	const max = Math.max(1, ...rows.map((row) => row.count));
	return (
		<section aria-label={title} className="space-y-3 rounded-lg border p-4">
			<h2 className="text-sm font-medium">{title}</h2>
			{rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">{empty}</p>
			) : (
				<ul className="space-y-2">
					{rows.map((row) => (
						<li key={rowKey(row.key)} className="space-y-1 text-sm">
							<div className="flex items-center gap-2">
								<span className="flex min-w-0 flex-1 items-center gap-2">{label(row.key)}</span>
								<span className="shrink-0 tabular-nums text-muted-foreground">{row.count}</span>
							</div>
							<div aria-hidden className="h-1.5 rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-chart-1"
									style={{ width: `${(row.count / max) * 100}%` }}
								/>
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

const HEIGHT = 180;
const PAD = { top: 10, right: 8, bottom: 22, left: 30 };
const SERIES = [
	{ key: "created", label: "Created", className: "fill-chart-1", swatch: "bg-chart-1" },
	{ key: "closed", label: "Closed", className: "fill-chart-2", swatch: "bg-chart-2" },
] as const;

/**
 * Issues created and closed each week, side by side. Hovering a week reads out both numbers; a
 * table holds them for screen readers.
 */
function WeeklyChart({ weeks }: { weeks: InsightWeek[] }) {
	const box = useRef<HTMLDivElement>(null);
	const width = useWidth(box);
	const [hover, setHover] = useState<number | null>(null);

	const top = axisTop(Math.max(0, ...weeks.flatMap((week) => [week.created, week.closed])));
	const plotWidth = Math.max(0, width - PAD.left - PAD.right);
	const plotHeight = HEIGHT - PAD.top - PAD.bottom;
	const slot = weeks.length > 0 ? plotWidth / weeks.length : 0;
	// Two bars a week with a 2px gap between them, and room between the weeks.
	const bar = Math.max(2, Math.min(18, (slot * 0.7 - 2) / 2));
	const y = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
	// Label every week that fits, about 56px apart.
	const every = Math.max(1, Math.ceil(56 / Math.max(1, slot)));
	const shown = hover === null ? undefined : weeks[hover];

	function onPointerMove(event: PointerEvent<SVGSVGElement>) {
		if (slot === 0) return;
		const offset = event.clientX - event.currentTarget.getBoundingClientRect().left - PAD.left;
		setHover(Math.min(weeks.length - 1, Math.max(0, Math.floor(offset / slot))));
	}

	return (
		<figure className="space-y-2">
			<figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<span className="font-medium text-foreground">Created and closed by week</span>
				{SERIES.map((series) => (
					<span key={series.key} className="flex items-center gap-1.5">
						<span aria-hidden className={`size-2 rounded-sm ${series.swatch}`} />
						{series.label}
					</span>
				))}
			</figcaption>
			<div ref={box} className="relative">
				{width > 0 && (
					<svg
						width={width}
						height={HEIGHT}
						role="img"
						aria-label={`Created and closed by week: ${weeks.reduce((sum, week) => sum + week.created, 0)} created and ${weeks.reduce((sum, week) => sum + week.closed, 0)} closed`}
						onPointerMove={onPointerMove}
						onPointerLeave={() => setHover(null)}
						className="block touch-pan-y"
					>
						{[0, top / 2, top].map((tick) => (
							<g key={tick}>
								<line
									x1={PAD.left}
									x2={PAD.left + plotWidth}
									y1={y(tick)}
									y2={y(tick)}
									className="stroke-border"
									strokeWidth={1}
								/>
								<text
									x={PAD.left - 8}
									y={y(tick)}
									textAnchor="end"
									dominantBaseline="middle"
									className="fill-muted-foreground text-[10px] tabular-nums"
								>
									{tick}
								</text>
							</g>
						))}
						{hover !== null && (
							<rect
								x={PAD.left + hover * slot}
								y={PAD.top}
								width={slot}
								height={plotHeight}
								className="fill-muted"
							/>
						)}
						{weeks.map((week, index) => {
							const middle = PAD.left + index * slot + slot / 2;
							return (
								<g key={week.start}>
									{SERIES.map((series, place) => {
										const value = week[series.key];
										if (value === 0) return null;
										const x = place === 0 ? middle - 1 - bar : middle + 1;
										return (
											<path
												key={series.key}
												d={topRounded(x, y(value), bar, y(0) - y(value))}
												className={series.className}
											/>
										);
									})}
									{index % every === (weeks.length - 1) % every && (
										<text
											x={middle}
											y={HEIGHT - 6}
											textAnchor="middle"
											className="fill-muted-foreground text-[10px]"
										>
											{formatShortDay(week.start)}
										</text>
									)}
								</g>
							);
						})}
					</svg>
				)}
				{shown && hover !== null && (
					<div
						aria-hidden
						className="pointer-events-none absolute top-0 z-10 min-w-32 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
						style={{
							left: Math.min(
								Math.max(0, PAD.left + (hover + 1) * slot + 4),
								Math.max(0, width - 136),
							),
						}}
					>
						<p className="mb-1 font-medium">Week of {formatShortDay(shown.start)}</p>
						{SERIES.map((series) => (
							<p key={series.key} className="flex items-center gap-2">
								<span className={`size-2 rounded-sm ${series.swatch}`} />
								{series.label}
								<span className="ml-auto tabular-nums">{shown[series.key]}</span>
							</p>
						))}
					</div>
				)}
			</div>
			<table className="sr-only">
				<caption>Issues created and closed by week</caption>
				<thead>
					<tr>
						<th scope="col">Week of</th>
						<th scope="col">Created</th>
						<th scope="col">Closed</th>
					</tr>
				</thead>
				<tbody>
					{weeks.map((week) => (
						<tr key={week.start}>
							<th scope="row">{formatShortDay(week.start)}</th>
							<td>{week.created}</td>
							<td>{week.closed}</td>
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}

/** A bar standing on the axis, its top corners rounded. */
function topRounded(x: number, y: number, width: number, height: number): string {
	const r = Math.min(4, width / 2, height);
	return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}
