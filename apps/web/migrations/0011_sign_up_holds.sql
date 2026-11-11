-- Custom SQL migration: "Who runs this server" in docs/architecture.md.
--
-- A server that has accounts keeps taking new ones, with its oldest account as the owner, so that
-- nobody finds sign-up closed by an upgrade. A new one has no owner yet, and its first account becomes it.
-- Agents have an address of their own (`agents.invalid`) and are not people, so they never own a server.
INSERT INTO `deployment` (`id`, `owner_id`, `sign_up`, `trust_provider`, `updated_at`)
SELECT 1,
	(SELECT `id` FROM `user` WHERE `email` NOT LIKE '%@agents.invalid' ORDER BY `created_at`, `id` LIMIT 1),
	'open',
	0,
	cast(unixepoch('subsecond') * 1000 as integer);--> statement-breakpoint
-- However an account comes to be made, while sign-up is closed it needs a way in: the first account of a
-- server with none, an entry on the owner's list (the address, or its domain with a leading @, which is not
-- a subdomain's), or a pending invitation to a workspace. `auth/deployment.ts` asks the same first, to say so
-- in words; this is what holds if a path that makes accounts ever forgets to ask. A missing row counts as
-- closed. Agents are made by the server for a workspace and have no way to sign in, so they are left out.
--
-- The one thing this cannot see is which sign-in made the account, so while the owner trusts the provider it
-- lets every account through, and the hook in `auth/config.ts` is what holds GitHub and passwords to the list.
CREATE TRIGGER `user_needs_a_way_in`
BEFORE INSERT ON `user`
WHEN COALESCE((SELECT `sign_up` FROM `deployment` WHERE `id` = 1), 'closed') <> 'open'
	AND COALESCE((SELECT `trust_provider` FROM `deployment` WHERE `id` = 1), 0) = 0
	AND new.`email` NOT LIKE '%@agents.invalid'
	AND EXISTS (SELECT 1 FROM `user`)
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
BEGIN
	SELECT RAISE(ABORT, 'sign-up is closed here');
END;--> statement-breakpoint
-- Whoever gets there first owns the server, and D1 runs writes one at a time, so there is only ever one.
CREATE TRIGGER `first_account_owns_deployment`
AFTER INSERT ON `user`
WHEN (SELECT `owner_id` FROM `deployment` WHERE `id` = 1) IS NULL
	AND new.`email` NOT LIKE '%@agents.invalid'
	AND NOT EXISTS (SELECT 1 FROM `user` WHERE `id` <> new.`id`)
BEGIN
	UPDATE `deployment`
	SET `owner_id` = new.`id`, `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `id` = 1;
END;--> statement-breakpoint
-- The owner's account going would empty `deployment.owner_id`, and on a closed server that leaves nobody who
-- can open sign-up or change the list, short of SQL. An open server has nothing to lose by it, which is also
-- how the public demo's cleanup stays free to delete its visitors.
CREATE TRIGGER `deployment_keeps_its_owner`
BEFORE DELETE ON `user`
WHEN old.`id` = (SELECT `owner_id` FROM `deployment` WHERE `id` = 1)
	AND (SELECT `sign_up` FROM `deployment` WHERE `id` = 1) = 'closed'
BEGIN
	SELECT RAISE(ABORT, 'a closed server must keep its owner');
END;--> statement-breakpoint
-- At most 5,000 entries, however they are added.
CREATE TRIGGER `sign_up_allow_has_a_limit`
BEFORE INSERT ON `sign_up_allow`
WHEN (SELECT count(*) FROM `sign_up_allow`) >= 5000
BEGIN
	SELECT RAISE(ABORT, 'the sign-up list is full');
END;
