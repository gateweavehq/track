import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Link, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { type ReactNode, useEffect } from "react";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { Notice } from "#/components/workspace/notice";
import { registerServiceWorker } from "#/lib/service-worker";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Gateweave Track" },
			{ name: "description", content: "Open-source, realtime issue tracking." },
			// Matches --background, so an installed app's title bar blends into the page.
			{ name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" },
			{ name: "theme-color", content: "#09090b", media: "(prefers-color-scheme: dark)" },
			{ name: "apple-mobile-web-app-title", content: "Track" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
			{ rel: "manifest", href: "/manifest.webmanifest" },
		],
	}),
	shellComponent: RootDocument,
	notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
	useEffect(registerServiceWorker, []);

	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Toaster />
				{import.meta.env.DEV && (
					<TanStackDevtools
						config={{ position: "bottom-right" }}
						plugins={[{ name: "TanStack Router", render: <TanStackRouterDevtoolsPanel /> }]}
					/>
				)}
				<Scripts />
			</body>
		</html>
	);
}

function NotFound() {
	return (
		<main className="grid min-h-svh place-items-center">
			<Notice
				title="Page not found"
				action={
					<Button asChild variant="outline">
						<Link to="/">Go to Gateweave Track</Link>
					</Button>
				}
			>
				Check the address, or start from your workspaces.
			</Notice>
		</main>
	);
}
