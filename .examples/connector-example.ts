/**
 * AI Connectors are only available in a private alpha.
 */

import { Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

/**
 * Example AI connector that syncs Discord chat messages and permissions into Notion.
 *
 * This AI connector:
 * 1. Fetches messages from Discord channels using cursor-based pagination
 * 2. Maps them into the chat archetype record format
 * 3. Syncs user and group permission mappings for access control
 */
worker.aiConnector("discordChat", {
	aiConnectorId: process.env.AI_CONNECTOR_ID!,
	archetype: "chat",
	schedule: "15m",

	execute: async (state) => {
		const cursor = state?.cursor;
		const { messages, nextCursor } = await fetchDiscordMessages(cursor);

		const records = messages.map((msg) => ({
			channel_id: msg.channel_id,
			channel_name: msg.channel_name,
			external_url: msg.permalink,
			chat_type: "channel",
			created_at: msg.created_at,
			updated_at: msg.updated_at,
			messages: msg.thread.map((m) => ({
				id: m.id,
				content: m.content,
				author: { id: m.author.id, username: m.author.username },
				timestamp: m.timestamp,
			})),
			permissions_space: msg.is_public,
			permissions_users: msg.member_ids.map((id) => ({
				id,
				type: "third_party_user",
			})),
			permissions_groups: [],
		}));

		return {
			records,
			hasMore: Boolean(nextCursor),
			nextState: nextCursor ? { cursor: nextCursor } : undefined,
		};
	},

	executePermissions: async (state) => {
		const after = state?.memberCursor;
		const { members, nextCursor } = await fetchDiscordMembers(after);

		return {
			userMappings: members.map((m) => ({
				notion_user_id: resolveNotionUser(m.email),
				third_party_user_id: m.user.id,
			})),
			groupMappings: members.map((m) => ({
				third_party_user_id: m.user.id,
				third_party_group_ids: m.roles,
			})),
			hasMore: Boolean(nextCursor),
			nextState: nextCursor ? { memberCursor: nextCursor } : undefined,
		};
	},
});

// TODO: Replace with actual Discord API calls using the Discord REST API.
// See https://discord.com/developers/docs/resources/channel#get-channel-messages
async function fetchDiscordMessages(_cursor: string | undefined): Promise<{
	messages: Array<{
		channel_id: string;
		channel_name: string;
		permalink: string;
		created_at: string;
		updated_at: string;
		is_public: boolean;
		member_ids: string[];
		thread: Array<{
			id: string;
			content: string;
			author: { id: string; username: string };
			timestamp: string;
		}>;
	}>;
	nextCursor: string | undefined;
}> {
	return { messages: [], nextCursor: undefined };
}

// TODO: Replace with actual Discord API calls to fetch guild members.
// See https://discord.com/developers/docs/resources/guild#list-guild-members
async function fetchDiscordMembers(_after: string | undefined): Promise<{
	members: Array<{
		email: string;
		user: { id: string };
		roles: string[];
	}>;
	nextCursor: string | undefined;
}> {
	return { members: [], nextCursor: undefined };
}

// TODO: Replace with actual user resolution logic, e.g. looking up Notion users
// by email via the Notion API or a pre-built mapping table.
function resolveNotionUser(_email: string): string {
	return "";
}
