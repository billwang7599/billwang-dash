#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "dash");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const BASE_URL = (process.env.DASH_URL || "https://dash.billwang.dev").replace(/\/+$/, "");

function fail(message) {
    console.error(`dash: ${message}`);
    process.exit(1);
}

function token() {
    if (process.env.DASH_TOKEN) return process.env.DASH_TOKEN;
    try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf8")).token;
    } catch {
        fail("not logged in. Make a token in dash Settings, then run: dash login <token>");
    }
}

async function call(path, body) {
    let res;
    try {
        res = await fetch(`${BASE_URL}/cli${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (err) {
        fail(`can't reach ${BASE_URL}: ${err.cause?.message ?? err.message}`);
    }
    const data = await res.json().catch(() => null);
    if (res.status === 401) fail("token rejected. Make a new one in dash Settings, then run: dash login <token>");
    if (!res.ok) fail(data?.error ?? `HTTP ${res.status}`);
    return data;
}

const print = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value));

async function help(name) {
    const tools = await call("/tools");
    if (!name) {
        console.log("usage: dash <tool> ['{json args}'] | dash help <tool> | dash login <token>");
        for (const t of tools) console.log(`${t.name} (${t.kind}): ${t.description.split(/(?<=\.)\s/)[0]}`);
        return;
    }
    const t = tools.find((x) => x.name === name);
    if (!t) fail(`no tool named ${name}. Run: dash help`);
    console.log(`${t.name} (${t.kind})\n${t.description}\nargs: ${JSON.stringify(t.args)}`);
}

function login(value) {
    if (!value) fail("usage: dash login <token>");
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ token: value }) + "\n", { mode: 0o600 });
    chmodSync(CONFIG_FILE, 0o600);
    console.log(`saved to ${CONFIG_FILE}`);
}

const [command, arg] = process.argv.slice(2);
if (!command || command === "help" || command === "--help" || command === "-h") {
    await help(arg);
} else if (command === "login") {
    login(arg);
} else {
    let args = {};
    if (arg !== undefined) {
        try {
            args = JSON.parse(arg);
        } catch {
            fail(`args must be JSON, e.g. dash ${command} '{"id":"..."}'`);
        }
    }
    print(await call(`/tools/${encodeURIComponent(command)}`, args));
}
