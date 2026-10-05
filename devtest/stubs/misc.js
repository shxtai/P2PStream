// Заглушки @utils/Logger, @utils/types, @api/Settings для стенда devtest
export class Logger {
    constructor(name) { this.name = name; }
    out(level, args) {
        const text = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
        const me = new URLSearchParams(location.search).get("me").slice(0, 3);
        parent.postMessage({ kind: "log", text: `[${me}] ${this.name} ${level}: ${text}` }, "*");
    }
    info(...a) { this.out("info", a); }
    warn(...a) { this.out("WARN", a); }
    error(...a) { this.out("ERROR", a); }
    debug() { }
}

export const OptionType = { STRING: 0, NUMBER: 1, BIGINT: 2, BOOLEAN: 3, SELECT: 4, SLIDER: 5, COMPONENT: 6, CUSTOM: 7 };

export function definePluginSettings(def) {
    const store = {};
    for (const [k, v] of Object.entries(def)) {
        if ("default" in v) store[k] = v.default;
        else if (v.options) store[k] = (v.options.find(o => o.default) ?? v.options[0]).value;
    }
    return { store, def };
}
