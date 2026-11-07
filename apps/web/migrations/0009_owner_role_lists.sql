-- Custom SQL migration: the triggers of 0007, with `owner` looked for as a whole item of the role.
--
-- Better Auth keeps several roles as a list, such as `owner,admin`, and that is an owner too. Comparing
-- the whole role told a plain owner beside such a co-owner that they were the only one, and did not
-- count the co-owner as an owner to keep.
DROP TRIGGER `member_delete_keeps_an_owner`;--> statement-breakpoint
CREATE TRIGGER `member_delete_keeps_an_owner`
BEFORE DELETE ON `member`
WHEN instr(',' || old.`role` || ',', ',owner,') > 0
	AND EXISTS (SELECT 1 FROM `organization` WHERE `id` = old.`organization_id`)
	AND (SELECT count(*) FROM `member` WHERE `organization_id` = old.`organization_id` AND instr(',' || `role` || ',', ',owner,') > 0) <= 1
BEGIN
	SELECT RAISE(ABORT, 'a workspace must keep an owner');
END;--> statement-breakpoint
DROP TRIGGER `member_update_keeps_an_owner`;--> statement-breakpoint
CREATE TRIGGER `member_update_keeps_an_owner`
BEFORE UPDATE OF `role` ON `member`
WHEN instr(',' || old.`role` || ',', ',owner,') > 0
	AND instr(',' || new.`role` || ',', ',owner,') = 0
	AND (SELECT count(*) FROM `member` WHERE `organization_id` = old.`organization_id` AND instr(',' || `role` || ',', ',owner,') > 0) <= 1
BEGIN
	SELECT RAISE(ABORT, 'a workspace must keep an owner');
END;
