/*
 * Заглушки Discord (@webpack/common) для локального стенда devtest.
 * «Discord» здесь — родительская страница: она пересылает сообщения между
 * участниками (iframe) с задержкой и, по желанию, теряет часть из них.
 */
const params = new URLSearchParams(location.search);
export const ME = params.get("me");
const VOICE = "vc1";
const DM = "dm1";

let msgSeq = 1;
export const fluxHandlers = [];

window.addEventListener("message", e => {
    const m = e.data;
    if (m?.kind !== "deliver") return;
    for (const fn of fluxHandlers) fn({ message: { id: m.id, content: m.content, channel_id: m.channel, author: { id: m.from } } });
});

function send(channel, content) {
    const id = `${Date.now()}${msgSeq++}`.padEnd(18, "0");
    parent.postMessage({ kind: "send", from: ME, channel, content, id }, "*");
    return id;
}

export const RestAPI = {
    async post(req) {
        if (req.url === "/users/@me/channels") return { body: { id: DM } };
        const m = /^\/channels\/(\w+)\/messages$/.exec(req.url);
        if (m) return { body: { id: send(m[1], req.body.content) } };
        throw Object.assign(new Error("unknown url " + req.url), { status: 404 });
    }
};
export const MessageActions = {
    sendMessage(channel, msg) { send(channel, msg.content); return Promise.resolve(); },
    deleteMessage() { return Promise.resolve(); }
};
export const ChannelStore = {
    getChannel: id => ({ id, guild_id: null, getGuildId: () => null }),
    getDMFromUserId: () => DM
};
export const SelectedChannelStore = { getVoiceChannelId: () => VOICE };
export const UserStore = {
    getCurrentUser: () => ({ id: ME, username: ME }),
    getUser: id => ({ id, username: id })
};
export const ApplicationStreamingStore = { getStreamForUser: () => null, getAllActiveStreams: () => [] };
export const Toasts = { show: t => parent.postMessage({ kind: "log", text: `[${ME.slice(0, 3)}] toast: ${t.text}` }, "*") };
export const FluxDispatcher = { dispatch() { } };
