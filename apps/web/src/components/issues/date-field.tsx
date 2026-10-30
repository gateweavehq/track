import { calendarDate } from "@gateweave/track-protocol";
import { X } from "lucide-react";
import type { Ref } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { cn } from "#/lib/utils";

/**
 * A calendar day picked with the browser's own date input, and a button that clears it. `min` and
 * `max` keep a start date before its due date in the picker, though neither is enforced.
 */
export function DateField({
	label,
	value,
	onChange,
	min,
	max,
	overdue = false,
	inputRef,
}: {
	label: string;
	value: string | null;
	onChange: (value: string | null) => void;
	min?: string | null;
	max?: string | null;
	overdue?: boolean;
	inputRef?: Ref<HTMLInputElement>;
}) {
	return (
		<div className="flex items-center gap-1">
			<Input
				ref={inputRef}
				type="date"
				value={value ?? ""}
				min={min ?? undefined}
				max={max ?? undefined}
				onChange={(event) => {
					const next = event.target.value;
					// While a year is being typed the input can hold one the protocol would refuse.
					if (next === "") onChange(null);
					else if (calendarDate.safeParse(next).success && next !== value) onChange(next);
				}}
				aria-label={label}
				className={cn(
					"h-8 min-w-0 flex-1 border-transparent px-2 shadow-none hover:bg-accent focus-visible:bg-transparent",
					!value && "text-muted-foreground",
					overdue && "text-destructive",
				)}
			/>
			{value && (
				<Button
					variant="ghost"
					size="icon"
					className="size-8 shrink-0"
					aria-label={`Clear the ${label.toLowerCase()}`}
					onClick={() => onChange(null)}
				>
					<X />
				</Button>
			)}
		</div>
	);
}
