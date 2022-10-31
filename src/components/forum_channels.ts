import * as Discord from "discord.js";
import { strict as assert } from "assert";
import { critical_error, fetch_all_threads_archive_count, fetch_forum_channel, get_tag, M,
         SelfClearingSet } from "../utils";
import { colors, cpp_help_id, c_help_id, forum_help_channels, is_forum_help_thread, MINUTE,
         wheatley_id } from "../common";
import { decode_snowflake } from "./snowflake"; // todo: eliminate decode_snowflake

let client: Discord.Client;

let cpp_help: Discord.ForumChannel;
let c_help: Discord.ForumChannel;

// TODO: Take into account thread's inactivity setting

const solved_archive_timeout = 12 * 60 * MINUTE; // 12 hours for a solved thread that's reopened
const inactive_timeout = 12 * 60 * MINUTE; // 12 hours for a thread that's seen no activity, archive
const resolution_timeout = 12 * 60 * MINUTE; // after another 12 hours, open -> solved

const cleanup_limit = 400; // how many messages back in the archive to go

// if a channel hasn't had activity in 2 hours prompt to ask a better question ?
const message_inactivity_threshold = 2 * 60 * MINUTE;
// if the op says thank you remind them to close the thread after 15 minutes
const thank_you_timeout = 5 * MINUTE;

const thank_you_re = /\b(thanks|thank\s*you|ty|cheers|figured? it out(?!\?))\b/gi;


/*
 * Forum thread handling:
 * - Thread create message
 * - Forum cleanup
 * - Tag cleanup
 * - Has your question been solved prompt
 */

// TODO: Improve initial message, make it more friendly to the eye
// reduce time of initial message

// don't prompt twice within 2 hours - that's just annoying
const possibly_resolved = new SelfClearingSet<string>(2 * 60 * MINUTE);
const timeout_map = new Map<string, NodeJS.Timeout>();

function create_embed(title: string | undefined, color: number, msg: string) {
    const embed = new Discord.EmbedBuilder()
        .setColor(color)
        .setDescription(msg);
    if(title) {
        embed.setTitle(title);
    }
    return embed;
}

async function prompt_close(thread: Discord.ThreadChannel) {
    timeout_map.delete(thread.id);
    const forum = thread.parent;
    assert(forum instanceof Discord.ForumChannel);
    const solved_tag = get_tag(forum, "Solved").id;
    if(thread.appliedTags.includes(solved_tag)) {
        // no action needed - has been marked !solved
    } else {
        M.log("Sending !solved prompt timeout for thread", [thread.id, thread.name]);
        thread.send(`<@${thread.ownerId}> Has your question been resolved? If so, run \`!solved\` :)`);
    }
}

async function on_message(message: Discord.Message) {
    try {
        if(message.author.bot) return; // Ignore bots
        if(message.type == Discord.MessageType.ThreadCreated) return; // ignore message create messages
        if(message.id == message.channelId) return; // forum start message
        const channel = message.channel;
        if(channel instanceof Discord.ThreadChannel) {
            const thread = channel;
            if(is_forum_help_thread(thread)) {
                const forum = thread.parent;
                assert(forum instanceof Discord.ForumChannel);
                const solved_tag = get_tag(forum, "Solved").id;
                if(!thread.appliedTags.includes(solved_tag)) {
                    // if this is an unsolved help forum post... check if we need to start or restart a timeout
                    const op = thread.ownerId;
                    assert(op, "Assumption: Can only happen if uncached.");
                    if(message.author.id == op) {
                        const content = message.content.toLowerCase();
                        if(content.match(thank_you_re) != null) {
                            if(!possibly_resolved.has(thread.id)) {
                                M.debug("Setting !solved prompt timeout for thread", [thread.id, thread.name],
                                        "based off of", [content]);
                                timeout_map.set(thread.id, setTimeout(async () => {
                                    await prompt_close(thread);
                                }, thank_you_timeout));
                                possibly_resolved.insert(thread.id);
                                return;
                            }
                        }
                    }
                    // if we reach here, it's a non-thank message
                    // might need to restart the timeout
                    if(timeout_map.has(thread.id)) {
                        M.debug("Restarting !solved prompt timeout for thread", [thread.id, thread.name]);
                        clearTimeout(timeout_map.get(thread.id));
                        timeout_map.set(thread.id, setTimeout(async () => {
                            await prompt_close(thread);
                        }, thank_you_timeout));
                    }
                }
            }
        }
    } catch(e) {
        critical_error(e);
    }
}

async function on_thread_create(thread: Discord.ThreadChannel) {
    if(thread.ownerId == wheatley_id) { // wheatley threads are either modlogs or thread help threads
        return;
    }
    if(is_forum_help_thread(thread)) { // TODO
        // Somehow it's a problem to send this message too quickly:
        //  Critical error occurred: unhandledRejection DiscordAPIError: Cannot message this thread until after the post
        //  author has sent an initial message. [object Promise]
        // TODO: revisit once api kinks are worked out
        const forum = thread.parent;
        assert(forum instanceof Discord.ForumChannel);
        const open_tag = get_tag(forum, "Open").id;
        await thread.setAppliedTags([open_tag].concat(thread.appliedTags.slice(0, 4)));
        setTimeout(async () => {
            await thread.send({
                embeds: [create_embed(undefined, colors.red, "When your question is answered use **`!solved`** to mark "
                    + "the question as resolved.\n\nRemember to ask __specific questions__, provide __necessary "
                    + "details__, and reduce your question to its __simplest form__. For tips on how to ask a good "
                    + "question run `!howto ask`.")]
            });
        }, 1000);
    }
}

async function check_thread_activity(thread: Discord.ThreadChannel, open_tag: string, solved_tag: string) {
    assert(thread.lastMessageId);
    const now = Date.now();
    const last_message = decode_snowflake(thread.lastMessageId);
    if(thread.appliedTags.includes(solved_tag) && !thread.archived && now - last_message >= solved_archive_timeout) {
        M.log("Archiving solved channel", [thread.id, thread.name]);
        thread.setArchived(true);
    } else if(!thread.appliedTags.includes(solved_tag) && !thread.archived && now - last_message >= inactive_timeout) {
        M.log("Archiving inactive channel", [thread.id, thread.name]);
        await thread.send({
            embeds: [
                create_embed(undefined, colors.color, "This question thread is being automatically closed."
                    + " If your question is not answered feel free to bump the post or re-ask. Take a look"
                    + " at `!howto ask` for tips on improving your question.")
            ]
        });
        await thread.setArchived(true);
    } else if(!thread.appliedTags.includes(solved_tag) && thread.archived && now - last_message >= resolution_timeout) {
        M.log("Resolving channel", [thread.id, thread.name]);
        await thread.setArchived(false);
        await thread.send({
            embeds: [
                create_embed(undefined, colors.color, "This question thread is being automatically marked as solved.")
            ]
        });
        await thread.setAppliedTags([solved_tag].concat(thread.appliedTags.filter(t => t != open_tag)));
        await thread.setArchived(true);
    }
}

async function misc_checks(thread: Discord.ThreadChannel, open_tag: string, solved_tag: string) {
    // Ensure there is exactly one solved/open tag
    const solved_open_count = thread.appliedTags.filter(tag => [solved_tag, open_tag].includes(tag)).length;
    if(solved_open_count != 1) {
        M.log("Setting thread with", solved_open_count, "solved/open tags to have one such tag",
              [thread.id, thread.name]);
        const {archived} = thread;
        if(archived) await thread.setArchived(false);
        const tag = thread.appliedTags.includes(solved_tag) ? solved_tag : open_tag;
        await thread.setAppliedTags(
            [tag].concat(thread.appliedTags.filter(tag => ![solved_tag, open_tag].includes(tag)).slice(0, 4))
        );
        if(archived) await thread.setArchived(true);
    }
    // Ensure the solved/open tag is at the beginning
    // We know thread.appliedTags.length >= 1 by now
    else if(!(thread.appliedTags[0] == solved_tag || thread.appliedTags[0] == open_tag)) {
        M.log("Moving solved/open tag to the beginning", [thread.id, thread.name]);
        const {archived} = thread;
        const tag = thread.appliedTags.includes(solved_tag) ? solved_tag : open_tag;
        if(archived) await thread.setArchived(false);
        await thread.setAppliedTags(
            [tag].concat(thread.appliedTags.filter(tag => ![solved_tag, open_tag].includes(tag)))
        );
        if(archived) await thread.setArchived(true);
    }
    // If the thread name starts with [SOLVED], remove it
    if(thread.name.startsWith("[SOLVED]")) {
        M.log("Removing \"[SOLVED]\" from forum thread name", [thread.id, thread.name]);
        const {archived} = thread;
        if(archived) await thread.setArchived(false);
        await thread.setName(thread.name.slice("[SOLVED]".length).trim());
        if(archived) await thread.setArchived(true);
    }
}

async function forum_cleanup() {
    M.info("Running forum cleanup");
    // Routinely archive threads
    // Ensure no thread has both the solved and open tag?
    for(const forum of [cpp_help, c_help]) {
        const open_tag = get_tag(forum, "Open").id;
        const solved_tag = get_tag(forum, "Solved").id;
        const threads = await fetch_all_threads_archive_count(forum, cleanup_limit);
        M.info("--- Cleaning up", threads.size, "threads ---");
        for(const [_, thread] of threads) {
            assert(thread.parentId);
            if(forum_help_channels.has(thread.parentId)) {
                await misc_checks(thread, open_tag, solved_tag);
                await check_thread_activity(thread, open_tag, solved_tag);
            }
        }
    }
    M.info("FINISHED FORUM CLEANUP");
}

async function on_ready() {
    try {
        cpp_help = await fetch_forum_channel(cpp_help_id);
        c_help = await fetch_forum_channel(c_help_id);
        client.on("messageCreate", on_message);
        client.on("threadCreate", on_thread_create);
        //await get_initial_active();
        //await forum_cleanup();
        // every hour try to cleanup
        //setInterval(forum_cleanup, 60 * MINUTE);
    } catch(e) {
        critical_error(e);
    }
}

export async function setup_forum_channels(_client: Discord.Client) {
    try {
        client = _client;
        client.on("ready", on_ready);
    } catch(e) {
        critical_error(e);
    }
}