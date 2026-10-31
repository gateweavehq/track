import { type PointerEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { BurnUpDay } from "#/lib/cycles";
import { formatShortDay } from "#/lib/dates";

const HEIGHT = 168;
const PAD = { top: 10, right: 14, bottom: 22, left: 30 };

/**
 * A cycle's burn-up: the issues in it (scope) and those done, day by day, across the cycle's
 * whole length, so the days still to come show as room on the right. Hovering a day reads out
 * both numbers; a table holds them for screen readers.
 */
export function BurnUpChart({
	days,
	length,
	endsOn,
}: {
	days: BurnUpDay[];
	/** The cycle's length in days. */
	length: number;
	/** Its last day. */
	endsOn: string;
}) {
	const box = useRef<HTMLDivElement>(null);
	const width = useWidth(box);
	const [hover, setHover] = useState<number | null>(null);
	const last = days.at(-1);

	const top = axisTop(Math.max(0, ...days.map((day) => day.scope)));
	const plotWidth = Math.max(0, width - PAD.left - PAD.right);
	const plotHeight = HEIGHT - PAD.top - PAD.bottom;
	const x = (index: number) => PAD.left + (length > 1 ? (index / (length - 1)) * plotWidth : 0);
	const y = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
	const path = (key: "scope" | "done") =>
		days.map((day, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(day[key])}`).join("");
	const area = `${path("done")}L${x(days.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
	const shown = hover === null ? undefined : days[hover];

	function onPointerMove(event: PointerEvent<SVGSVGElement>) {
		if (plotWidth === 0 || days.length === 0) return;
		const offset = event.clientX - event.currentTarget.getBoundingClientRect().left - PAD.left;
		const index = Math.round((offset / plotWidth) * (length - 1));
		setHover(Math.min(days.length - 1, Math.max(0, index)));
	}

	return (
		<figure className="space-y-2">
			<figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<span className="font-medium text-foreground">Burn-up</span>
				<LegendKey className="bg-chart-2" label="Scope" />
				<LegendKey className="bg-chart-1" label="Done" />
			</figcaption>
			<div ref={box} className="relative">
				{width > 0 && (
					<svg
						width={width}
						height={HEIGHT}
						role="img"
						aria-label={
							last
								? `Burn-up: ${last.done} of ${last.scope} issues done as of ${formatShortDay(last.day)}`
								: "Burn-up"
						}
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
						<path d={area} className="fill-chart-1 opacity-10" />
						<path
							d={path("scope")}
							fill="none"
							strokeWidth={2}
							strokeLinejoin="round"
							strokeLinecap="round"
							className="stroke-chart-2"
						/>
						<path
							d={path("done")}
							fill="none"
							strokeWidth={2}
							strokeLinejoin="round"
							strokeLinecap="round"
							className="stroke-chart-1"
						/>
						{shown && hover !== null && (
							<line
								x1={x(hover)}
								x2={x(hover)}
								y1={PAD.top}
								y2={PAD.top + plotHeight}
								className="stroke-muted-foreground"
								strokeWidth={1}
							/>
						)}
						{/* The latest day, or the hovered one, marked on both lines. */}
						{(shown ?? last) && (
							<>
								<Marker
									cx={x(hover ?? days.length - 1)}
									cy={y((shown ?? last)?.scope ?? 0)}
									className="fill-chart-2"
								/>
								<Marker
									cx={x(hover ?? days.length - 1)}
									cy={y((shown ?? last)?.done ?? 0)}
									className="fill-chart-1"
								/>
							</>
						)}
						{days[0] && (
							<text
								x={PAD.left}
								y={HEIGHT - 6}
								className="fill-muted-foreground text-[10px]"
								textAnchor="start"
							>
								{formatShortDay(days[0].day)}
							</text>
						)}
						<text
							x={x(length - 1)}
							y={HEIGHT - 6}
							className="fill-muted-foreground text-[10px]"
							textAnchor="end"
						>
							{formatShortDay(endsOn)}
						</text>
					</svg>
				)}
				{shown && hover !== null && (
					<div
						aria-hidden
						className="pointer-events-none absolute top-0 z-10 min-w-28 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
						style={{
							left: Math.min(Math.max(0, x(hover) + 8), Math.max(0, width - 120)),
						}}
					>
						<p className="mb-1 font-medium">{formatShortDay(shown.day)}</p>
						<p className="flex items-center gap-2">
							<span className="size-2 rounded-full bg-chart-2" />
							Scope
							<span className="ml-auto tabular-nums">{shown.scope}</span>
						</p>
						<p className="flex items-center gap-2">
							<span className="size-2 rounded-full bg-chart-1" />
							Done
							<span className="ml-auto tabular-nums">{shown.done}</span>
						</p>
					</div>
				)}
			</div>
			<table className="sr-only">
				<caption>Burn-up by day</caption>
				<thead>
					<tr>
						<th scope="col">Day</th>
						<th scope="col">Scope</th>
						<th scope="col">Done</th>
					</tr>
				</thead>
				<tbody>
					{days.map((day) => (
						<tr key={day.day}>
							<th scope="row">{formatShortDay(day.day)}</th>
							<td>{day.scope}</td>
							<td>{day.done}</td>
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}

function LegendKey({ className, label }: { className: string; label: string }) {
	return (
		<span className="flex items-center gap-1.5">
			<span aria-hidden className={`h-0.5 w-3 rounded-full ${className}`} />
			{label}
		</span>
	);
}

/** An end-marker, ringed in the surface color so it stays clear where the lines cross. */
function Marker({ cx, cy, className }: { cx: number; cy: number; className: string }) {
	return (
		<circle cx={cx} cy={cy} r={4} strokeWidth={2} className={`stroke-background ${className}`} />
	);
}

/** The axis's top: a round number at or above `max`, with a whole number halfway. */
function axisTop(max: number): number {
	const half = Math.max(1, max) / 2;
	const magnitude = 10 ** Math.floor(Math.log10(half));
	const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= half);
	return Math.max(2, Math.ceil(step ?? half) * 2);
}

/** The width of an element, kept up to date as it resizes. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = () => setWidth(element.clientWidth);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}
