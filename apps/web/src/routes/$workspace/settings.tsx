import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/$workspace/settings")({
	component: SettingsLayout,
});

const TABS = [
	{ to: "/$workspace/settings/members", label: "Members" },
	{ to: "/$workspace/settings/agents", label: "Agents" },
	{ to: "/$workspace/settings/teams", label: "Teams" },
	{ to: "/$workspace/settings/labels", label: "Labels" },
	{ to: "/$workspace/settings/templates", label: "Templates" },
	{ to: "/$workspace/settings/webhooks", label: "Webhooks" },
	{ to: "/$workspace/settings/github", label: "GitHub" },
	{ to: "/$workspace/settings/import", label: "Import" },
	{ to: "/$workspace/settings/export", label: "Export" },
	{ to: "/$workspace/settings/notifications", label: "Notifications" },
] as const;

function SettingsLayout() {
	const { workspace } = Route.useParams();
	return (
		<div className="h-full overflow-y-auto">
			{/* Tabs across the top on a narrow window, scrolled sideways; a column on the left on a wide one. */}
			<div className="mx-auto max-w-5xl lg:flex lg:gap-10 lg:px-6">
				<header className="sticky top-0 z-10 border-b bg-background lg:top-0 lg:w-44 lg:shrink-0 lg:self-start lg:border-b-0 lg:pt-8">
					<div className="flex h-12 items-center gap-6 px-4 sm:px-6 lg:block lg:h-auto lg:px-0">
						<h1 className="shrink-0 text-sm font-medium lg:mb-3 lg:px-2">Settings</h1>
						<nav
							aria-label="Settings"
							className="flex h-full min-w-0 gap-4 overflow-x-auto [scrollbar-width:none] lg:h-auto lg:flex-col lg:gap-0.5 lg:overflow-visible [&::-webkit-scrollbar]:hidden"
						>
							{TABS.map((tab) => (
								<Link
									key={tab.to}
									to={tab.to}
									params={{ workspace }}
									className="flex h-full shrink-0 items-center border-b-2 text-sm lg:h-auto lg:rounded-md lg:border-b-0 lg:px-2 lg:py-1.5"
									activeProps={{
										className: "border-foreground text-foreground lg:bg-accent lg:font-medium",
									}}
									inactiveProps={{
										className:
											"border-transparent text-muted-foreground hover:text-foreground lg:hover:bg-accent/60",
									}}
								>
									{tab.label}
								</Link>
							))}
						</nav>
					</div>
				</header>
				<div className="min-w-0 max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:px-0">
					<Outlet />
				</div>
			</div>
		</div>
	);
}
