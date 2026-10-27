import { ISSUE_STATUSES, type IssuePriority, type IssueStatus, type Team } from "@tangent/protocol";
import { Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { useWorkspace } from "#/components/workspace/context";
import { useActiveMembers } from "#/lib/queries";
import { PRIORITY_META, PRIORITY_ORDER, PriorityIcon, STATUS_META, StatusIcon } from "./meta";

interface Option<V> {
	value: V;
	label: string;
	icon: ReactNode;
	keywords?: string[];
}

interface PickerProps<V> {
	value: V;
	onChange: (value: V) => void;
	/** The trigger. Must be a single element that accepts a ref, such as a button. */
	children: ReactNode;
	/** Pass both to control the popover, for example to open it from a keyboard shortcut. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

function OptionPicker<V extends string | number | null>({
	options,
	placeholder,
	value,
	onChange,
	children,
	open: controlledOpen,
	onOpenChange,
}: PickerProps<V> & { options: Option<V>[]; placeholder: string }) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const open = controlledOpen ?? uncontrolledOpen;
	const setOpen = onOpenChange ?? setUncontrolledOpen;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent className="w-60 p-0">
				{/* Start on the current value, so Enter keeps it and the arrows move from it. */}
				<Command defaultValue={String(value)} loop vimBindings={false}>
					<CommandInput placeholder={placeholder} />
					<CommandList>
						<CommandEmpty>No matches</CommandEmpty>
						<CommandGroup>
							{options.map((option) => (
								<CommandItem
									key={String(option.value)}
									value={String(option.value)}
									keywords={[option.label, ...(option.keywords ?? [])]}
									onSelect={() => {
										setOpen(false);
										if (option.value !== value) onChange(option.value);
									}}
								>
									{option.icon}
									<span className="truncate">{option.label}</span>
									{option.value === value && <Check className="ml-auto size-4" />}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

const STATUS_OPTIONS: Option<IssueStatus>[] = ISSUE_STATUSES.map((status) => ({
	value: status,
	label: STATUS_META[status].label,
	icon: <StatusIcon status={status} />,
}));

export function StatusPicker(props: PickerProps<IssueStatus>) {
	return <OptionPicker {...props} options={STATUS_OPTIONS} placeholder="Change status…" />;
}

const PRIORITY_OPTIONS: Option<IssuePriority>[] = PRIORITY_ORDER.map((priority) => ({
	value: priority,
	label: PRIORITY_META[priority].label,
	icon: <PriorityIcon priority={priority} />,
}));

export function PriorityPicker(props: PickerProps<IssuePriority>) {
	return <OptionPicker {...props} options={PRIORITY_OPTIONS} placeholder="Set priority…" />;
}

export function AssigneePicker(props: PickerProps<string | null>) {
	const { userId } = useWorkspace();
	const members = useActiveMembers();
	// You first, then everyone else alphabetically, so assigning yourself is one keystroke.
	const sorted = [...members].sort((a, b) => Number(b.id === userId) - Number(a.id === userId));
	const options: Option<string | null>[] = [
		{ value: null, label: "No assignee", icon: <MemberAvatar member={undefined} /> },
		...sorted.map((member) => ({
			value: member.id,
			label: member.id === userId ? `${member.name} (you)` : member.name,
			icon: <MemberAvatar member={member} />,
			keywords: [member.email, ...(member.id === userId ? ["me"] : [])],
		})),
	];
	return <OptionPicker {...props} options={options} placeholder="Assign to…" />;
}

export function TeamPicker({ teams, ...props }: PickerProps<string> & { teams: Team[] }) {
	const options: Option<string>[] = teams.map((team) => ({
		value: team.id,
		label: team.name,
		icon: <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">{team.key}</span>,
		keywords: [team.key],
	}));
	return <OptionPicker {...props} options={options} placeholder="Choose a team…" />;
}
