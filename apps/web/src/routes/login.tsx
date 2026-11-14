import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { AuthPage } from "#/components/auth-page";
import { LegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient, inAuthorizationFlow } from "#/lib/auth-client";
import type { LegalLinks as LegalLinksType } from "#/lib/legal";
import { safeRedirect } from "#/lib/redirect";
import { getAuthOptions, getSession } from "#/lib/session";
import { signInRefusal } from "#/lib/sign-in-refusal";
import { useOpenDemo } from "#/lib/use-open-demo";

// Loose, so the parameters of an agent's authorization request stay in the URL. The OAuth client
// plugin reads them from there when signing in.
const loginSearch = z.looseObject({
	/** Where to go once signed in, such as the invitation that sent the user here. */
	redirect: z.string().optional().catch(undefined),
	/** Prefills the email field, for example with the address an invitation was sent to. */
	email: z.string().optional().catch(undefined),
	mode: z.enum(["sign-in", "sign-up"]).optional().catch(undefined),
	/** Why a sign-in through GitHub or another provider came back here. */
	error: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
	validateSearch: loginSearch,
	beforeLoad: async ({ search, location }) => {
		// An authorization request can ask a signed-in user to sign in again (`prompt=login`).
		if (inAuthorizationFlow(location.searchStr)) return;
		if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) ?? "/" });
	},
	loader: () => getAuthOptions(),
	component: LoginPage,
});

/** The provider's id in Better Auth. The server's constant is out of the browser's reach. */
const OIDC_PROVIDER = "oidc";

function LoginPage() {
	const options = Route.useLoaderData();
	return options.demo ? <DemoLogin legal={options.legal} /> : <SignInForm />;
}

/** The public demo has no accounts to sign in to: each visitor gets a private sandbox. */
function DemoLogin({ legal }: { legal: LegalLinksType | undefined }) {
	const open = useOpenDemo();

	return (
		<AuthPage
			legal={legal}
			title="Try Gateweave Track"
			description="Open-source, realtime issue tracking on Cloudflare."
		>
			<p className="text-sm text-muted-foreground">
				You get a private sample workspace with teams, issues and comments. Nobody else can see it,
				and it is deleted a day after you open it. Open it in a second tab to see changes sync live.
			</p>
			<LiveButton className="w-full" onClick={open}>
				Open a demo workspace
			</LiveButton>
		</AuthPage>
	);
}

/**
 * This page's address without why the last attempt came back. A refusal ends in a redirect, so it
 * needs a page to return to, and that has to keep the query: on the way to an agent's authorization,
 * the query is what that authorization carries on from.
 */
function thisPage() {
	const query = new URLSearchParams(window.location.search);
	query.delete("error");
	query.delete("error_description");
	const rest = query.toString();
	return `/login${rest && `?${rest}`}`;
}

/** "Continue with …": sends someone to GitHub or the configured provider, and back to `next`. */
function ProviderButton({
	provider,
	label,
	next,
	onFailure,
}: {
	provider: "github" | typeof OIDC_PROVIDER;
	label: string;
	next: string;
	onFailure: (message: string | null) => void;
}) {
	const [pending, setPending] = useState(false);

	async function onClick() {
		setPending(true);
		onFailure(null);
		const result = await authClient.signIn.social({
			provider,
			callbackURL: next,
			errorCallbackURL: thisPage(),
		});
		if (result.error) {
			// Track finds out what a provider offers only now, and cannot tell it if the provider is down.
			onFailure(
				result.error.code === "PROVIDER_NOT_FOUND"
					? `We could not reach ${label}. Try again, or use your password.`
					: (result.error.message ?? "Something went wrong"),
			);
		}
		// Going back from the provider can bring this page back as it was, so it must not stay disabled.
		setPending(false);
	}

	return (
		<LiveButton variant="outline" className="w-full" disabled={pending} onClick={onClick}>
			{`Continue with ${label}`}
		</LiveButton>
	);
}

function SignInForm() {
	const options = Route.useLoaderData();
	const search = Route.useSearch();
	const next = safeRedirect(search.redirect) ?? "/";
	const router = useRouter();
	const [mode, setMode] = useState<"sign-in" | "sign-up">(search.mode ?? "sign-in");
	const [error, setError] = useState(() => signInRefusal(search.error));
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const email = String(form.get("email"));
		const password = String(form.get("password"));
		setPending(true);
		setError(null);
		const result =
			mode === "sign-in"
				? await authClient.signIn.email({ email, password })
				: await authClient.signUp.email({
						email,
						password,
						name: String(form.get("name")),
						// Where the verification email brings them back to, such as an invitation.
						callbackURL: next,
					});
		if (result.error) {
			setPending(false);
			setError(result.error.message ?? "Something went wrong");
			return;
		}
		if (mode === "sign-up" && options.email) {
			toast.success("Check your email", {
				description: `We sent a link to verify ${email}.`,
			});
		}
		// The auth client is already on its way back to the agent's authorization.
		if (inAuthorizationFlow(window.location.search)) return;
		setPending(false);
		await router.invalidate();
		await router.navigate({ href: next });
	}

	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1.5 text-center">
					<h1 className="text-xl font-semibold tracking-tight">
						{mode === "sign-in" ? "Sign in to Gateweave Track" : "Create your account"}
					</h1>
					<p className="text-sm text-muted-foreground">Open-source, realtime issue tracking.</p>
				</div>

				{options.signUpClosed && (
					<div
						role="note"
						aria-label="Sign-up is closed"
						className="space-y-1 rounded-lg border p-3 text-center text-sm text-muted-foreground"
					>
						<p>This server takes new accounts by invitation. Ask whoever runs it to invite you.</p>
						{options.askForAccess && (
							<p>
								<a
									href={options.askForAccess}
									target="_blank"
									rel="noreferrer"
									className="font-medium text-foreground underline underline-offset-4"
								>
									Ask for access
								</a>
							</p>
						)}
					</div>
				)}

				{(options.oidc || options.github) && (
					<>
						{options.oidc && (
							<ProviderButton
								provider={OIDC_PROVIDER}
								label={options.oidc}
								next={next}
								onFailure={setError}
							/>
						)}
						{options.github && (
							<ProviderButton provider="github" label="GitHub" next={next} onFailure={setError} />
						)}
						<div className="flex items-center gap-3 text-xs text-muted-foreground">
							<span className="h-px flex-1 bg-border" />
							or
							<span className="h-px flex-1 bg-border" />
						</div>
					</>
				)}

				<form onSubmit={onSubmit} className="space-y-4">
					{mode === "sign-up" && (
						<div className="space-y-2">
							<Label htmlFor="name">Name</Label>
							<Input id="name" name="name" autoComplete="name" maxLength={100} required />
						</div>
					)}
					<div className="space-y-2">
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="email"
							defaultValue={search.email}
							required
						/>
					</div>
					<div className="space-y-2">
						<div className="flex items-baseline justify-between">
							<Label htmlFor="password">Password</Label>
							{mode === "sign-in" && options.email && (
								<Link
									to="/forgot-password"
									search={{ email: search.email }}
									className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>
									Forgot password?
								</Link>
							)}
						</div>
						<Input
							id="password"
							name="password"
							type="password"
							minLength={8}
							autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<LiveButton type="submit" className="w-full" disabled={pending}>
						{mode === "sign-in" ? "Sign in" : "Create account"}
					</LiveButton>
				</form>

				<p className="text-center text-sm text-muted-foreground">
					{mode === "sign-in" ? "New to Gateweave Track? " : "Already have an account? "}
					<button
						type="button"
						className="font-medium text-foreground underline-offset-4 hover:underline"
						onClick={() => {
							setMode(mode === "sign-in" ? "sign-up" : "sign-in");
							setError(null);
						}}
					>
						{mode === "sign-in" ? "Create an account" : "Sign in"}
					</button>
				</p>

				<LegalLinks links={options.legal} agreeing />
			</div>
		</main>
	);
}
