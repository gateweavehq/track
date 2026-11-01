// Adapted from shadcn/ui (https://ui.shadcn.com): MIT License, Copyright (c) 2023 shadcn.
// The license's full text is in THIRD_PARTY_NOTICES.md at the root of this repository.
import { Popover as PopoverPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "#/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
	React.ComponentRef<typeof PopoverPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 4, onCloseAutoFocus, ...props }, ref) => (
	<PopoverPrimitive.Portal>
		<PopoverPrimitive.Content
			ref={ref}
			align={align}
			sideOffset={sideOffset}
			className={cn(
				"z-50 w-64 rounded-md border bg-popover text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
				className,
			)}
			{...props}
			onCloseAutoFocus={(event) => {
				onCloseAutoFocus?.(event);
				if (focusMovedOn()) event.preventDefault();
			}}
		/>
	</PopoverPrimitive.Portal>
));
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

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
