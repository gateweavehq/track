-- A scoped attempt's run signal names its number from now on (0037). Attempts claimed before that
-- get theirs from the attempt row, so the Runs card names them the same way. Every other signal
-- keeps a null number.
UPDATE `signals`
SET `attempt_no` = (
	SELECT `attempt_no` FROM `work_run_attempts` WHERE `work_run_attempts`.`id` = `signals`.`id`
)
WHERE `kind` = 'run' AND `id` IN (SELECT `id` FROM `work_run_attempts`);
