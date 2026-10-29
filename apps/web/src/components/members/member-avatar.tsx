import type { Member } from "@gateweave/track-protocol";
import { Bot, CircleUserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { cn } from "#/lib/utils";

function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	const first = parts[0]?.[0] ?? "?";
	const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
	return (first + last).toUpperCase();
}

/**
 * A member's picture or initials, or a robot for an agent. Without a member, shows the
 * "unassigned" placeholder.
 */
export function MemberAvatar({
	member,
	className,
}: {
	member: Omit<Member, "proposes"> | undefined;
	className?: string;
}) {
	if (!member) {
		return (
			<CircleUserRound
				aria-label="Unassigned"
				className={cn("size-5 shrink-0 text-muted-foreground", className)}
			/>
		);
	}
	const agent = member.role === "agent";
	return (
		<Avatar
			className={cn("size-5 text-[10px] font-medium", className)}
			title={agent ? `${member.name} (agent)` : member.name}
		>
			{member.image && <AvatarImage src={member.image} alt="" draggable={false} />}
			<AvatarFallback className={cn(member.removedAt !== null && "opacity-60")}>
				{agent ? <Bot aria-hidden className="size-[65%]" /> : initials(member.name)}
			</AvatarFallback>
		</Avatar>
	);
}
