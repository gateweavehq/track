import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Kbd } from "#/components/ui/kbd";
import { MOD_LABEL } from "#/lib/hotkeys";

const SHORTCUTS: { group: string; items: { keys: string[][]; label: string }[] }[] = [
	{
		group: "General",
		items: [
			{ keys: [[MOD_LABEL, "K"]], label: "Search and run commands" },
			{ keys: [["C"]], label: "Create an issue" },
			{ keys: [["?"]], label: "Show keyboard shortcuts" },
		],
	},
	{
		group: "Issue lists",
		items: [
			{ keys: [["J"], ["↓"]], label: "Next issue" },
			{ keys: [["K"], ["↑"]], label: "Previous issue" },
			{ keys: [["Enter"]], label: "Open the selected issue" },
			{ keys: [["/"]], label: "Filter issues" },
		],
	},
	{
		group: "Issues",
		items: [
			{ keys: [["S"]], label: "Change status" },
			{ keys: [["P"]], label: "Set priority" },
			{ keys: [["A"]], label: "Assign" },
			{ keys: [["Esc"]], label: "Back to the list" },
		],
	},
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>Tangent works without a mouse.</DialogDescription>
				</DialogHeader>
				<div className="space-y-5">
					{SHORTCUTS.map(({ group, items }) => (
						<section key={group} className="space-y-2">
							<h3 className="text-xs font-medium text-muted-foreground">{group}</h3>
							<ul className="space-y-1.5 text-sm">
								{items.map(({ keys, label }) => (
									<li key={label} className="flex items-center justify-between gap-4">
										<span>{label}</span>
										<span className="flex items-center gap-1 text-xs text-muted-foreground">
											{keys.map((combo, index) => (
												<span key={combo.join("+")} className="flex items-center gap-1">
													{index > 0 && "or"}
													{combo.map((key) => (
														<Kbd key={key}>{key}</Kbd>
													))}
												</span>
											))}
										</span>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
