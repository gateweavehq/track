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
	},
};
