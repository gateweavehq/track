import { useEffect } from "react";

/** Names the browser tab after what is on screen, e.g. "ENG-12 Fix login · Gateweave Track". */
export function useDocumentTitle(title: string | undefined): void {
	useEffect(() => {
		if (title) document.title = `${title} · Gateweave Track`;
	}, [title]);
}
