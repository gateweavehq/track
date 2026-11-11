-- Custom SQL migration: "Who runs this server" in docs/architecture.md.
--
-- Trusting the provider no longer lets every account through. The sign-up hook writes a pass for the
-- address, good for a minute, just before an account is made through the provider, and while the owner
-- trusts it the trigger lets an insert through only for an address with a pass. Agents are not people, so
-- they no longer count as the accounts a server has.
DROP TRIGGER `user_needs_a_way_in`;--> statement-breakpoint
CREATE TRIGGER `user_needs_a_way_in`
BEFORE INSERT ON `user`
WHEN COALESCE((SELECT `sign_up` FROM `deployment` WHERE `id` = 1), 'closed') <> 'open'
	AND new.`email` NOT LIKE '%@agents.invalid'
	AND EXISTS (SELECT 1 FROM `user` WHERE `email` NOT LIKE '%@agents.invalid')
	AND NOT EXISTS (
		SELECT 1 FROM `sign_up_allow`
		WHERE `entry` = lower(new.`email`)
			OR `entry` = '@' || substr(lower(new.`email`), instr(lower(new.`email`), '@') + 1)
	)
	AND NOT EXISTS (
		SELECT 1 FROM `invitation`
		WHERE `email` = lower(new.`email`)
			AND `status` = 'pending'
			AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
	)
	AND NOT (
		COALESCE((SELECT `trust_provider` FROM `deployment` WHERE `id` = 1), 0) = 1
		AND EXISTS (
			SELECT 1 FROM `sign_up_pass`
			WHERE `email` = lower(new.`email`)
				AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'sign-up is closed here');
END;--> statement-breakpoint
-- A server is never left without an owner. With no owner, the next account to be made is it, as on an
-- empty server.
DROP TRIGGER `first_account_owns_deployment`;--> statement-breakpoint
CREATE TRIGGER `first_account_owns_deployment`
AFTER INSERT ON `user`
WHEN (SELECT `owner_id` FROM `deployment` WHERE `id` = 1) IS NULL
	AND new.`email` NOT LIKE '%@agents.invalid'
	AND NOT EXISTS (
		SELECT 1 FROM `user` WHERE `id` <> new.`id` AND `email` NOT LIKE '%@agents.invalid'
	)
BEGIN
	UPDATE `deployment`
	SET `owner_id` = new.`id`, `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `id` = 1;
END;--> statement-breakpoint
-- When the owner's account goes while sign-up is open, the earliest account left that is a person takes
-- over, or nobody does if there is none. This runs before the delete, so that it does not depend on when
-- the foreign key empties `owner_id`. While closed, `deployment_keeps_its_owner` refuses the delete.
CREATE TRIGGER `deployment_passes_to_next_owner`
BEFORE DELETE ON `user`
WHEN old.`id` = (SELECT `owner_id` FROM `deployment` WHERE `id` = 1)
	AND (SELECT `sign_up` FROM `deployment` WHERE `id` = 1) = 'open'
BEGIN
	UPDATE `deployment`
	SET `owner_id` = (
			SELECT `id` FROM `user`
			WHERE `id` <> old.`id` AND `email` NOT LIKE '%@agents.invalid'
			ORDER BY `created_at`, `id` LIMIT 1
		),
		`updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `id` = 1;
END;
