/**
 * Incremental mode — bi-modal state machine with backfill-to-delta transition.
 *
 * The full pattern for APIs where backfill and delta use different strategies.
 * Backfill paginates the full dataset using one cursor type; delta tracks
 * changes using a different cursor type (typically a timestamp).
 *
 * This is the Salesforce/HubSpot pattern:
 * - Backfill: keyset pagination on (created_at, id)
 * - Delta: keyset pagination on (updated_at, id) with consistency buffer
 * - Transition: seed delta cursor to backfillStartedAt - 5 minutes
 *
 * Key points:
 * - State is a discriminated union with a `phase` field
 * - backfillStartedAt is captured on the FIRST execute call and carried through
 * - The delta cursor is seeded from backfillStartedAt, NOT from the last backfill record
 * - Consistency buffer (15s) prevents the cursor from advancing past records
 *   that the API hasn't indexed yet — since the cursor never resets, skipping
 *   a record means losing it permanently
 * - Keyset (timestamp + id) prevents skipping records that share a timestamp
 */

import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// Discriminated union: the state shape depends on which phase we're in
type SyncState =
	| {
			phase: "backfill";
			cursorTimestamp: string | null;
			cursorId: string | null;
			backfillStartedAt: string;
	  }
	| {
			phase: "delta";
			cursorTimestamp: string;
			cursorId: string;
	  };

const BATCH_SIZE = 100;
const CONSISTENCY_BUFFER_MS = 15_000; // 15 seconds

worker.sync("contactsSync", {
	mode: "incremental",
	primaryKeyProperty: "Contact ID",
	schema: {
		defaultName: "Contacts",
		properties: {
			Name: Schema.title(),
			"Contact ID": Schema.richText(),
		},
	},
	execute: async (state: SyncState | undefined) => {
		const phase = state?.phase ?? "backfill";

		if (phase === "backfill") {
			// Capture when the backfill started — used to seed the delta cursor later.
			// This is set once on the first execute call and carried through all backfill pages.
			const backfillStartedAt =
				state?.phase === "backfill"
					? state.backfillStartedAt
					: new Date().toISOString();

			// Keyset pagination: WHERE created_at > X OR (created_at = X AND id > Y)
			const params = new URLSearchParams({
				limit: String(BATCH_SIZE),
				order_by: "created_at,id",
			});
			if (state?.cursorTimestamp) {
				params.set("created_after", state.cursorTimestamp);
				params.set("created_after_id", state.cursorId ?? "");
			}

			const response = await fetch(
				`https://api.example.com/contacts?${params}`,
				{ headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } },
			);
			const data = await response.json();
			const records: Array<{
				id: string;
				name: string;
				created_at: string;
			}> = data.contacts;
			const done = records.length < BATCH_SIZE;

			if (done) {
				// Backfill complete — transition to delta.
				// Seed delta cursor to backfillStartedAt - 5 minutes to ensure overlap.
				// This covers records that were modified during the backfill window.
				const overlapTs = new Date(
					new Date(backfillStartedAt).getTime() - 5 * 60 * 1000,
				).toISOString();

				return {
					changes: records.map(toUpsert),
					hasMore: false,
					nextState: {
						phase: "delta" as const,
						cursorTimestamp: overlapTs,
						cursorId: "",
					},
				};
			}

			const last = records[records.length - 1];
			return {
				changes: records.map(toUpsert),
				hasMore: true,
				nextState: {
					phase: "backfill" as const,
					cursorTimestamp: last.created_at,
					cursorId: last.id,
					backfillStartedAt,
				},
			};
		}

		// Delta phase: fetch only records modified since the cursor.
		// Same keyset pattern but on updated_at instead of created_at.
		const deltaState = state as Extract<SyncState, { phase: "delta" }>;
		const params = new URLSearchParams({
			limit: String(BATCH_SIZE),
			order_by: "updated_at,id",
			updated_after: deltaState.cursorTimestamp,
			updated_after_id: deltaState.cursorId,
		});

		const response = await fetch(
			`https://api.example.com/contacts?${params}`,
			{ headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } },
		);
		const data = await response.json();
		const records: Array<{
			id: string;
			name: string;
			updated_at: string;
		}> = data.contacts;
		const done = records.length < BATCH_SIZE;

		// Consistency buffer: never advance the cursor closer than 15s to "now".
		// In incremental mode the cursor never resets, so if we advance past a record
		// that hasn't been indexed yet, it's lost permanently.
		const bufferTs = new Date(
			Date.now() - CONSISTENCY_BUFFER_MS,
		).toISOString();
		const last = records[records.length - 1];

		let nextCursorTs: string;
		let nextCursorId: string;
		if (done) {
			// Caught up — cap the cursor at the buffer boundary
			nextCursorTs =
				last && last.updated_at < bufferTs
					? last.updated_at
					: (deltaState.cursorTimestamp < bufferTs
							? bufferTs
							: deltaState.cursorTimestamp);
			nextCursorId = last?.id ?? deltaState.cursorId;
		} else {
			// More pages — advance cursor to last record on this page
			nextCursorTs = last.updated_at;
			nextCursorId = last.id;
		}

		return {
			changes: records.map(toUpsert),
			hasMore: !done,
			nextState: {
				phase: "delta" as const,
				cursorTimestamp: nextCursorTs,
				cursorId: nextCursorId,
			},
		};
	},
});

function toUpsert(record: { id: string; name: string }) {
	return {
		type: "upsert" as const,
		key: record.id,
		properties: {
			Name: Builder.title(record.name),
			"Contact ID": Builder.richText(record.id),
		},
	};
}
