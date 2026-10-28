import m0000 from "./0000_init.sql";
import m0001 from "./0001_labels.sql";
import m0002 from "./0002_comments_activity.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
	},
};
