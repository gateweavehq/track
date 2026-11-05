import m0000 from "./0000_init.sql";
import m0001 from "./0001_labels.sql";
import m0002 from "./0002_comments_activity.sql";
import m0003 from "./0003_issue_search.sql";
import m0004 from "./0004_webhooks.sql";
import m0005 from "./0005_agent_proposals.sql";
import m0006 from "./0006_projects.sql";
import m0007 from "./0007_issue_dates.sql";
import m0008 from "./0008_issue_parent.sql";
import m0009 from "./0009_issue_relations.sql";
import m0010 from "./0010_saved_views.sql";
import m0011 from "./0011_cycles.sql";
import m0012 from "./0012_inbox.sql";
import m0013 from "./0013_subscribe_existing.sql";
import m0014 from "./0014_colossal_spacker_dave.sql";
import m0015 from "./0015_github.sql";
import m0016 from "./0016_notifications.sql";
import m0017 from "./0017_due_reminders.sql";
import m0018 from "./0018_ambiguous_maggott.sql";
import m0019 from "./0019_default_statuses.sql";
import m0020 from "./0020_pretty_phalanx.sql";
import m0021 from "./0021_lethal_marauders.sql";
import m0022 from "./0022_young_kinsey_walden.sql";
import m0023 from "./0023_intake.sql";
import m0024 from "./0024_project_updates.sql";
import m0025 from "./0025_requesters.sql";
import m0026 from "./0026_recurring_templates.sql";
import m0027 from "./0027_requester_replies.sql";
import m0028 from "./0028_github_app.sql";
import m0029 from "./0029_comment_search.sql";
import m0030 from "./0030_intake_followers.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
		m0003,
		m0004,
		m0005,
		m0006,
		m0007,
		m0008,
		m0009,
		m0010,
		m0011,
		m0012,
		m0013,
		m0014,
		m0015,
		m0016,
		m0017,
		m0018,
		m0019,
		m0020,
		m0021,
		m0022,
		m0023,
		m0024,
		m0025,
		m0026,
		m0027,
		m0028,
		m0029,
		m0030,
	},
};
