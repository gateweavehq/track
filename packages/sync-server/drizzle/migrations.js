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
	},
};
