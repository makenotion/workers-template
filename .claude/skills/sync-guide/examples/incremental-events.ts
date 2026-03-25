/**
 * Incremental mode — event-anchor backfill + event-feed delta (Stripe pattern).
 *
 * For APIs that have both a list endpoint (for backfill) and an events/changelog
 * endpoint (for delta). The key insight: before fetching any backfill data,
 * capture the latest event ID as an "anchor." When the backfill completes,
 * start reading events from that anchor.
 *
 * This ensures no events are missed between "backfill started" and "backfill ended,"
 * even if the backfill takes hours.
 *
 * Key points:
 * - Event anchor is captured on the FIRST execute call, before any data is fetched
 * - Backfill uses opaque cursor pagination (starting_after)
 * - Delta reads from an events endpoint using event IDs as cursors
 * - Consistency buffer: skip events younger than 10 seconds (they may not be
 *   fully consistent yet, and since the cursor never resets, skipping = permanent loss)
 * - Events can produce both upserts and deletes
 */

import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

type SyncState =
	| {
			phase: "backfill";
			cursor: string | null;
			eventAnchor: string; // captured before backfill starts
	  }
	| {
			phase: "delta";
			eventCursor: string; // ID of last processed event
	  };

const CONSISTENCY_BUFFER_SECONDS = 10;

worker.sync("customersSync", {
	mode: "incremental",
	primaryKeyProperty: "Customer ID",
	schema: {
		defaultName: "Customers",
		properties: {
			Name: Schema.title(),
			"Customer ID": Schema.richText(),
		},
	},
	execute: async (state: SyncState | undefined) => {
		if (!state || state.phase === "backfill") {
			// Step 1 (first call only): capture the latest event ID as anchor.
			// This marks the position in the event stream at the moment backfill begins.
			// When the backfill completes, delta will start reading from this anchor,
			// ensuring no events are missed during the backfill window.
			let eventAnchor: string;
			if (!state) {
				const anchorResponse = await apiCall("/v1/events?limit=1");
				eventAnchor = anchorResponse.data[0]?.id ?? "";
			} else {
				eventAnchor = state.eventAnchor;
			}

			// Step 2: fetch one page of the full dataset
			const params: Record<string, string> = { limit: "100" };
			if (state?.cursor) {
				params.starting_after = state.cursor;
			}
			const response = await apiCall(
				`/v1/customers?${new URLSearchParams(params)}`,
			);
			const customers: Array<{ id: string; name: string }> = response.data;
			const hasMore = response.has_more;

			if (!hasMore) {
				// Backfill complete — transition to delta, starting from the anchor
				return {
					changes: customers.map(toUpsert),
					hasMore: false,
					nextState: { phase: "delta" as const, eventCursor: eventAnchor },
				};
			}

			const lastId = customers[customers.length - 1].id;
			return {
				changes: customers.map(toUpsert),
				hasMore: true,
				nextState: {
					phase: "backfill" as const,
					cursor: lastId,
					eventAnchor,
				},
			};
		}

		// Delta phase: read events from the changelog endpoint.
		// Events are returned in reverse-chronological order, so we read backwards
		// from the latest event to our cursor position.
		const response = await apiCall(
			`/v1/events?limit=100&ending_before=${state.eventCursor}`,
		);
		const events: Array<{
			id: string;
			type: string;
			created: number;
			data: { object: { id: string; name: string } };
		}> = response.data;

		// Consistency buffer: skip events younger than 10 seconds.
		// The event stream may not be fully consistent for very recent events.
		// Since the cursor never resets, advancing past an inconsistent event
		// means we'd miss the final state of that record permanently.
		const cutoff = Date.now() / 1000 - CONSISTENCY_BUFFER_SECONDS;
		const safeEvents = events.filter((e) => e.created < cutoff);

		// Map events to changes (upserts or deletes)
		const changes = safeEvents.map((event) => {
			if (event.type.endsWith(".deleted")) {
				return { type: "delete" as const, key: event.data.object.id };
			}
			return toUpsert(event.data.object);
		});

		// Only advance cursor if we have safe events to process.
		// If all events are too recent, cursor stays put — we'll re-check next cycle.
		const lastSafe = safeEvents[safeEvents.length - 1];
		const nextCursor = lastSafe?.id ?? state.eventCursor;

		return {
			changes,
			hasMore: response.has_more && safeEvents.length > 0,
			nextState: { phase: "delta" as const, eventCursor: nextCursor },
		};
	},
});

function toUpsert(customer: { id: string; name: string }) {
	return {
		type: "upsert" as const,
		key: customer.id,
		properties: {
			Name: Builder.title(customer.name),
			"Customer ID": Builder.richText(customer.id),
		},
	};
}

async function apiCall(path: string) {
	const response = await fetch(`https://api.stripe.com${path}`, {
		headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
	});
	return response.json();
}
