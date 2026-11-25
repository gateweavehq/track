-- A scoped attempt's run signal carries its repository from now on (0039). Attempts claimed before
-- that get theirs from their registration, which a report cannot change, so the Runs page can
-- filter them too. Every other signal keeps none.
UPDATE `signals`
SET `repository` = (
	SELECT `work_run_requests`.`repository`
	FROM `work_run_attempts`
	JOIN `work_run_requests` ON `work_run_requests`.`id` = `work_run_attempts`.`request_id`
	WHERE `work_run_attempts`.`id` = `signals`.`id`
)
WHERE `kind` = 'run' AND `id` IN (SELECT `id` FROM `work_run_attempts`);
