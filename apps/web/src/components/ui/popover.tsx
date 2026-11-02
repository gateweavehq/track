// Adapted from shadcn/ui (https://ui.shadcn.com): MIT License, Copyright (c) 2023 shadcn.
// The license's full text is in THIRD_PARTY_NOTICES.md at the root of this repository.
import { Popover as PopoverPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "#/lib/utils";

const Popover = PopoverPrimitive.Root;

type Align = React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>["align"];

/**
 * How the popovers inside line up with their triggers when they do not say. A panel at the right
 * edge, such as an issue's properties, lines them up at the end, so they open into the page
 * instead of against the window's edge.
 */
const PopoverAlignContext = React.createContext<Align>("start");
const PopoverAlign = PopoverAlignContext.Provider;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
	React.ComponentRef<typeof PopoverPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align, sideOffset = 4, collisionPadding = 8, onCloseAutoFocus, ...props }, ref) => {
	const contextAlign = React.useContext(PopoverAlignContext);
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Content
				ref={ref}
				align={align ?? contextAlign}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={cn(
					// At least as wide as its trigger, so a menu never looks narrower than what opened it.
					// It animates in but not out: one fading out stays on the page, where it took the
					// click meant for the next picker's trigger, the Escape meant for the page, and
					// showed its options beside the next picker's. Closed, it is gone at once.
					"z-50 w-64 min-w-[var(--radix-popover-trigger-width)] rounded-md border bg-popover text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
					className,
				)}
				{...props}
				onCloseAutoFocus={(event) => {
					onCloseAutoFocus?.(event);
					if (focusMovedOn()) event.preventDefault();
				}}
			/>
		</PopoverPrimitive.Portal>
	);
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

/**
 * Whether focus has gone somewhere since a popover closed, such as into the next one opened.
 * A closed popover hands focus back to its trigger a moment after it leaves the page, so focus
 * left inside it ends up on the page itself; anything else was the person moving on, and taking
 * focus from there would close what they just opened.
 */
function focusMovedOn(): boolean {
	const active = document.activeElement;
	return active !== null && active !== document.body;
}

export { Popover, PopoverAlign, PopoverAnchor, PopoverContent, PopoverTrigger };
