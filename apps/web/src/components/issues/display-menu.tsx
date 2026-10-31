import {
	compactDisplay,
	GROUP_BYS,
	ISSUE_PROPERTIES,
	type IssueDisplay,
	ORDER_BYS,
} from "@gateweave/track-protocol";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	type DisplayUpdate,
	GROUP_BY_LABELS,
	groupByOf,
	hasDisplay,
	LIST_ONLY_PROPERTIES,
	ORDER_BY_LABELS,
	orderByOf,
	PROPERTY_LABELS,
	shownProperties,
	toggleProperty,
} from "#/lib/display";

/**
 * How a list or a board groups, orders and shows its issues (see `IssueDisplay`): a menu beside
 * the filters. The options only reshape the page; saving them is up to the view or the link.
 */
export function DisplayMenu({
	display,
	onChange,
	layout,
}: {
	display: IssueDisplay;
	onChange: (update: DisplayUpdate) => void;
	layout: "list" | "board";
}) {
	const properties = shownProperties(display);
	const changed = hasDisplay(display);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className="h-8 gap-1.5 px-2"
					aria-label={changed ? "Display options (changed)" : "Display options"}
				>
					<SlidersHorizontal className="size-3.5" />
					<span className="hidden sm:inline">Display</span>
					{changed && <span aria-hidden className="size-1.5 rounded-full bg-primary" />}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<DropdownMenuLabel>Group by</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={groupByOf(display)}
					onValueChange={(value) => {
						const groupBy = GROUP_BYS.find((option) => option === value);
						if (groupBy) onChange((current) => compactDisplay({ ...current, groupBy }));
					}}
				>
					{GROUP_BYS.map((option) => (
						<DropdownMenuRadioItem key={option} value={option}>
							{GROUP_BY_LABELS[option]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuLabel>Order by</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={orderByOf(display)}
					onValueChange={(value) => {
						const orderBy = ORDER_BYS.find((option) => option === value);
						if (orderBy) onChange((current) => compactDisplay({ ...current, orderBy }));
					}}
				>
					{ORDER_BYS.map((option) => (
						<DropdownMenuRadioItem key={option} value={option}>
							{ORDER_BY_LABELS[option]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuLabel>Show on {layout === "board" ? "cards" : "rows"}</DropdownMenuLabel>
				{ISSUE_PROPERTIES.filter(
					(property) => layout === "list" || !LIST_ONLY_PROPERTIES.includes(property),
				).map((property) => (
					<DropdownMenuCheckboxItem
						key={property}
						checked={properties.has(property)}
						// Keep the menu open, so several properties can be changed at once.
						onSelect={(event) => event.preventDefault()}
						onCheckedChange={() => onChange((current) => toggleProperty(current, property))}
					>
						{PROPERTY_LABELS[property]}
					</DropdownMenuCheckboxItem>
				))}
				{changed && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => onChange(() => ({}))}>Reset display</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
